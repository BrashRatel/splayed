import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { type CliIO, main } from "../src/cli/main.ts";
import { protectedTxids } from "../src/core/donors.ts";
import {
  archivePlan,
  classifySpender,
  identifySpender,
  isUnsettled,
  ownTransactions,
  plannedOutpoints,
  unsentReplacements,
} from "../src/core/plan_admin.ts";
import type { TxProgress } from "../src/core/execute.ts";
import type { ChainBackend, OutputObservation } from "../src/backends/types.ts";

const ID = "20261101T120000000-abc123";

function io(answer = true) {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const cli: CliIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: (q) => {
      questions.push(q);
      return answer;
    },
    env: {},
  };
  return { cli, out, err, questions, text: () => [...out, ...err].join("\n") };
}

/** A minimal plan folder: what the admin commands and donor rules read. */
async function writePlan(
  dataDir: string,
  id: string,
  txs: {
    chain: string;
    file: string;
    replaces?: unknown;
    inputs?: { txid: string; vout: number }[];
  }[],
  progress: Record<string, unknown> = {},
) {
  const dir = join(dataDir, "plans", id);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "plan.json"),
    JSON.stringify({ id, createdAt: "2026-11-01T12:00:00.000Z", transactions: txs }),
  );
  await Deno.writeTextFile(
    join(dir, "progress.json"),
    JSON.stringify({ version: 1, txs: progress }),
  );
  return dir;
}

const exists = async (p: string) => {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test("plans archive / unarchive keep the folder and move it between list sections", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const dir = await writePlan(dataDir, ID, [{ chain: "ecx", file: "ecx/001-aaaa.psbt" }]);
  const a = io();
  assertEquals(await main(["--data-dir", dataDir, "plans", "archive", ID], a.cli), 0);
  assert(await exists(join(dir, "plan.json")), "folder kept");
  assert(await exists(join(dir, "archived.json")));

  const list = io();
  assertEquals(await main(["--data-dir", dataDir, "plans"], list.cli), 0);
  assert(list.text().includes("Archived (1):"));
  assert(list.text().includes(`  ${ID}`));

  // Archiving twice is an error; unarchive brings it back.
  assertEquals(await main(["--data-dir", dataDir, "plans", "archive", ID], io().cli), 1);
  assertEquals(await main(["--data-dir", dataDir, "plans", "unarchive", ID], io().cli), 0);
  assertEquals(await exists(join(dir, "archived.json")), false);
  const again = io();
  await main(["--data-dir", dataDir, "plans"], again.cli);
  assertEquals(again.text().includes("Archived"), false);
});

Deno.test("plans delete: refused while a sent transaction isn't confirmed deep enough", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const dir = await writePlan(dataDir, ID, [{ chain: "ecx", file: "ecx/001-aaaa.psbt" }], {
    "ecx/001-aaaa.psbt": {
      broadcast: { status: "accepted", at: "x", backend: "b", attempts: 1 },
      confirmations: { depth: 12, at: "x" },
    },
  });
  const r = io();
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID, "--yes"], r.cli), 1);
  assert(r.text().includes("aren't confirmed yet"), r.text());
  assert(r.text().includes("12 of 50 confirmations"), r.text()); // ECX default is 50
  assertEquals(r.questions.length, 0, "refuses before asking");
  assert(await exists(dir));
});

Deno.test("plans delete: a fee-bumped original never settles, so it's kept", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  await writePlan(dataDir, ID, [{ chain: "xbt", file: "xbt/001-bbbb.psbt" }], {
    "xbt/001-bbbb.psbt": {
      broadcast: { status: "replaced", at: "x", backend: "b", attempts: 1 },
      replacedBy: { plan: `${ID}-bump1`, file: "xbt/001-cccc.psbt" },
    },
  });
  const r = io();
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID, "--yes"], r.cli), 1);
  assert(r.text().includes("replaced by plan"), r.text());
});

