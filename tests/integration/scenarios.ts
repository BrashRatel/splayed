/**
 * RBF fee bump and reorg handling, against real nodes. Both start the same way: a wallet whose
 * coins are shared on all three chains is planned, signed, verified and broadcast with the CLI.
 */
import { join } from "node:path";
import { assert, assertEquals } from "../assert.ts";
import type { ChainId } from "../../src/core/profiles.ts";
import {
  finalHexOf,
  foreignSpendHex,
  makeCli,
  planIds,
  readPlan,
  readProgress,
  signPlan,
} from "./cli_harness.ts";
import type { Rpc } from "./rpc.ts";
import { mempoolChecks, type MempoolNode } from "../../src/core/execute.ts";
import type { PlannedTx } from "../../src/core/planner.ts";
import { parseDescriptor } from "../../src/core/descriptors.ts";
import { ignoresUnifiedSign, stockSign, unifiedSign } from "./signers.ts";

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
  btcDest: string;
  /** Private keys of the ECX and XBT destination wallets (for signing CPFP children). */
  ecxDestKeys: Map<string, Uint8Array>;
  xbtDestKeys: Map<string, Uint8Array>;
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

/**
 * Advanced XBT donor route. `source` holds shared coins; `donorWallet` holds XBT-only coinbase
 * donors (mined here, after the fork) plus one decoy coin from the shared prefix at index 5.
 * Every XBT split is signed with plain SIGHASH_ALL, as a stock hardware wallet would.
 */
