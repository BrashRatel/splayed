import { assert, assertEquals } from "./assert.ts";
import type { ChainBackend, OutputObservation, TxStatus } from "../src/backends/types.ts";
import {
  alertTitle,
  assessReorg,
  confirmationDepth,
  type Confirmations,
  DROP_GRACE_MS,
  nextConfirmations,
  nextUnmined,
  recordReorg,
  resolveReorgs,
  type SentContext,
  type TxProgress,
} from "../src/core/execute.ts";
import type { PlannedTx } from "../src/core/planner.ts";
import type { ScanResult } from "../src/core/scan.ts";
import { scanRegressions } from "../src/core/scan.ts";
import type { CoinRecord } from "../src/core/state.ts";

const TXID = "cc".repeat(32);
const planTx = { inputs: [{ txid: "aa".repeat(32), vout: 1 }] } as unknown as PlannedTx;
const seen = { depth: 7, at: "t", height: 100, blockHash: "11".repeat(32) };

/** A backend that answers only the calls confirmationDepth makes. */
function stub(
  status: TxStatus | undefined,
  output: OutputObservation,
): ChainBackend {
  return {
    txStatus: status ? () => Promise.resolve(status) : undefined,
    observeOutput: () => Promise.resolve(output),
    blockHash: (h: number) => Promise.resolve(h.toString(16).padStart(64, "0")),
  } as unknown as ChainBackend;
}
const unspent: OutputObservation = { state: "unspent", value: 1 };
const spentBy = (spendTxid?: string, spendHeight?: number, known = true): OutputObservation => ({
  state: "spent",
  spendTxid,
  spendHeight,
  spendDetailKnown: known,
});

Deno.test("depth: the transaction's own status wins over what spent its input", async () => {
  const confirmed = await confirmationDepth(
    stub({ state: "confirmed", height: 100, blockHash: "22".repeat(32) }, spentBy()),
    planTx,
    TXID,
    105,
  );
  assertEquals(confirmed, {
    state: "confirmed",
    depth: 6,
    height: 100,
    blockHash: "22".repeat(32),
  });
  assertEquals(
    (await confirmationDepth(stub({ state: "mempool" }, spentBy()), planTx, TXID, 105)).state,
    "mempool",
  );
});

Deno.test("depth: not on chain and not in the mempool, input unspent -> absent", async () => {
  assertEquals(
    (await confirmationDepth(stub({ state: "absent" }, unspent), planTx, TXID, 105)).state,
    "absent",
  );
});

Deno.test("depth: not on chain, input spent -> conflict, naming the spender when known", async () => {
  const other = "dd".repeat(32);
  assertEquals(
    await confirmationDepth(stub({ state: "absent" }, spentBy(other, 90)), planTx, TXID, 105),
    { state: "conflict", by: other },
  );
  // Node RPC can't say who spent it, but it is still a conflict.
  assertEquals(
    await confirmationDepth(
      stub({ state: "absent" }, spentBy(undefined, undefined, false)),
      planTx,
      TXID,
      105,
    ),
    { state: "conflict", by: undefined },
  );
});

Deno.test("depth: without txStatus it falls back to the spend, with the block hash recorded", async () => {
  const d = await confirmationDepth(stub(undefined, spentBy(TXID, 100)), planTx, TXID, 105);
  assertEquals(d.state, "confirmed");
  assertEquals(d.depth, 6);
  assertEquals(d.blockHash, (100).toString(16).padStart(64, "0"));
  assertEquals(
    (await confirmationDepth(stub(undefined, spentBy(TXID)), planTx, TXID, 105)).state,
    "mempool",
  );
});

Deno.test("depth: a backend that can't report spend details says unknown, not mempool", async () => {
  // Node RPC with an unspent-less output and no txindex used to read as "mempool" forever.
  assertEquals(
    (await confirmationDepth(
      stub(undefined, spentBy(undefined, undefined, false)),
      planTx,
      TXID,
      105,
    ))
      .state,
    "unknown",
  );
  assertEquals(
    (await confirmationDepth(stub({ state: "unknown" }, { state: "gone" }), planTx, TXID, 105))
      .state,
    "unknown",
  );
});

/** A backend whose outputs answer by outpoint. */
function stubBy(status: TxStatus, outputs: Record<string, OutputObservation>): ChainBackend {
  return {
    txStatus: () => Promise.resolve(status),
    observeOutput: (txid: string, vout: number) => Promise.resolve(outputs[`${txid}:${vout}`]),
  } as unknown as ChainBackend;
}
const twoInputs = {
  inputs: [{ txid: "aa".repeat(32), vout: 1 }, { txid: "bb".repeat(32), vout: 0 }],
} as unknown as PlannedTx;

