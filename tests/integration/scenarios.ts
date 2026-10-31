/**
 * RBF fee bump and reorg handling, against real nodes. Both start the same way: a wallet whose
 * coins are shared on all three chains is planned, signed, verified and broadcast with the CLI.
 */
import { join } from "node:path";
import { assert, assertEquals } from "../assert.ts";
import type { ChainId } from "../../src/core/profiles.ts";
import {
  foreignSpendHex,
  makeCli,
  planIds,
  readPlan,
  readProgress,
  signPlan,
} from "./cli_harness.ts";
import type { Rpc } from "./rpc.ts";

export interface ScenarioWallet {
  descriptors: string[];
  keys: Map<string, Uint8Array>;
}

export interface Harness {
  nodes: Record<ChainId, Rpc>;
  /** A fresh miner address on that chain (a new payee makes re-mined blocks differ). */
  minerAddr: (chain: ChainId) => Promise<string>;
  ecxDest: string;
  xbtDest: string;
}

const mine = async (h: Harness, chain: ChainId, n: number) =>
  await h.nodes[chain].mine(n, await h.minerAddr(chain));

/** import -> scan -> dest -> plan -> sign -> verify -> broadcast everything, no blocks mined. */
async function broadcastWallet(h: Harness, w: ScenarioWallet, feeRate: string) {
  const cli = await makeCli(h.nodes);
  const { run, text } = cli;
  assertEquals(await run("init", "--yes"), 0, text());
  for (const d of w.descriptors) assertEquals(await run("import", d), 0, text());
  assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
  assertEquals(await run("dest", "set", "ecx", h.ecxDest), 0, text());
  assertEquals(await run("dest", "set", "xbt", h.xbtDest), 0, text());
  assertEquals(
    await run("plan", "--xbt-signer", "knots", "--fee-rate", feeRate, "--yes"),
    0,
    text(),
  );
  const [planId] = await planIds(cli.dir);
  const { dir, plan } = await readPlan(cli.dir, planId);
  await signPlan(dir, plan, w.keys);
  assertEquals(await run("verify", planId), 0, text());
  assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
  return { cli, planId, dir, plan };
}

async function verifiedTxid(planDir: string, file: string): Promise<string> {
  return (await readProgress(planDir)).txs[file].verified!.txid;
}

export async function rbfScenario(t: Deno.TestContext, h: Harness, w: ScenarioWallet) {
  const { cli, planId, dir, plan } = await broadcastWallet(h, w, "ecx=2,xbt=2");
  const { run, text } = cli;
  const originals = await Promise.all(
    plan.transactions.map(async (tx) => ({ tx, txid: await verifiedTxid(dir, tx.file) })),
  );
  let bumpId = "";

  await t.step("track: the broadcast transactions are in the mempool, unconfirmed", async () => {
    assertEquals(await run("track", planId), 0, text());
    assertEquals((text().match(/\bmempool\b/gu) ?? []).length >= originals.length, true, text());
  });

  await t.step("bump refuses a rate that BIP125 would reject, and writes nothing", async () => {
    assertEquals(await run("bump", planId, "--fee-rate", "ecx=2.5,xbt=2.5", "--yes"), 1, text());
    assert(text().includes("too low to replace"), text());
    assertEquals((await planIds(cli.dir)).length, 1);
  });

  await t.step("bump writes a replacement plan: same inputs and marker, higher fee", async () => {
    assertEquals(await run("bump", planId, "--fee-rate", "ecx=6,xbt=6", "--yes"), 0, text());
    const ids = await planIds(cli.dir);
    assertEquals(ids.length, 2);
    bumpId = ids.find((id) => id !== planId)!;
    const bumped = await readPlan(cli.dir, bumpId);
    assertEquals(bumped.plan.transactions.length, originals.length);
    for (const r of bumped.plan.transactions) {
      const old = originals.find((o) => o.tx.file === r.replaces?.file)!.tx;
      assertEquals(r.inputs, old.inputs);
      assertEquals(r.lockTime, old.lockTime);
      assertEquals(r.sequence, old.sequence);
      assertEquals(r.sighashType, old.sighashType);
      assertEquals(r.output.address, old.output.address);
      assert(r.fee > old.fee && r.feeRate === 6, `${r.file} fee ${r.fee}`);
      assertEquals(r.output.value, old.output.value + old.fee - r.fee);
    }
    // Nothing is called "replaced" until a replacement is actually sent.
    for (const p of Object.values((await readProgress(dir)).txs)) {
      assertEquals(p.replacedBy, undefined);
    }
  });

  await t.step("the replacement is signed, verified by real nodes and broadcast", async () => {
    const bumped = await readPlan(cli.dir, bumpId);
    await signPlan(bumped.dir, bumped.plan, w.keys);
    assertEquals(await run("verify", bumpId), 0, text());
    assertEquals(await run("broadcast", bumpId, "--yes"), 0, text());
  });

  await t.step("each node's mempool now holds the replacement and not the original", async () => {
    const bumped = await readPlan(cli.dir, bumpId);
    for (const r of bumped.plan.transactions) {
      const pool = await h.nodes[r.chain].call<string[]>("getrawmempool");
      assert(pool.includes(await verifiedTxid(bumped.dir, r.file)), `${r.file} not in mempool`);
      const old = originals.find((o) => o.tx.file === r.replaces!.file)!;
      assert(!pool.includes(old.txid), `${old.tx.file} is still in the mempool`);
    }
  });

  await t.step("track on the original says it was replaced; it is not an alert", async () => {
    assertEquals(await run("track", planId), 0, text());
    assert(text().includes(`REPLACED by plan ${bumpId}`), text());
    const progress = await readProgress(dir);
    for (const o of originals) assertEquals(progress.txs[o.tx.file].broadcast?.status, "replaced");
  });

  await t.step("an already-replaced transaction can't be bumped again", async () => {
    assertEquals(await run("bump", planId, "--yes"), 1, text());
    assert(text().includes("already replaced"), text());
  });

  await t.step("after mining, the replacement confirms and can't be bumped", async () => {
    for (const c of ["ecx", "xbt"] as const) await mine(h, c, 2);
    assertEquals(await run("track", bumpId), 0, text());
    assert(/\b2 of 1\b/u.test(text()), text());
    assertEquals(await run("bump", bumpId, "--yes"), 1, text());
    assert(text().includes("already confirmed"), text());
    assertEquals(await run("track", planId), 0, text()); // the original stays "replaced"
    assert(text().includes("REPLACED by plan"), text());
  });

  await t.step("rescan: both fork copies are spent, the BTC copies are not", async () => {
    assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
    assertEquals(await run("status", "--json"), 0, text());
    const status = JSON.parse(cli.stdout()) as {
      coins: { classification: { unspentOn: string[] } }[];
    };
    for (const c of status.coins) assertEquals(c.classification.unspentOn, ["btc"]);
  });
}