export async function donorScenario(
  t: Deno.TestContext,
  h: Harness,
  source: ScenarioWallet,
  donorWallet: ScenarioWallet,
) {
  const cli = await makeCli(h.nodes);
  const { run, text } = cli;
  const donorDesc = parseDescriptor(donorWallet.descriptors[0]);
  const addrOf = async (i: number) =>
    (await h.nodes.xbt.call<{ address: string }>(
      "decodescript",
      donorDesc.branches[0].derive(i).scriptPubKey,
    )).address;
  const allKeys = new Map([...source.keys, ...donorWallet.keys]);

  await t.step("mine XBT-only coinbase donors, then let them mature", async () => {
    for (const i of [0, 1, 2]) await h.nodes.xbt.mine(1, await addrOf(i));
    await h.nodes.xbt.mine(100, await h.minerAddr("xbt"));
    assertEquals(await run("init", "--yes"), 0, text());
    for (const d of source.descriptors) assertEquals(await run("import", d), 0, text());
    assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
    assertEquals(await run("dest", "set", "ecx", h.ecxDest), 0, text());
    assertEquals(await run("dest", "set", "xbt", h.xbtDest), 0, text());
  });

  await t.step("donor scan: coinbase donors are usable, the shared decoy is refused", async () => {
    assertEquals(await run("donor", "import", donorWallet.descriptors[0]), 0, text());
    assertEquals(await run("donor", "scan", "--rpc-range", "20"), 0, text());
    assert(text().includes("3 usable donor(s)"), text());
    assert(text().includes("exists on BTC"), text());
    assert(text().includes("coinbase"), text());
    assertEquals(await run("donor", "show"), 0, text());
  });

  // The donor outpoints in full, from the saved scan.
  const scan = JSON.parse(await Deno.readTextFile(join(cli.dir, "donor-scan.json"))) as {
    coins: { txid: string; vout: number; eligible: boolean; provenance: string }[];
  };
  const good = scan.coins.filter((c) => c.eligible).map((c) => `${c.txid}:${c.vout}`);
  const decoy = scan.coins.find((c) => !c.eligible)!;

  await t.step(
    "plan: without a signer or donor XBT is refused; a bad donor is refused",
    async () => {
      assertEquals(good.length, 3);
      assertEquals(await run("plan", "--chains", "xbt", "--fee-rate", "xbt=2", "--yes"), 1, text());
      assert(text().includes("--donor"), text());
      assertEquals(
        await run("plan", "--chains", "xbt", "--donor", `${decoy.txid}:${decoy.vout}`, "--yes"),
        1,
        text(),
      );
      assert(text().includes("can't be used"), text());
      // Two shared coins, one transaction each, but only one donor.
      assertEquals(
        await run("plan", "--chains", "xbt", "--donor", good[0], "--fee-rate", "xbt=2", "--yes"),
        1,
        text(),
      );
      assert(text().includes("needs 2 transaction(s)"), text());
      await Deno.stat(join(cli.dir, "plans")).then(
        async () => assertEquals((await planIds(cli.dir)).length, 0),
        () => {}, // no plan was ever written, so there is no plans directory either
      );
    },
  );

  let planId = "";
  await t.step("plan: each XBT split spends one donor next to a shared coin", async () => {
    assertEquals(
      await run(
        "plan",
        "--donor",
        good[0],
        "--donor",
        good[1],
        "--fee-rate",
        "ecx=2,xbt=2",
        "--yes",
      ),
      0,
      text(),
    );
    [planId] = await planIds(cli.dir);
    const { plan } = await readPlan(cli.dir, planId);
    const xbt = plan.transactions.filter((x) => x.chain === "xbt");
    assertEquals(xbt.length, 2);
    for (const x of xbt) {
      assertEquals(x.inputs.length, 2);
      assert(x.donor && good.includes(`${x.donor.txid}:${x.donor.vout}`));
      assertEquals(x.sighashType, undefined); // no 0x21: the donor is the protection
    }
    assertEquals(plan.route, "forks-first-donor");
  });

  await t.step("verify refuses a split whose donor input is not signed", async () => {
    const { dir, plan } = await readPlan(cli.dir, planId);
    const signWith = async (keys: Map<string, Uint8Array>) => {
      for (const x of plan.transactions.filter((x) => x.chain === "xbt")) {
        const signed = stockSign(await Deno.readTextFile(join(dir, x.file)), keys);
        await Deno.writeTextFile(join(dir, x.file.replace(/\.psbt$/u, ".signed.psbt")), signed);
      }
    };
    await signWith(source.keys); // the shared coin only: nobody signed the donor input
    assertEquals(await run("verify", planId), 1, text());
    assert(text().includes("required signature"), text());
  });

  await t.step("verify accepts stock SIGHASH_ALL signatures; BTC and ECX reject them", async () => {
    const { dir, plan } = await readPlan(cli.dir, planId);
    for (const x of plan.transactions) {
      const signed = stockSign(await Deno.readTextFile(join(dir, x.file)), allKeys);
      await Deno.writeTextFile(join(dir, x.file.replace(/\.psbt$/u, ".signed.psbt")), signed);
    }
    assertEquals(await run("verify", planId), 0, text());
    assert(text().includes("plain SIGHASH_ALL"), text());
    assert(text().includes("BTC node: rejected (good)"), text());
    assert(text().includes("ECX node: rejected (good)"), text());
  });

  await t.step("broadcast, confirm, track; the donors are spent on XBT", async () => {
    assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
    for (const c of ["xbt", "ecx"] as const) await h.nodes[c].mine(2, await h.minerAddr(c));
    assertEquals(await run("track", planId), 0, text());
    const progress = await readProgress((await readPlan(cli.dir, planId)).dir);
    const { plan } = await readPlan(cli.dir, planId);
    for (const x of plan.transactions.filter((x) => x.chain === "xbt")) {
      const hex = progress.txs[x.file].verified!.finalHex;
      for (const other of ["btc", "ecx"] as const) {
        const [r] = await h.nodes[other].call<{ allowed: boolean }[]>("testmempoolaccept", [hex]);
        assertEquals(r.allowed, false, `XBT donor split accepted by ${other}`);
      }
    }
    assertEquals(await run("donor", "scan", "--rpc-range", "20"), 0, text());
    assert(text().includes("1 usable donor(s)"), text());
  });

  await t.step(
    "fan-out refuses a donor that is not usable or an output count that is silly",
    async () => {
      assertEquals(
        await run(
          "donor",
          "fanout",
          "--donor",
          `${decoy.txid}:${decoy.vout}`,
          "--outputs",
          "3",
          "--fee-rate",
          "xbt=2",
          "--yes",
        ),
        1,
        text(),
      );
      assert(text().includes("can't be used"), text());
      assertEquals(
        await run("donor", "fanout", "--donor", good[2], "--outputs", "1", "--yes"),
        1,
        text(),
      );
    },
  );

  let fanId = "";
  await t.step("fan-out: one donor becomes three, signed with plain SIGHASH_ALL", async () => {
    const before = await planIds(cli.dir);
    assertEquals(
      await run(
        "donor",
        "fanout",
        "--donor",
        good[2],
        "--outputs",
        "3",
        "--value",
        "1000000",
        "--fee-rate",
        "xbt=2",
        "--yes",
      ),
      0,
      text(),
    );
    fanId = (await planIds(cli.dir)).find((id) => !before.includes(id))!;
    const { dir, plan } = await readPlan(cli.dir, fanId);
    assertEquals(plan.route, "donor-fanout");
    const [tx] = plan.transactions;
    assertEquals(tx.inputs.length, 1);
    assertEquals(tx.outputs!.length, 4); // three of 1,000,000 sats and the change
    assertEquals(tx.sighashType, undefined);
    const signed = stockSign(await Deno.readTextFile(join(dir, tx.file)), donorWallet.keys);
    await Deno.writeTextFile(join(dir, tx.file.replace(/\.psbt$/u, ".signed.psbt")), signed);
    assertEquals(await run("verify", fanId), 0, text());
    assert(text().includes("BTC node: rejected (good)"), text());
    assert(text().includes("ECX node: rejected (good)"), text());
  });

  await t.step("after the fan-out confirms, its outputs are usable donors", async () => {
    assertEquals(await run("broadcast", fanId, "--yes"), 0, text());
    await h.nodes.xbt.mine(2, await h.minerAddr("xbt"));
    assertEquals(await run("donor", "scan", "--rpc-range", "20"), 0, text());
    // All three coinbase donors are spent now; the four new outputs are what is left.
    assert(text().includes("4 usable donor(s)"), text());
    assert(text().includes("protected-spend"), text());
    // The fan-out outputs are fresh addresses of the donor wallet, past the ones already used.
    const after = JSON.parse(await Deno.readTextFile(join(cli.dir, "watch-only.json"))) as {
      donors: { nextIndex?: number }[];
    };
    assert((after.donors[0].nextIndex ?? 0) >= 10, JSON.stringify(after.donors)); // past the decoy at 5
  });
}