Deno.test("depth: absent only when every input was seen unspent", async () => {
  const a = `${"aa".repeat(32)}:1`;
  const b = `${"bb".repeat(32)}:0`;
  const other = "dd".repeat(32);
  const depth = (o: Record<string, OutputObservation>, st: TxStatus = { state: "absent" }) =>
    confirmationDepth(stubBy(st, o), twoInputs, TXID, 105);
  assertEquals((await depth({ [a]: unspent, [b]: unspent })).state, "absent");
  // The second input went elsewhere: a conflict, not a drop.
  assertEquals(await depth({ [a]: unspent, [b]: spentBy(other, 100) }), {
    state: "conflict",
    by: other,
  });
  // The backend can't place the second input (its transaction isn't found, or spent/missing
  // can't be told apart): nothing can be said.
  assertEquals((await depth({ [a]: unspent, [b]: { state: "absent" } })).state, "unknown");
  assertEquals((await depth({ [a]: unspent, [b]: { state: "gone" } })).state, "unknown");
});

Deno.test("depth: an input whose own transaction can't be found is unknown, never absent or conflict", async () => {
  // Electrum or RPC with txindex: the transaction is not found, nor is its input's. Used to be
  // "conflict" (with txStatus) or "absent" (without), which would read as a drop.
  for (const st of [{ state: "absent" }, { state: "unknown" }] as TxStatus[]) {
    assertEquals(
      (await confirmationDepth(stub(st, { state: "absent" }), planTx, TXID, 105)).state,
      "unknown",
      st.state,
    );
  }
  assertEquals(
    (await confirmationDepth(stub(undefined, { state: "absent" }), planTx, TXID, 105)).state,
    "unknown",
  );
  // Node RPC without txindex: not in its mempool and the input unspent in its UTXO set is a real
  // absence (it can't be in a block while its input is unspent).
  assertEquals(
    (await confirmationDepth(stub({ state: "unknown" }, unspent), planTx, TXID, 105)).state,
    "absent",
  );
});

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const sentAgo = (minutes: number, extra: Partial<SentContext> = {}): SentContext => ({
  status: "accepted",
  sentAt: new Date(NOW - minutes * 60_000).toISOString(),
  nowMs: NOW,
  ...extra,
});

Deno.test("dropped: a sent split never in a block and now absent is reported, with what to do", () => {
  const a = assessReorg("ecx", undefined, { state: "absent" }, sentAgo(60));
  assertEquals(a?.kind, "evicted");
  assertEquals(alertTitle("evicted"), "DROPPED");
  assert(a!.detail.includes("accepted by the server (sent 2026-11-02 11:00 UTC)"), a!.detail);
  assert(a!.detail.includes("mempool minimum") && a!.detail.includes("mempool expiry"));
  assert(a!.detail.includes("do NOT spend the BTC copy"));
  assert(a!.detail.includes("`splayed broadcast`") && a!.detail.includes("`splayed bump`"));
  // Seen in the mempool before: says when.
  const seenThere = assessReorg(
    "ecx",
    undefined,
    { state: "absent" },
    sentAgo(60, { lastInMempool: "2026-11-02T11:30:00.000Z" }),
  );
  assert(seenThere!.detail.includes("last seen 2026-11-02 11:30 UTC"), seenThere!.detail);
  // A send whose result was unknown: it may never have arrived.
  const unknown = assessReorg("ecx", undefined, { state: "absent" }, {
    ...sentAgo(60),
    status: "unknown",
  });
  assert(unknown!.detail.includes("never arrived, or it was dropped"), unknown!.detail);
  // Not sent (no context), still in the mempool, unknown or conflicting: no DROPPED.
  assertEquals(assessReorg("ecx", undefined, { state: "absent" }), undefined);
  assertEquals(assessReorg("ecx", undefined, { state: "mempool" }, sentAgo(60)), undefined);
  assertEquals(assessReorg("ecx", undefined, { state: "unknown" }, sentAgo(60)), undefined);
  assertEquals(
    assessReorg("ecx", undefined, { state: "conflict" }, sentAgo(60))?.kind,
    "conflict",
  );
  // A split that was in a block is a reorg, not a drop from the mempool.
  assertEquals(assessReorg("ecx", seen, { state: "absent" }, sentAgo(60))?.kind, "dropped");
});