export async function reorgScenario(t: Deno.TestContext, h: Harness, w: ScenarioWallet) {
  const { cli, planId, dir, plan } = await broadcastWallet(h, w, "ecx=2,xbt=2");
  const { run, text } = cli;
  const ecx = h.nodes.ecx;
  const ecxTxs = plan.transactions.filter((x) => x.chain === "ecx").sort((a, b) =>
    a.order - b.order
  );
  const [a1, a2] = ecxTxs;
  const a1Txid = await verifiedTxid(dir, a1.file);
  let bumpId = "";
  let bTxid = "";

  // Where the ECX transactions were mined: tip - 2 after mining three blocks on top of them.
  const blockWithSplits = async () => (await ecx.call<number>("getblockcount")) - 2;
  const reorgOut = async () => {
    await ecx.call("invalidateblock", await ecx.call("getblockhash", await blockWithSplits()));
  };

  await t.step(
    "prepare a fee bump for the first ECX split, then let everything confirm",
    async () => {
      assertEquals(
        await run("bump", planId, "--chains", "ecx", "--tx", "1", "--fee-rate", "ecx=6", "--yes"),
        0,
        text(),
      );
      bumpId = (await planIds(cli.dir)).find((id) => id !== planId)!;
      const bumped = await readPlan(cli.dir, bumpId);
      assertEquals(bumped.plan.transactions.length, 1);
      await signPlan(bumped.dir, bumped.plan, w.keys);
      assertEquals(await run("verify", bumpId), 0, text());
      bTxid = await verifiedTxid(bumped.dir, bumped.plan.transactions[0].file);
      for (const c of ["ecx", "xbt"] as const) await mine(h, c, 3);
      assertEquals(await run("track", planId), 0, text());
      assert(/\b3 of 1\b/u.test(text()), text());
    },
  );

  await t.step("re-mined in a different block: reported once, then quiet", async () => {
    await reorgOut();
    await mine(h, "ecx", 3); // the same transactions confirm again, in a different block
    assertEquals(await run("track", planId), 1, text());
    assert(text().includes("REORG"), text());
    assert(text().includes("is now in block"), text());
    assertEquals(await run("track", planId), 0, text());
    const reorgs = Object.values((await readProgress(dir)).txs).flatMap((p) => p.reorgs ?? []);
    assert(reorgs.some((r) => r.kind === "moved"), JSON.stringify(reorgs));
  });

  await t.step("pushed out of the chain and back to the mempool: reported", async () => {
    await reorgOut();
    for (let i = 0; i < 3; i++) await ecx.call("generateblock", await h.minerAddr("ecx"), []);
    assertEquals(await run("track", planId), 1, text());
    assert(text().includes("back in the mempool"), text());
  });

  await t.step(
    "the fee bump broadcast after the reorg replaces the original in the mempool",
    async () => {
      assertEquals(await run("broadcast", bumpId, "--yes"), 0, text());
      const pool = await ecx.call<string[]>("getrawmempool");
      assert(pool.includes(bTxid), "replacement missing from the mempool");
      assert(!pool.includes(a1Txid), "original still in the mempool");
      assertEquals(await run("track", planId), 1, text()); // the second split is still unconfirmed
      assert(text().includes(`REPLACED by plan ${bumpId}`), text());
    },
  );

  await t.step("everything confirms again; the final track is quiet", async () => {
    await mine(h, "ecx", 3);
    await run("track", planId); // may report that the second split moved blocks once more
    assertEquals(await run("track", planId), 0, text());
    assertEquals(await run("track", bumpId), 0, text());
  });

  await t.step("a spend from outside (like a replayed BTC spend) is a loud conflict", async () => {
    const foreign = foreignSpendHex(
      await Deno.readTextFile(join(dir, a2.file)),
      w.keys,
    );
    await reorgOut();
    await ecx.call("generateblock", await h.minerAddr("ecx"), [foreign]);
    await mine(h, "ecx", 2);
    assertEquals(await run("track", planId), 1, text());
    assert(text().includes("another transaction"), text());
    assert(text().includes("treat the key as compromised"), text());
    assertEquals((await readProgress(dir)).txs[a2.file].broadcast?.status, "conflict");
  });
}