Deno.test("plans delete: asks first, notes what is lost, and deletes once confirmed deep", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const dir = await writePlan(dataDir, ID, [
    { chain: "ecx", file: "ecx/001-aaaa.psbt" },
    { chain: "xbt", file: "xbt/001-bbbb.psbt" },
  ], {
    "ecx/001-aaaa.psbt": {
      verified: { at: "x", txid: "aa".repeat(32), finalHex: "00", checks: [] },
      broadcast: { status: "accepted", at: "x", backend: "b", attempts: 1 },
      confirmations: { depth: 60, at: "x" },
    },
    // Refused by every backend and never seen: nothing to follow up.
    "xbt/001-bbbb.psbt": { broadcast: { status: "rejected", at: "x", backend: "b", attempts: 1 } },
  });
  const declined = io(false);
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID], declined.cli), 1);
  assertEquals(declined.questions.length, 1);
  assert(declined.text().includes("donors may stop qualifying"), declined.text());
  assert(await exists(dir), "kept after declining");

  const yes = io(true);
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID], yes.cli), 0);
  assertEquals(await exists(dir), false);
});

Deno.test("plans delete/archive refuse anything that isn't a plan id", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  // A plan-looking folder outside the plans directory must never be touched.
  const outside = await Deno.makeTempDir({ prefix: "splayed-outside-" });
  await Deno.writeTextFile(join(outside, "plan.json"), JSON.stringify({ transactions: [] }));
  for (const bad of [outside, "../outside", "a/b", ".hidden", ""]) {
    for (const action of ["delete", "archive"]) {
      const r = io();
      const code = await main(["--data-dir", dataDir, "plans", action, bad, "--yes"], r.cli);
      assert(code !== 0, `${action} ${bad}`);
    }
  }
  assert(await exists(join(outside, "plan.json")));
  // Unknown id.
  const r = io();
  assertEquals(
    await main(["--data-dir", dataDir, "plans", "delete", "nope-123", "--yes"], r.cli),
    1,
  );
  assert(r.text().includes('No plan "nope-123"'));
});

Deno.test("archived plans still count for the donor rules", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const txid = "ab".repeat(32);
  // Ungated and accepted: its outputs are XBT-only, which is what the donor rules look for.
  await writePlan(dataDir, ID, [{ chain: "xbt", file: "xbt/001-abab.psbt" }], {
    "xbt/001-abab.psbt": {
      verified: { at: "x", txid, finalHex: "00", checks: [] },
      broadcast: { status: "accepted", at: "x", backend: "b", attempts: 1 },
    },
  });
  const before = await protectedTxids(dataDir, "xbt");
  assertEquals([...before], [txid]);
  assertEquals(await main(["--data-dir", dataDir, "plans", "archive", ID], io().cli), 0);
  assertEquals(await protectedTxids(dataDir, "xbt"), before);
});

Deno.test("plannedOutpoints: which plans spend each coin, newest first, and whether one was sent", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const coin = (n: number) => ({ txid: String(n).repeat(64).slice(0, 64), vout: n });
  const key = (n: number) => `${coin(n).txid}:${n}`;
  const sent = (status: string, confirmations?: unknown) => ({
    broadcast: { status, at: "2026-11-01T12:00:00Z", backend: "b", attempts: 1 },
    ...(confirmations ? { confirmations } : {}),
  });
  assertEquals((await plannedOutpoints(dataDir)).size, 0, "no plans folder yet");
  const OLD = "20261101T120000000-aaaaaa";
  const NEW = "20261102T120000000-bbbbbb";
  const GONE = "20261103T120000000-cccccc";
  // Old plan: coin 1 on ECX (sent) and XBT (not); coin 2 rejected; coin 3 conflict but confirmed.
  await writePlan(dataDir, OLD, [
    { chain: "ecx", file: "ecx/001.psbt", inputs: [coin(1)] },
    { chain: "xbt", file: "xbt/001.psbt", inputs: [coin(1)] },
    { chain: "ecx", file: "ecx/002.psbt", inputs: [coin(2)] },
    { chain: "ecx", file: "ecx/003.psbt", inputs: [coin(3)] },
  ], {
    "ecx/001.psbt": sent("accepted"),
    "ecx/002.psbt": sent("rejected"),
    "ecx/003.psbt": sent("conflict", { depth: 3, at: "2026-11-01T13:00:00Z" }),
  });
  // Newer plan spends coin 1 and 4, nothing sent; archived plan spends coin 5.
  await writePlan(dataDir, NEW, [
    { chain: "ecx", file: "ecx/001.psbt", inputs: [coin(1), coin(4)] },
  ], { "ecx/001.psbt": sent("sending") });
  const gone = await writePlan(dataDir, GONE, [
    { chain: "ecx", file: "ecx/001.psbt", inputs: [coin(5)] },
  ]);
  await Deno.writeTextFile(join(gone, "archived.json"), JSON.stringify({ at: "x" }));
  await Deno.mkdir(join(dataDir, "plans", "not-a-plan"), { recursive: true });

  const planned = await plannedOutpoints(dataDir);
  assertEquals(planned.get(key(1)), [{ plan: NEW, sent: true }, { plan: OLD, sent: true }]);
  assertEquals(planned.get(key(2)), [{ plan: OLD, sent: false }]);
  assertEquals(planned.get(key(3)), [{ plan: OLD, sent: true }]);
  assertEquals(planned.get(key(4)), [{ plan: NEW, sent: true }]);
  assertEquals(planned.has(key(5)), false, "archived plans don't count");
  assertEquals(planned.size, 4);
});