Deno.test("dropped: just sent and never seen in a mempool gets a grace period; once seen, none", () => {
  const minutes = DROP_GRACE_MS / 60_000;
  assertEquals(assessReorg("ecx", undefined, { state: "absent" }, sentAgo(1)), undefined);
  assertEquals(
    assessReorg("ecx", undefined, { state: "absent" }, sentAgo(minutes + 1))?.kind,
    "evicted",
  );
  assertEquals(
    assessReorg(
      "ecx",
      undefined,
      { state: "absent" },
      sentAgo(1, { lastInMempool: new Date(NOW - 30_000).toISOString() }),
    )?.kind,
    "evicted",
  );
});

Deno.test("unmined record: mempool sightings kept, absence recorded, lookups that fail keep it", () => {
  const m = nextUnmined(undefined, { state: "mempool" }, "t1")!;
  assertEquals(m, { state: "mempool", at: "t1", lastInMempool: "t1" });
  const gone = nextUnmined(m, { state: "absent" }, "t2")!;
  assertEquals(gone, { state: "absent", at: "t2", lastInMempool: "t1" });
  assertEquals(nextUnmined(gone, { state: "unknown" }, "t3"), gone);
  assertEquals(nextUnmined(gone, { state: "conflict" }, "t3"), gone);
  assertEquals(nextUnmined(gone, { state: "confirmed", depth: 1 }, "t4"), undefined);
});

Deno.test("reorg: nothing to say about a split that was never seen confirmed", () => {
  assertEquals(assessReorg("ecx", undefined, { state: "mempool" }), undefined);
  assertEquals(assessReorg("ecx", undefined, { state: "absent" }), undefined);
  assertEquals(
    assessReorg("ecx", undefined, { state: "confirmed", depth: 1, blockHash: "11".repeat(32) }),
    undefined,
  );
});

Deno.test("reorg: still confirmed in the same block is quiet; a different block is reported", () => {
  const same = { state: "confirmed", depth: 9, height: 100, blockHash: seen.blockHash } as const;
  assertEquals(assessReorg("ecx", seen, same), undefined);
  const moved = assessReorg("ecx", seen, {
    state: "confirmed",
    depth: 2,
    height: 105,
    blockHash: "33".repeat(32),
  });
  assertEquals(moved?.kind, "moved");
  assert(moved!.detail.includes("block 105 (…33333333)"), moved!.detail);
});

Deno.test("reorg: real block hashes (leading zeros) are told apart by height and their last digits", () => {
  const a = "0".repeat(19) + "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5";
  const b = "0".repeat(19) + "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5";
  const moved = assessReorg("ecx", { depth: 3, at: "t", height: 100, blockHash: a }, {
    state: "confirmed",
    depth: 1,
    height: 100,
    blockHash: b,
  });
  // The first 12 digits were the same zeros for both blocks; the last 8 differ.
  assert(moved!.detail.includes(`block 100 (…${a.slice(-8)})`), moved!.detail);
  assert(moved!.detail.includes(`block 100 (…${b.slice(-8)})`), moved!.detail);
  // The chain and REORG are said once, by whoever shows the alert, not inside the detail.
  assert(!moved!.detail.includes("REORG") && !moved!.detail.startsWith("ECX"), moved!.detail);
  assertEquals(alertTitle("moved"), "REORG");
  assertEquals(alertTitle("conflict"), "CONFLICT");
});

Deno.test("reorg: a confirmed split that is back in the mempool or gone is reported", () => {
  assertEquals(assessReorg("xbt", seen, { state: "mempool" })?.kind, "unconfirmed");
  const dropped = assessReorg("xbt", seen, { state: "absent" });
  assertEquals(dropped?.kind, "dropped");
  assert(dropped!.detail.includes("Do NOT spend the BTC copy"));
  assertEquals(assessReorg("xbt", seen, { state: "unknown" }), undefined);
});

Deno.test("reorg: a conflict is always reported, with or without a prior confirmation", () => {
  const by = "ee".repeat(32);
  for (const prev of [undefined, seen]) {
    const a = assessReorg("ecx", prev, { state: "conflict", by });
    assertEquals(a?.kind, "conflict");
    assert(a!.detail.includes(by));
  }
  assert(assessReorg("ecx", seen, { state: "conflict" })!.detail.includes("another transaction"));
});