/**
 * Advanced BTC-first route. `source` holds shared coins (two of them); `donorWallet` holds BTC-only
 * coinbase donors mined here after the fork. BTC and ECX are split first, with plain signatures, and
 * the XBT split (no replay protection of its own) is held back until both are confirmed.
 */
export async function btcFirstScenario(
  t: Deno.TestContext,
  h: Harness,
  source: ScenarioWallet,
  donorWallet: ScenarioWallet,
) {
  const cli = await makeCli(h.nodes);
  const { run, text } = cli;
  const donorDesc = parseDescriptor(donorWallet.descriptors[0]);
  const allKeys = new Map([...source.keys, ...donorWallet.keys]);

  await t.step("mine BTC-only coinbase donors, then let them mature", async () => {
    for (const i of [0, 1]) {
      const addr = (await h.nodes.btc.call<{ address: string }>(
        "decodescript",
        donorDesc.branches[0].derive(i).scriptPubKey,
      )).address;
      await h.nodes.btc.mine(1, addr);
    }
    await h.nodes.btc.mine(100, await h.minerAddr("btc"));
    assertEquals(await run("init", "--yes"), 0, text());
    for (const d of source.descriptors) assertEquals(await run("import", d), 0, text());
    assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
    for (const [chain, dest] of [["btc", h.btcDest], ["ecx", h.ecxDest], ["xbt", h.xbtDest]]) {
      assertEquals(await run("dest", "set", chain, dest), 0, text());
    }
  });

  await t.step("donor scan: the coinbase outputs are BTC donors", async () => {
    assertEquals(await run("donor", "import", donorWallet.descriptors[0]), 0, text());
    assertEquals(await run("donor", "scan", "--rpc-range", "20"), 0, text());
    assert(text().includes("2 usable donor(s)"), text());
    assert(text().includes("BTC donor"), text());
  });
  const scan = JSON.parse(await Deno.readTextFile(join(cli.dir, "donor-scan.json"))) as {
    coins: { txid: string; vout: number; eligible: boolean; home: string }[];
  };
  const good = scan.coins.filter((c) => c.eligible).map((c) => `${c.txid}:${c.vout}`);
  assertEquals(good.length, 2);

  await t.step("plan: refuses without a BTC donor, and an XBT donor on the BTC route", async () => {
    assertEquals(await run("plan", "--btc-first", "--fee-rate", "btc=2,ecx=2,xbt=2", "--yes"), 1);
    assert(text().includes("needs a BTC donor"), text());
    assertEquals(
      await run(
        "plan",
        "--btc-first",
        "--donor",
        good[0],
        "--xbt-signer",
        "knots",
        "--fee-rate",
        "btc=2,ecx=2,xbt=2",
        "--yes",
      ),
      1,
      text(),
    );
    assert(text().includes("no --xbt-signer"), text());
  });

  let planId = "";
  await t.step("plan: BTC with a donor, ECX with the locktime, XBT plain and gated", async () => {
    assertEquals(
      await run(
        "plan",
        "--btc-first",
        "--donor",
        good[0],
        "--donor",
        good[1],
        "--fee-rate",
        "btc=2,ecx=2,xbt=2",
        "--yes",
      ),
      0,
      text(),
    );
    [planId] = await planIds(cli.dir);
    const { plan } = await readPlan(cli.dir, planId);
    assertEquals(plan.route, "btc-first-donor");
    const by = (c: string) => plan.transactions.filter((x) => x.chain === c);
    assertEquals([by("btc").length, by("ecx").length, by("xbt").length], [2, 2, 2]);
    for (const x of by("btc")) assert(x.donor && x.inputs.length === 2 && !x.gate);
    for (const x of by("xbt")) {
      assert(x.gate && !x.donor && x.sighashType === undefined && x.inputs.length === 1);
    }
  });

  await t.step("verify: stock signatures pass; BTC txs are rejected by XBT and ECX", async () => {
    const { dir, plan } = await readPlan(cli.dir, planId);
    for (const x of plan.transactions) {
      const signed = stockSign(await Deno.readTextFile(join(dir, x.file)), allKeys);
      await Deno.writeTextFile(join(dir, x.file.replace(/\.psbt$/u, ".signed.psbt")), signed);
    }
    assertEquals(await run("verify", planId), 0, text());
    assert(text().includes("BTC-only donor"), text());
    assert(text().includes("gated"), text());
    assert(text().includes("accepts it for now"), text());
  });

  await t.step("broadcast: BTC and ECX go out, the plain XBT split is held back", async () => {
    assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
    assert(text().includes("held back"), text());
    const { dir, plan } = await readPlan(cli.dir, planId);
    const progress = await readProgress(dir);
    for (const x of plan.transactions) {
      const sent = progress.txs[x.file].broadcast?.status === "accepted";
      assertEquals(sent, x.chain !== "xbt", `${x.chain} ${x.file}`);
    }
    // Unconfirmed is not enough: still held back.
    assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
    assert(text().includes("held back"), text());
  });

  await t.step("once BTC and ECX are confirmed, the XBT split is sent", async () => {
    for (const c of ["btc", "ecx"] as const) await h.nodes[c].mine(2, await h.minerAddr(c));
    assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
    const { dir, plan } = await readPlan(cli.dir, planId);
    const progress = await readProgress(dir);
    for (const x of plan.transactions.filter((x) => x.chain === "xbt")) {
      assertEquals(progress.txs[x.file].broadcast?.status, "accepted", text());
      // No other chain can take it any more: the coin is spent there.
      for (const other of ["btc", "ecx"] as const) {
        const [r] = await h.nodes[other].call<{ allowed: boolean }[]>("testmempoolaccept", [
          progress.txs[x.file].verified!.finalHex,
        ]);
        assertEquals(r.allowed, false, `XBT split accepted by ${other}`);
      }
    }
    await h.nodes.xbt.mine(2, await h.minerAddr("xbt"));
    assertEquals(await run("track", planId), 0, text());
  });
}