Deno.test("unsentReplacements: written and unsent fee bumps per original; sent, refused or archived ones don't count", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const bump = (n: number, status?: string) =>
    writePlan(
      dataDir,
      `${ID}-bump${n}`,
      [{
        chain: "ecx",
        file: `ecx/001-b${n}.psbt`,
        replaces: { plan: ID, file: "ecx/001-aaaa.psbt", txid: "aa", fee: 1, feeRate: 1 },
      }],
      status
        ? {
          [`ecx/001-b${n}.psbt`]: { broadcast: { status, at: "x", backend: "b", attempts: 1 } },
        }
        : {},
    );
  await writePlan(dataDir, ID, [{ chain: "ecx", file: "ecx/001-aaaa.psbt" }]);
  assertEquals((await unsentReplacements(dataDir, ID)).size, 0);
  await bump(1); // written, never sent
  await bump(2, "unknown"); // a send whose result is unknown: may be out there
  await bump(3, "rejected");
  await bump(4, "accepted");
  const archived = await bump(5);
  await Deno.writeTextFile(join(archived, "archived.json"), "{}");
  const got = (await unsentReplacements(dataDir, ID)).get("ecx/001-aaaa.psbt");
  assertEquals(got?.map((u) => [u.plan, u.status]), [
    [`${ID}-bump1`, undefined],
    [`${ID}-bump2`, "unknown"],
  ]);
});

Deno.test("a split that left its block (depth 0 after track) can't be deleted; it still counts as sent", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const input = { txid: "ab".repeat(32), vout: 0 };
  await writePlan(dataDir, ID, [{ chain: "ecx", file: "ecx/001-aaaa.psbt", inputs: [input] }], {
    "ecx/001-aaaa.psbt": {
      broadcast: { status: "conflict", at: "x", backend: "b", attempts: 1 },
      confirmations: {
        depth: 0,
        at: "y",
        state: "conflict",
        previous: { depth: 60, at: "x", height: 100, blockHash: "11".repeat(32) },
      },
    },
  });
  const r = io();
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID, "--yes"], r.cli), 1);
  assert(r.text().includes("0 of 50 confirmations"), r.text());
  // It was in a block once, so the coin shows as sent in a plan (plannedOutpoints).
  assertEquals((await plannedOutpoints(dataDir)).get(`${input.txid}:0`), [{
    plan: ID,
    sent: true,
  }]);
});

const B = (status: string) => ({ status, at: "x", backend: "b", attempts: 1 });

Deno.test("isUnsettled: an older record with a stale depth doesn't settle an unclear or conflicting send", () => {
  const deep = { depth: 60, at: "x" };
  // Progress files from before 0.1.0-pre-alpha.2 kept the old depth after a reorg.
  for (const status of ["unknown", "sending", "conflict"]) {
    assertEquals(
      isUnsettled({ broadcast: B(status), confirmations: deep } as TxProgress, 50),
      true,
      status,
    );
  }
  assertEquals(
    isUnsettled({
      broadcast: B("accepted"),
      confirmations: { depth: 60, at: "x", state: "mempool" },
    } as TxProgress, 50),
    true,
  );
  assertEquals(
    isUnsettled({ broadcast: B("accepted"), confirmations: deep } as TxProgress, 50),
    false,
  );
  assertEquals(isUnsettled({ broadcast: B("rejected") } as TxProgress, 50), false);
  // Dropped from the mempool, never confirmed: still sent, still unsettled.
  assertEquals(
    isUnsettled({
      broadcast: B("accepted"),
      unmined: { state: "absent", at: "x" },
    } as TxProgress, 50),
    true,
  );
  // Superseded by another plan: settled once that plan's transaction is deep enough.
  const sup = (depth?: number) =>
    ({
      broadcast: B("superseded"),
      supersededBy: { plan: "P2", file: "f", txid: "cc".repeat(32), depth },
    }) as TxProgress;
  assertEquals(isUnsettled(sup(), 50), true);
  assertEquals(isUnsettled(sup(3), 50), true);
  assertEquals(isUnsettled(sup(50), 50), false);
});

