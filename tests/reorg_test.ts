import { assert, assertEquals } from "./assert.ts";
import type { ChainBackend, OutputObservation, TxStatus } from "../src/backends/types.ts";
import { assessReorg, confirmationDepth } from "../src/core/execute.ts";
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
  assert(moved!.detail.includes("REORG") && moved!.detail.includes("height 105"));
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