/**
 * Donors whose funding transaction this tool did not make. Another "machine" (a second data
 * directory) splits two shared coins onto XBT into the donor wallet: one with a 0x21 signature, one
 * with a plain signature sent straight to the XBT node. The first donor can be traced and used; the
 * second could be replayed onto BTC by anyone holding its funding transaction, so it is refused.
 */
export async function foreignFundingScenario(
  t: Deno.TestContext,
  h: Harness,
  source: ScenarioWallet,
  donorWallet: ScenarioWallet,
) {
  const funder = await makeCli(h.nodes);
  let protectedOut = "";
  let plainOut = "";

  await t.step(
    "another machine funds the donor wallet: one 0x21 spend, one plain spend",
    async () => {
      const { run, text } = funder;
      assertEquals(await run("init", "--yes"), 0, text());
      for (const d of source.descriptors) assertEquals(await run("import", d), 0, text());
      assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
      assertEquals(await run("dest", "set", "ecx", h.ecxDest), 0, text());
      assertEquals(await run("dest", "set", "xbt", donorWallet.descriptors[0]), 0, text());
      assertEquals(
        await run(
          "plan",
          "--chains",
          "xbt",
          "--xbt-signer",
          "knots",
          "--fee-rate",
          "xbt=2",
          "--yes",
        ),
        0,
        text(),
      );
      const [planId] = await planIds(funder.dir);
      const { dir, plan } = await readPlan(funder.dir, planId);
      const [protectedTx, plainTx] = plan.transactions;
      // Transaction 1: signed with 0x21 and sent through the tool.
      const p1 = join(dir, protectedTx.file.replace(/\.psbt$/u, ".signed.psbt"));
      await Deno.writeTextFile(
        p1,
        unifiedSign(await Deno.readTextFile(join(dir, protectedTx.file)), source.keys),
      );
      assertEquals(await run("verify", planId), 0, text());
      assertEquals(await run("broadcast", planId, "--yes"), 0, text());
      // Transaction 2: signed WITHOUT 0x21 and pushed to the XBT node directly. This is what a
      // careless funder does, and it is the transaction someone could still send to BTC.
      const plain = ignoresUnifiedSign(
        await Deno.readTextFile(join(dir, plainTx.file)),
        source.keys,
      );
      await h.nodes.xbt.call("sendrawtransaction", finalHexOf(plain));
      await h.nodes.xbt.mine(2, await h.minerAddr("xbt"));
      protectedOut = `${protectedTx.unsignedTxid}`;
      plainOut = `${plainTx.unsignedTxid}`;
    },
  );

  // The donor tool knows nothing about the funder's plan.
  const cli = await makeCli(h.nodes);
  const { run, text } = cli;
  let scan: { coins: { txid: string; vout: number; eligible: boolean; provenance: string }[] };

  await t.step(
    "donor scan: the 0x21-funded donor is verified, the plain-funded one refused",
    async () => {
      assertEquals(await run("init", "--yes"), 0, text());
      assertEquals(await run("donor", "import", donorWallet.descriptors[0]), 0, text());
      assertEquals(await run("donor", "scan", "--rpc-range", "20"), 0, text());
      scan = JSON.parse(await Deno.readTextFile(join(cli.dir, "donor-scan.json")));
      const a = scan.coins.find((c) => c.txid === protectedOut)!;
      const b = scan.coins.find((c) => c.txid === plainOut)!;
      assert(a && b, JSON.stringify(scan.coins.map((c) => c.txid)));
      assertEquals([a.provenance, a.eligible], ["verified-funding", true]);
      assertEquals([b.provenance, b.eligible], ["unproven", false]);
      assert(text().includes("0x21"), text());
    },
  );

  await t.step("the verified donor can be fanned out; the unproven one is refused", async () => {
    const a = scan.coins.find((c) => c.txid === protectedOut)!;
    const b = scan.coins.find((c) => c.txid === plainOut)!;
    assertEquals(
      await run(
        "donor",
        "fanout",
        "--donor",
        `${b.txid}:${b.vout}`,
        "--outputs",
        "2",
        "--fee-rate",
        "xbt=2",
        "--yes",
      ),
      1,
      text(),
    );
    assert(text().includes("unproven"), text());
    assertEquals(
      await run(
        "donor",
        "fanout",
        "--donor",
        `${a.txid}:${a.vout}`,
        "--outputs",
        "2",
        "--fee-rate",
        "xbt=2",
        "--yes",
      ),
      0,
      text(),
    );
    const [id] = await planIds(cli.dir);
    const { dir, plan } = await readPlan(cli.dir, id);
    const [tx] = plan.transactions;
    await Deno.writeTextFile(
      join(dir, tx.file.replace(/\.psbt$/u, ".signed.psbt")),
      stockSign(await Deno.readTextFile(join(dir, tx.file)), donorWallet.keys),
    );
    assertEquals(await run("verify", id), 0, text());
    assertEquals(await run("broadcast", id, "--yes"), 0, text());
  });
}