Deno.test("plans delete: a stale depth from an older version doesn't let an unclear send be deleted", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  await writePlan(dataDir, ID, [{ chain: "ecx", file: "ecx/001-aaaa.psbt" }], {
    "ecx/001-aaaa.psbt": { broadcast: B("unknown"), confirmations: { depth: 60, at: "x" } },
  });
  const r = io();
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID, "--yes"], r.cli), 1);
  assert(r.text().includes("unknown, 60 of 50"), r.text());
});

Deno.test("plans delete: a fee bump that a plan's replacedBy points to is kept until that plan is archived", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const bumpId = `${ID}-bump1`;
  await writePlan(dataDir, ID, [{ chain: "ecx", file: "ecx/001-aaaa.psbt" }], {
    "ecx/001-aaaa.psbt": {
      broadcast: B("replaced"),
      replacedBy: { plan: bumpId, file: "ecx/001-bbbb.psbt", txid: "bb".repeat(32) },
    },
  });
  const bumpDir = await writePlan(dataDir, bumpId, [{
    chain: "ecx",
    file: "ecx/001-bbbb.psbt",
    replaces: { plan: ID, file: "ecx/001-aaaa.psbt", txid: "aa".repeat(32) },
  }], {
    "ecx/001-bbbb.psbt": { broadcast: B("accepted"), confirmations: { depth: 60, at: "x" } },
  });
  const r = io();
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", bumpId, "--yes"], r.cli), 1);
  assert(r.text().includes(`plan ${ID} (ecx/001-aaaa.psbt) points to`), r.text());
  assertEquals(r.questions.length, 0, "refuses before asking");
  assert(await exists(bumpDir));
  // Once the original's plan is archived, the bump plan can go.
  assertEquals(await main(["--data-dir", dataDir, "plans", "archive", ID], io().cli), 0);
  assertEquals(
    await main(["--data-dir", dataDir, "plans", "delete", bumpId, "--yes"], io().cli),
    0,
  );
  assertEquals(await exists(bumpDir), false);
});

Deno.test("classifySpender: own fee bumps (any hop), other plans (archived too), strangers", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const tx = (c: string) => c.repeat(32);
  const v = (txid: string) => ({ verified: { at: "x", txid, finalHex: "00", checks: [] } });
  const input = [{ txid: tx("01"), vout: 0 }];
  await writePlan(dataDir, ID, [{ chain: "ecx", file: "a.psbt", inputs: input }], {
    "a.psbt": v(tx("aa")),
  });
  await writePlan(dataDir, `${ID}-bump1`, [{
    chain: "ecx",
    file: "b.psbt",
    inputs: input,
    replaces: { plan: ID, file: "a.psbt", txid: tx("aa") },
  }], { "b.psbt": v(tx("bb")) });
  await writePlan(dataDir, `${ID}-bump1-bump1`, [{
    chain: "ecx",
    file: "c.psbt",
    inputs: input,
    replaces: { plan: `${ID}-bump1`, file: "b.psbt", txid: tx("bb") },
  }], { "c.psbt": v(tx("cc")) });
  const other = "20261101T130000000-def456";
  await writePlan(dataDir, other, [{ chain: "ecx", file: "d.psbt", inputs: input }], {
    "d.psbt": v(tx("dd")),
  });
  assertEquals(await main(["--data-dir", dataDir, "plans", "archive", other], io().cli), 0);
  const split = { plan: ID, file: "a.psbt", chain: "ecx" };
  const index = await ownTransactions(dataDir);
  // A bump of a bump: the split's own direct replacement is named.
  const viaC = await classifySpender(dataDir, split, tx("cc"), index);
  assertEquals(viaC.kind, "replacement");
  assert(viaC.kind === "replacement");
  assertEquals(viaC.link, {
    plan: `${ID}-bump1`,
    file: "b.psbt",
    txid: tx("bb"),
    input: input[0],
  });
  assertEquals((await classifySpender(dataDir, split, tx("bb"))).kind, "replacement");
  const own = await classifySpender(dataDir, split, tx("dd"), index);
  assertEquals(own.kind === "own" && own.spender.plan, other);
  assertEquals((await classifySpender(dataDir, split, tx("ee"), index)).kind, "unknown");
  // The split's own txid spending its own input is the split itself, never a stranger.
  assertEquals((await classifySpender(dataDir, split, tx("aa"), index)).kind, "self");
  assertEquals((await classifySpender(dataDir, split, undefined, index)).kind, "unknown");
  // Another chain's transaction with the same txid can't be this coin's spender.
  assertEquals(
    (await classifySpender(dataDir, { ...split, chain: "xbt" }, tx("dd"), index)).kind,
    "unknown",
  );
});

