import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { EsploraBackend } from "../src/backends/esplora.ts";
import { gateProblems, type Progress } from "../src/core/execute.ts";
import type { Plan, PlannedTx } from "../src/core/planner.ts";
import { fakeChain, FakeEsploraTransport } from "./fakes.ts";

const COIN = { txid: "c0".repeat(32), vout: 0 };
const T0 = "a0".repeat(32); // the BTC split as first sent
const T1 = "a1".repeat(32); // its fee bump
const T2 = "a2".repeat(32); // a bump of the bump

const tx = (chain: string, file: string, more: Partial<PlannedTx> = {}) =>
  ({
    chain,
    order: 1,
    file,
    inputs: [{ ...COIN, value: 100_000, kind: "wpkh" }],
    ...more,
  }) as PlannedTx;

async function writePlan(dataDir: string, id: string, txs: PlannedTx[], progress: Progress) {
  const dir = join(dataDir, "plans", id);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "plan.json"), JSON.stringify({ id, transactions: txs }));
  await Deno.writeTextFile(join(dir, "progress.json"), JSON.stringify(progress));
  return { dir, plan: { id, transactions: txs } as unknown as Plan, progress };
}
const verified = (txid: string) => ({ at: "x", txid, finalHex: "00", checks: [] });
const sent = { status: "accepted" as const, at: "x", backend: "b", attempts: 1 };

/** BTC-first plan P: its BTC split was replaced by P-bump1 (and, with `twice`, that by P-bump2). */
async function setup(spentBy: string, height: number, twice = false) {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-gate-" });
  const btc = fakeChain("btc", 975_000);
  btc.txs.set(COIN.txid, {
    vout: [{ value: 100_000, scriptpubkey: "0014" + "11".repeat(20) }],
    height: 900_000,
  });
  btc.txs.set(spentBy, { vout: [{ value: 99_000, scriptpubkey: "51" }], height });
  btc.spends.set(`${COIN.txid}:0`, { txid: spentBy, height });
  const gated = tx("xbt", "xbt/001-x.psbt", { gate: { chains: ["btc"] } });
  const link = (plan: string, file: string, txid: string) => ({ plan, file, txid });
  const p = await writePlan(dataDir, "P", [tx("btc", "btc/001-a.psbt"), gated], {
    version: 1,
    txs: {
      "btc/001-a.psbt": {
        verified: verified(T0),
        broadcast: { ...sent, status: "replaced" },
        replacedBy: link("P-bump1", "btc/001-b.psbt", T1),
      },
    },
  });
  await writePlan(dataDir, "P-bump1", [tx("btc", "btc/001-b.psbt")], {
    version: 1,
    txs: {
      "btc/001-b.psbt": twice
        ? {
          verified: verified(T1),
          broadcast: { ...sent, status: "replaced" },
          replacedBy: link("P-bump1-bump1", "btc/001-c.psbt", T2),
        }
        : { verified: verified(T1), broadcast: sent },
    },
  });
  if (twice) {
    await writePlan(dataDir, "P-bump1-bump1", [tx("btc", "btc/001-c.psbt")], {
      version: 1,
      txs: { "btc/001-c.psbt": { verified: verified(T2), broadcast: sent } },
    });
  }
  const backend = new EsploraBackend(
    "btc",
    {
      kind: "esplora",
      url: "http://x/api",
      proxy: { kind: "tor" },
      role: "both",
      priority: 0,
      origin: "user",
    },
    new FakeEsploraTransport(btc),
  );
  return {
    check: () =>
      gateProblems({
        planTx: gated,
        planDir: p.dir,
        plan: p.plan,
        progress: p.progress,
        chains: { btc: { backend, confirmations: 6 } },
        dataDir,
      }),
  };
}

Deno.test("gate: a BTC split replaced by a fee bump counts once the bump is deep", async () => {
  // Before following replacements this was "spent by another transaction" for good.
  assertEquals(await (await setup(T1, 975_000 - 9)).check(), []);
  const shallow = await (await setup(T1, 975_000 - 1)).check();
  assertEquals(shallow.length, 1);
  assert(shallow[0].includes("only 2 of 6 confirmations"), shallow[0]);
});

Deno.test("gate: bumps of bumps are followed to the transaction that confirmed", async () => {
  assertEquals(await (await setup(T2, 975_000 - 9, true)).check(), []);
});

Deno.test("gate: a stranger's spend of the coin is still a conflict", async () => {
  const problems = await (await setup("ee".repeat(32), 975_000 - 9)).check();
  assertEquals(problems.length, 1);
  assert(problems[0].includes("spent by another transaction"), problems[0]);
});