/**
 * What real nodes say when they reject a transaction, and whether `mempoolChecks` reads it right.
 * On the target chain, "inputs missing", "already known/confirmed" and "conflicts with the
 * mempool" must be tolerated (the transaction may already be on its way), while a bad signature
 * must stop everything. The reasons are asserted per node, so a wording change in a node release
 * shows up here instead of in somebody's broadcast.
 */
export async function nodeRpcScenario(t: Deno.TestContext, h: Harness) {
  for (const chain of ["btc", "xbt", "ecx"] as const) {
    await t.step(`${chain.toUpperCase()}: reject reasons are classified correctly`, async () => {
      const node = h.nodes[chain];
      const wallet = node.withWallet("miner");
      await node.mine(101, await h.minerAddr(chain));
      const test = async (hex: string) => {
        const [r] = await node.call<{ allowed: boolean; "reject-reason"?: string }[]>(
          "testmempoolaccept",
          [hex],
        );
        return r;
      };
      const adapter: MempoolNode = {
        chain,
        backend: {
          testMempoolAccept: async (hex: string) => {
            const r = await test(hex);
            return { allowed: r.allowed, reason: r["reject-reason"] };
          },
        } as unknown as MempoolNode["backend"],
      };
      const planTx = { chain } as PlannedTx;
      const spend = async (amountOff: number, sequence = 0xffffffff, utxoIndex = 0) => {
        const unspent = (await wallet.call<
          { txid: string; vout: number; amount: number; spendable: boolean }[]
        >("listunspent", 1)).filter((u) => u.spendable && u.amount >= 1);
        const u = unspent[utxoIndex];
        const raw = await wallet.call<string>(
          "createrawtransaction",
          [{ txid: u.txid, vout: u.vout, sequence }],
          {
            [await wallet.call<string>("getnewaddress")]: Number((u.amount - amountOff).toFixed(8)),
          },
        );
        const signed = await wallet.call<{ hex: string; complete: boolean }>(
          "signrawtransactionwithwallet",
          raw,
        );
        assert(signed.complete, `${chain}: wallet couldn't sign`);
        return signed.hex;
      };
      const tolerated = async (reason: string | undefined, hex: string, what: string) => {
        console.log(`  ${chain.toUpperCase()} ${what}: ${reason}`);
        const out = await mempoolChecks(planTx, hex, [adapter]);
        assert(out[chain].startsWith("rejected by your node"), `${what}: ${out[chain]}`);
      };

      // 1. Inputs that do not exist.
      const ghost = (await spend(0.001)).replace(/^(.{14})(.{64})/u, `$1${"ab".repeat(32)}`);
      const missing = await test(ghost);
      assertEquals(missing.allowed, false);
      await tolerated(missing["reject-reason"], ghost, "missing inputs");

      // 2. A transaction that conflicts with one already in the mempool.
      const a = await spend(0.001, 0xffffffff, 0);
      const b = await spend(0.0005, 0xffffffff, 0); // pays less, so it cannot replace `a`
      await node.call("sendrawtransaction", a);
      const conflict = await test(b);
      assertEquals(conflict.allowed, false);
      await tolerated(conflict["reject-reason"], b, "mempool conflict");

      // 3. A transaction that is already confirmed.
      await node.mine(1, await h.minerAddr(chain));
      const known = await test(a);
      assertEquals(known.allowed, false);
      await tolerated(known["reject-reason"], a, "already confirmed");

      // 4. A broken signature must NOT be tolerated.
      const good = await spend(0.001, 0xffffffff, 1);
      assertEquals((await test(good)).allowed, true);
      const at = good.length - 8 - 66 - 2 - 20; // inside the witness signature
      const flipped = good.slice(0, at) + (good[at] === "0" ? "1" : "0") + good.slice(at + 1);
      const bad = await test(flipped);
      assertEquals(bad.allowed, false);
      console.log(`  ${chain.toUpperCase()} bad signature: ${bad["reject-reason"]}`);
      let threw = false;
      try {
        await mempoolChecks(planTx, flipped, [adapter]);
      } catch (error) {
        threw = (error as Error).message.includes("node rejects it");
      }
      assert(threw, `${chain}: a bad signature was tolerated`);
    });
  }
}