Deno.test("plannedOutpoints: a transaction superseded by another plan isn't counted as sent", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const input = { txid: "ab".repeat(32), vout: 0 };
  await writePlan(dataDir, ID, [{ chain: "ecx", file: "a.psbt", inputs: [input] }], {
    "a.psbt": {
      broadcast: B("superseded"),
      supersededBy: { plan: "P2", file: "f", txid: "cc".repeat(32), depth: 3 },
    },
  });
  assertEquals((await plannedOutpoints(dataDir)).get(`${input.txid}:0`), [{
    plan: ID,
    sent: false,
  }]);
});

Deno.test("identifySpender: without a named spender, this tool's transactions on the same coin are asked about by txid", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const tx = (c: string) => c.repeat(32);
  const v = (txid: string) => ({ verified: { at: "x", txid, finalHex: "00", checks: [] } });
  const coin = { txid: tx("01"), vout: 0 };
  // The other plan spends the coin as its SECOND input (a batch): still found.
  await writePlan(dataDir, ID, [{ chain: "ecx", file: "a.psbt", inputs: [coin] }], {
    "a.psbt": v(tx("aa")),
  });
  const other = "20261101T130000000-def456";
  await writePlan(dataDir, other, [{
    chain: "ecx",
    file: "d.psbt",
    inputs: [{ txid: tx("02"), vout: 1 }, coin],
  }], { "d.psbt": v(tx("dd")) });
  const asked: string[] = [];
  /** Node RPC with txindex: knows transactions by txid, never names a spender. */
  const rpcLike = (onChain: Set<string>) =>
    ({
      txStatus: (id: string) => {
        asked.push(id);
        return Promise.resolve(
          onChain.has(id) ? { state: "confirmed", height: 100, blockHash: tx("ff") } : {
            state: "absent",
          },
        );
      },
      observeOutput: () =>
        Promise.resolve({ state: "spent", spendDetailKnown: false } as OutputObservation),
    }) as unknown as ChainBackend;
  const split = { plan: ID, file: "a.psbt", chain: "ecx", inputs: [coin] };
  const found = await identifySpender(dataDir, split, undefined, rpcLike(new Set([tx("dd")])), 105);
  assertEquals(found.kind === "own" && found.spender.plan, other);
  assert(!asked.includes(tx("aa")), "the split itself is not a candidate");
  // Not on the chain: unknown, never a guess.
  assertEquals(
    (await identifySpender(dataDir, split, undefined, rpcLike(new Set()), 105)).kind,
    "unknown",
  );
  // Another chain's transactions are never candidates.
  assertEquals(
    (await identifySpender(
      dataDir,
      { ...split, chain: "xbt" },
      undefined,
      rpcLike(new Set([tx("dd")])),
      105,
    )).kind,
    "unknown",
  );
});

Deno.test("archiving a plan acknowledges its open alerts, and only those", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  await writePlan(dataDir, ID, [{ chain: "ecx", file: "a.psbt", inputs: [] }], {
    "a.psbt": {
      broadcast: B("accepted"),
      reorgs: [
        { at: "t1", kind: "conflict", detail: "x", resolved: "t2" },
        { at: "t3", kind: "evicted", detail: "y" },
      ],
    },
  });
  assertEquals(await archivePlan(dataDir, ID, new Date("2026-11-02T12:00:00.000Z")), 1);
  const p = JSON.parse(await Deno.readTextFile(join(dataDir, "plans", ID, "progress.json")));
  assertEquals(p.txs["a.psbt"].reorgs[0].acknowledged, undefined);
  assertEquals(p.txs["a.psbt"].reorgs[1].acknowledged, "2026-11-02T12:00:00.000Z");
});