Deno.test("track record: depth 0 once out of a block, the last block kept; unknown keeps it", () => {
  // Never in a block: nothing recorded (plans delete and the planned-coins view rely on that).
  assertEquals(nextConfirmations(undefined, { state: "mempool" }, "t1"), undefined);
  assertEquals(nextConfirmations(undefined, { state: "conflict" }, "t1"), undefined);
  const inBlock = nextConfirmations(undefined, {
    state: "confirmed",
    depth: 2,
    height: 100,
    blockHash: seen.blockHash,
  }, "t1")!;
  assertEquals(inBlock, { depth: 2, at: "t1", height: 100, blockHash: seen.blockHash });
  const back = nextConfirmations(inBlock, { state: "mempool" }, "t2")!;
  assertEquals(back, { depth: 0, at: "t2", state: "mempool", previous: inBlock });
  // Still out of a block later: the block it was last in stays, not the depth-0 record.
  const gone = nextConfirmations(back, { state: "absent" }, "t3")!;
  assertEquals(gone.depth, 0);
  assertEquals(gone.state, "absent");
  assertEquals(gone.previous, inBlock);
  assertEquals(nextConfirmations(gone, { state: "unknown" }, "t4"), gone);
  // In a block again: a fresh record.
  assertEquals(
    nextConfirmations(gone, { state: "confirmed", depth: 1, height: 103, blockHash: "44" }, "t5"),
    { depth: 1, at: "t5", height: 103, blockHash: "44" },
  );
});

Deno.test("reorg: the alert repeats while the split is out of a block, and follows it further", () => {
  const back: Confirmations = { depth: 0, at: "t2", state: "mempool", previous: seen };
  const again = assessReorg("xbt", back, { state: "mempool" });
  assertEquals(again?.kind, "unconfirmed");
  assert(again!.detail.includes("7 deep"), again!.detail);
  // Back in the mempool, then gone: still reported as dropped (it was confirmed once).
  assertEquals(assessReorg("xbt", back, { state: "absent" })?.kind, "dropped");
  // Confirmed again in another block after being out: that is the recovery, not a new alert.
  assertEquals(
    assessReorg("xbt", back, { state: "confirmed", depth: 1, height: 103, blockHash: "55" }),
    undefined,
  );
});

Deno.test("reorg records: no duplicates while open; resolved once deep again; a new one after", () => {
  const p: TxProgress = {};
  const alert = { kind: "unconfirmed" as const, detail: "x" };
  recordReorg(p, alert, "t1");
  recordReorg(p, alert, "t2");
  assertEquals(p.reorgs?.length, 1);
  resolveReorgs(p, "t3");
  assertEquals(p.reorgs![0].resolved, "t3");
  resolveReorgs(p, "t4"); // already resolved: kept as it was
  assertEquals(p.reorgs![0].resolved, "t3");
  recordReorg(p, alert, "t5"); // the same thing happening again is a new record
  assertEquals(p.reorgs!.map((r) => r.resolved), ["t3", undefined]);
});

// ---- scan-to-scan regressions ----

const coin = (ecx: OutputObservation): CoinRecord => ({
  txid: "aa".repeat(32),
  vout: 0,
  value: 1,
  scriptPubKey: "",
  observations: { btc: unspent, xbt: unspent, ecx },
});
const scan = (c: CoinRecord): ScanResult => ({
  version: 1,
  scannedAt: "",
  profile: "x",
  tips: {},
  backends: {},
  addressesRevealed: {},
  warnings: [],
  coins: [c],
});

Deno.test("scan regressions: a spend that disappears is flagged; normal progress is not", () => {
  const spent = coin(spentBy("dd".repeat(32), 100));
  assertEquals(scanRegressions(undefined, scan(spent)), []);
  assertEquals(scanRegressions(scan(coin(unspent)), scan(spent)), []); // unspent -> spent: normal
  assertEquals(scanRegressions(scan(spent), scan(spent)), []);
  const lost = scanRegressions(scan(spent), scan(coin(unspent)));
  assertEquals(lost.length, 1);
  assert(lost[0].includes("REORG?") && lost[0].includes("ECX"));
});

Deno.test("scan regressions: a spend replaced by a different transaction is flagged", () => {
  const a = scan(coin(spentBy("dd".repeat(32), 100)));
  const b = scan(coin(spentBy("ee".repeat(32), 101)));
  const warnings = scanRegressions(a, b);
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("replaced or reorged"));
  // A backend that stopped reporting the spender is not a replacement.
  assertEquals(scanRegressions(a, scan(coin(spentBy(undefined, undefined, false)))), []);
});

Deno.test("conflict: no stranger is implied when the backend can't name the spender", () => {
  const a = assessReorg("ecx", undefined, { state: "conflict" })!;
  assert(a.detail.includes("this backend can't say which"), a.detail);
  assert(a.detail.includes("node RPC without txindex"), a.detail);
  assert(!a.detail.includes("not one of this tool's plans"), a.detail);
  // Causes in order: another wallet, a replayed BTC spend, and only then a compromised key.
  const order = ["another wallet or tool", "replayed onto ECX", "the key may be compromised"]
    .map((x) => a.detail.indexOf(x));
  assert(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), a.detail);
});