/**
 * "Left the chain AND the mempool, input unspent". A regtest node only drops a transaction that
 * way when the mempool expires it, so: confirm a split, reorg it out (back to the mempool), move
 * the node's clock past the 14-day mempool expiry, and let any new transaction trigger the trim.
 */
export async function droppedScenario(t: Deno.TestContext, h: Harness, w: ScenarioWallet) {
  const { cli, planId, dir, plan } = await broadcastWallet(h, w, "ecx=2,xbt=2");
  const { run, text } = cli;
  const ecx = h.nodes.ecx;
  const txids = await Promise.all(
    plan.transactions.filter((x) => x.chain === "ecx").map((x) => verifiedTxid(dir, x.file)),
  );
  const mocktimes: Rpc[] = [];

  try {
    await t.step("confirmed, then reorged out and expired from the mempool", async () => {
      await mine(h, "ecx", 2);
      assertEquals(await run("track", planId), 0, text());
      await ecx.call(
        "invalidateblock",
        await ecx.call("getblockhash", await ecx.call<number>("getblockcount") - 1),
      );
      const back = await ecx.call<string[]>("getrawmempool");
      for (const id of txids) assert(back.includes(id), "the reorg should put it back first");
      const now = Math.floor(Date.now() / 1000);
      mocktimes.push(ecx);
      await ecx.call("setmocktime", now + 15 * 24 * 3600);
      // Any accepted transaction makes the node trim and expire its mempool.
      const miner = ecx.withWallet("miner");
      await miner.call("sendtoaddress", await miner.call<string>("getnewaddress"), 0.1);
      const pool = await ecx.call<string[]>("getrawmempool");
      for (const id of txids) assert(!pool.includes(id), `${id} should have expired`);
    });

    await t.step("track reports it as gone, and says how to recover", async () => {
      assertEquals(await run("track", planId), 1, text());
      assert(text().includes("has left the chain"), text());
      assert(text().includes("Do NOT spend the BTC copy"), text());
      const reorgs = Object.values((await readProgress(dir)).txs).flatMap((p) => p.reorgs ?? []);
      assert(reorgs.some((r) => r.kind === "dropped"), JSON.stringify(reorgs));
    });

    await t.step("broadcast sends the dropped splits again and they confirm", async () => {
      await ecx.call("setmocktime", 0);
      mocktimes.length = 0;
      assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
      const pool = await ecx.call<string[]>("getrawmempool");
      for (const id of txids) assert(pool.includes(id), `${id} should be back in the mempool`);
      await mine(h, "ecx", 2);
      // They confirm in a different block from before: reported once, then quiet.
      assertEquals(await run("track", planId), 1, text());
      assert(text().includes("is now in block"), text());
      assertEquals(await run("track", planId), 0, text());
    });
  } finally {
    for (const n of mocktimes) await n.call("setmocktime", 0);
  }
}

/**
 * Fee-bump extras: dropping an input from one transaction of a `--batch all` plan, and lifting a
 * stuck split with a CPFP child on both forks.
 */
export async function bumpExtrasScenario(
  t: Deno.TestContext,
  h: Harness,
  dropWallet: ScenarioWallet,
  cpfpWallet: ScenarioWallet,
) {
  await t.step(
    "bump --drop: one coin leaves a batch, the node replaces the transaction",
    async () => {
      const cli = await makeCli(h.nodes);
      const { run, text } = cli;
      assertEquals(await run("init", "--yes"), 0, text());
      for (const d of dropWallet.descriptors) assertEquals(await run("import", d), 0, text());
      assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
      assertEquals(await run("dest", "set", "ecx", h.ecxDest), 0, text());
      assertEquals(
        await run("plan", "--chains", "ecx", "--batch", "all", "--fee-rate", "ecx=2", "--yes"),
        0,
        text(),
      );
      const [planId] = await planIds(cli.dir);
      const { dir, plan } = await readPlan(cli.dir, planId);
      const [orig] = plan.transactions;
      assertEquals(orig.inputs.length, 2);
      await signPlan(dir, plan, dropWallet.keys);
      assertEquals(await run("verify", planId), 0, text());
      assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
      const origTxid = await verifiedTxid(dir, orig.file);
      const dropped = `${orig.inputs[0].txid}:${orig.inputs[0].vout}`;
      const kept = `${orig.inputs[1].txid}:${orig.inputs[1].vout}`;

      // Refusals first.
      assertEquals(
        await run("bump", planId, "--tx", "1", "--drop", "ab:0", "--fee-rate", "ecx=6", "--yes"),
        1,
      );
      assert(text().includes("is not an input"), text());
      assertEquals(
        await run(
          "bump",
          planId,
          "--tx",
          "1",
          "--drop",
          dropped,
          "--drop",
          kept,
          "--fee-rate",
          "ecx=6",
          "--yes",
        ),
        1,
      );
      assert(text().includes("keep at least one input"), text());
      assertEquals(await run("bump", planId, "--drop", dropped, "--yes"), 2, text());

      assertEquals(
        await run("bump", planId, "--tx", "1", "--drop", dropped, "--fee-rate", "ecx=6", "--yes"),
        0,
        text(),
      );
      const bumpId = (await planIds(cli.dir)).find((id) => id !== planId)!;
      const bumped = await readPlan(cli.dir, bumpId);
      const [repl] = bumped.plan.transactions;
      assertEquals(repl.inputs.length, 1);
      assertEquals(`${repl.inputs[0].txid}:${repl.inputs[0].vout}`, kept);
      assert(repl.fee > orig.fee, "the replacement must pay more than the original");
      await signPlan(bumped.dir, bumped.plan, dropWallet.keys);
      assertEquals(await run("verify", bumpId), 0, text());
      assertEquals(await run("broadcast", bumpId, "--yes"), 0, text());
      const pool = await h.nodes.ecx.call<string[]>("getrawmempool");
      assert(
        pool.includes(await verifiedTxid(bumped.dir, repl.file)),
        "replacement not in mempool",
      );
      assert(!pool.includes(origTxid), "original still in the mempool");
      // The dropped coin is unspent again, so a later plan can use it.
      const [txid, vout] = dropped.split(":");
      const out = await h.nodes.ecx.call("gettxout", txid, Number(vout), true);
      assert(out !== null, "the dropped coin should be unspent");
      await mine(h, "ecx", 1);
    },
  );

  await t.step("bump --cpfp: a child lifts a low-fee split on ECX and XBT", async () => {
    const cli = await makeCli(h.nodes);
    const { run, text } = cli;
    assertEquals(await run("init", "--yes"), 0, text());
    for (const d of cpfpWallet.descriptors) assertEquals(await run("import", d), 0, text());
    assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
    assertEquals(await run("dest", "set", "ecx", h.ecxDest), 0, text());
    assertEquals(await run("dest", "set", "xbt", h.xbtDest), 0, text());
    assertEquals(
      await run("plan", "--xbt-signer", "knots", "--fee-rate", "ecx=1,xbt=1", "--yes"),
      0,
      text(),
    );
    const [planId] = await planIds(cli.dir);
    const { dir, plan } = await readPlan(cli.dir, planId);
    await signPlan(dir, plan, cpfpWallet.keys);
    assertEquals(await run("verify", planId), 0, text());
    assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());

    // Parent still unconfirmed: lift transaction 1 on each fork.
    assertEquals(await run("bump", planId, "--cpfp", "--tx", "1"), 2, text()); // no rate given
    assertEquals(
      await run("bump", planId, "--cpfp", "--tx", "1", "--fee-rate", "ecx=20,xbt=20", "--yes"),
      0,
      text(),
    );
    const cpfpId = (await planIds(cli.dir)).find((id) => id.includes("-cpfp"))!;
    const child = await readPlan(cli.dir, cpfpId);
    assertEquals(child.plan.route, "cpfp");
    assertEquals(child.plan.transactions.length, 2);
    for (const x of child.plan.transactions) {
      const keys = x.chain === "ecx" ? h.ecxDestKeys : h.xbtDestKeys;
      const signed = stockSign(await Deno.readTextFile(join(child.dir, x.file)), keys);
      await Deno.writeTextFile(join(child.dir, x.file.replace(/\.psbt$/u, ".signed.psbt")), signed);
    }
    assertEquals(await run("verify", cpfpId), 0, text());
    assertEquals(await run("broadcast", cpfpId, "--all", "--yes"), 0, text());
    // The pair pays about the requested rate on each chain.
    for (const x of child.plan.transactions) {
      const childTxid = await verifiedTxid(child.dir, x.file);
      const entry = await h.nodes[x.chain as "ecx" | "xbt"].call<
        { fees: { ancestor: number }; ancestorsize: number }
      >("getmempoolentry", childTxid);
      const rate = (entry.fees.ancestor * 1e8) / entry.ancestorsize;
      assert(rate >= 19, `${x.chain}: package rate ${rate} sat/vB`);
    }
    for (const c of ["ecx", "xbt"] as const) await mine(h, c, 2);
    assertEquals(await run("track", planId), 0, text());
    assertEquals(await run("track", cpfpId), 0, text());
  });
}
