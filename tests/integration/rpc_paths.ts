/**
 * Node RPC, with and without `-txindex`, against the real regtest nodes: the paths where a backend
 * has to be careful about what it cannot see. The unit-level versions run against fake chains
 * (tests/backends_e2e_test.ts, alerts_e2e_test.ts); these run splayed's CLI against real nodes.
 *
 *   - a send that got through but whose reply was lost: found again, never sent twice, and held
 *     when a node without `-txindex` can no longer see it;
 *   - the tool's own spend (a fee bump) recognised when the node cannot name the spender;
 *   - a stranger's spend of the same coin: a conflict where the node can tell, and a hold (never a
 *     send, never a false accusation) where it cannot.
 *
 * "Without txindex" is the regtest transport hiding what `-txindex` would show (RegtestTransport
 * Options.txindex), which is exactly what a node started without it answers.
 */
import { join } from "node:path";
import { NETWORK, p2wpkh, Transaction } from "@scure/btc-signer";
import { assert, assertEquals } from "../assert.ts";
import { fromHex, toHex } from "../../src/core/bytes.ts";
import {
  foreignSpendHex,
  makeCli,
  planIds,
  readPlan,
  readProgress,
  signPlan,
} from "./cli_harness.ts";
import type { RegtestTransportOptions, Rpc } from "./rpc.ts";
import { broadcastWallet, type Harness, type ScenarioWallet } from "./scenarios.ts";

export interface RpcPathsWallets {
  lost: ScenarioWallet;
  own: ScenarioWallet;
  conflict: ScenarioWallet;
}

const mine = async (h: Harness, chain: "ecx" | "xbt", n: number) =>
  await h.nodes[chain].mine(n, await h.minerAddr(chain));

async function txidOf(planDir: string, file: string): Promise<string> {
  return (await readProgress(planDir)).txs[file].verified!.txid;
}

/** The destination wallet moves a split's first output on, as it would in real life. */
async function spendFromDest(node: Rpc, txid: string, keys: Map<string, Uint8Array>) {
  const raw = await node.call<{ vout: { value: number; scriptPubKey: { hex: string } }[] }>(
    "getrawtransaction",
    txid,
    true,
  );
  const out = raw.vout[0];
  const key = [...keys].find(([pub]) =>
    toHex(p2wpkh(fromHex(pub), NETWORK).script) === out.scriptPubKey.hex
  );
  assert(key, "no destination key for the split's output");
  const amount = BigInt(Math.round(out.value * 1e8));
  const script = fromHex(out.scriptPubKey.hex);
  // ECX wants the replay marker on every spend: nLockTime 499999998 and a non-final sequence.
  const tx = new Transaction({ lockTime: 499_999_998 });
  tx.addInput({
    txid,
    index: 0,
    witnessUtxo: { script, amount },
    sequence: 0xfffffffd,
  });
  tx.addOutput({ script, amount: amount - 1000n });
  tx.signIdx(key[1], 0);
  tx.finalize();
  return await node.call<string>("sendrawtransaction", tx.hex);
}

export async function rpcPathsScenario(
  t: Deno.TestContext,
  h: Harness,
  wallets: RpcPathsWallets,
  txindex: boolean,
) {
  const mode = txindex ? "with txindex" : "without txindex";
  const debug = Deno.env.get("SPLAYED_IT_DEBUG");
  const ecx = h.nodes.ecx;

  await t.step(`${mode}: a send whose reply is lost is found again, never sent twice`, async () => {
    const options: RegtestTransportOptions = { txindex, sent: [] };
    const { cli, planId } = await prepare(h, wallets.lost, options);
    const { run, text } = cli;
    const { dir, plan } = await readPlan(cli.dir, planId);
    const [a, b] = plan.transactions.filter((x) => x.chain === "ecx").sort((x, y) =>
      x.order - y.order
    );
    assert(a.testFirst && !b.testFirst, "the first ECX transaction is the TEST FIRST one");
    const aId = await txidOf(dir, a.file);
    const bId = await txidOf(dir, b.file);
    const status = async (f: string) => (await readProgress(dir)).txs[f].broadcast?.status;
    const sentOnEcx = () => options.sent!.filter((s) => s.chain === "ecx").length;

    // 1. The TEST FIRST send gets through, but its reply is lost.
    options.loseReply = { chain: "ecx", method: "sendrawtransaction", remaining: 1 };
    const first = await run("broadcast", planId, "--yes");
    if (debug) console.log(`--- run 1 (exit ${first})\n${text()}`);
    assertEquals(first, 1, text());
    assertEquals(await status(a.file), "unknown", text());
    assert((await ecx.call<string[]>("getrawmempool")).includes(aId), "the send did get through");

    // 2. Again: it is found in the mempool and not sent again. The send after it also loses its reply.
    options.loseReply = { chain: "ecx", method: "sendrawtransaction", remaining: 1 };
    options.sent!.length = 0;
    const second = await run("broadcast", planId, "--yes");
    if (debug) console.log(`--- run 2 (exit ${second})\n${text()}`);
    assertEquals(await status(a.file), "accepted", text());
    assertEquals(sentOnEcx(), 1, `only the second split is sent: ${text()}`);
    assertEquals(await status(b.file), "unknown", text());
    assert(
      (await ecx.call<string[]>("getrawmempool")).includes(bId),
      "the second send got through",
    );
    assertEquals(second, 1, text());

    // 3. Both confirm. Without txindex the second split's output is then moved on, so the node
    //    can no longer show anything of it.
    await mine(h, "ecx", 1);
    if (!txindex) {
      await spendFromDest(ecx, bId, h.ecxDestKeys);
      await mine(h, "ecx", 1);
    }
    options.sent!.length = 0;
    const third = await run("broadcast", planId, "--yes");
    if (debug) console.log(`--- run 3 (exit ${third})\n${text()}`);
    assertEquals(sentOnEcx(), 0, `nothing is sent again: ${text()}`);
    assertEquals(await status(a.file), "accepted", text());
    if (txindex) {
      assertEquals(await status(b.file), "accepted", text());
    } else {
      // The first split is still recognised: its own output is unspent. The second one's output
      // was moved on, so nothing of it is left to see. It is held, not sent again, not recorded
      // as sent, and not called a conflict.
      assertEquals(await status(b.file), "unknown", text());
      assert(text().includes("this backend can't tell"), text());
      assert(!text().includes("CONFLICT"), text());
    }
    // Either way there is nothing left to send, so the run itself is not an error.
    assertEquals(third, 0, text());
  });

  await t.step(
    `${mode}: the tool's own fee bump is recognised, not taken for a stranger`,
    async () => {
      const options: RegtestTransportOptions = { txindex, sent: [] };
      const { cli, planId } = await prepare(h, wallets.own, options, true);
      const { run, text } = cli;
      const { dir, plan } = await readPlan(cli.dir, planId);
      assertEquals(await run("bump", planId, "--fee-rate", "ecx=6,xbt=6", "--yes"), 0, text());
      const bumpId = (await planIds(cli.dir)).find((id) => id !== planId)!;
      const bumped = await readPlan(cli.dir, bumpId);
      await signPlan(bumped.dir, bumped.plan, wallets.own.keys);
      assertEquals(await run("verify", bumpId), 0, text());
      assertEquals(await run("broadcast", bumpId, "--yes"), 0, text());
      for (const when of ["while the replacement is in the mempool", "once it is mined"]) {
        if (when.startsWith("once")) {
          for (const c of ["ecx", "xbt"] as const) await mine(h, c, 2);
        }
        const code = await run("track", planId);
        if (debug) {
          console.log(`--- track ${when} (exit ${code})\n${text()}`);
        }
        assertEquals(code, 0, `${when}: ${text()}`);
        assert(text().includes(`REPLACED by plan ${bumpId}`), `${when}: ${text()}`);
        assert(!text().includes("CONFLICT"), `${when}: ${text()}`);
        for (const tx of plan.transactions) {
          assertEquals((await readProgress(dir)).txs[tx.file].broadcast?.status, "replaced", when);
        }
      }
    },
  );

  await t.step(`${mode}: a stranger's spend of the coin is never sent over`, async () => {
    const options: RegtestTransportOptions = { txindex, sent: [] };
    const { cli, planId } = await prepare(h, wallets.conflict, options);
    const { run, text } = cli;
    const { dir, plan } = await readPlan(cli.dir, planId);
    const [first] = plan.transactions.filter((x) => x.chain === "ecx" && x.testFirst);
    // Another machine spends the same coin on ECX and it confirms before this plan is sent.
    const foreign = foreignSpendHex(
      await Deno.readTextFile(join(dir, first.file)),
      wallets.conflict.keys,
    );
    await ecx.call("generateblock", await h.minerAddr("ecx"), [foreign]);
    await mine(h, "ecx", 2);
    const code = await run("broadcast", planId, "--yes");
    if (debug) console.log(`--- broadcast (exit ${code})\n${text()}`);
    assertEquals(code, 1, text());
    assertEquals(options.sent!.filter((s) => s.chain === "ecx").length, 0, `not sent: ${text()}`);
    const status = (await readProgress(dir)).txs[first.file].broadcast?.status;
    assertEquals(status, "conflict", text());
    assert(text().includes("an input is no longer unspent on ECX; not sending"), text());
    if (txindex) {
      assert(text().includes("spent by another transaction"), text());
    } else {
      // The node says the coin is gone, not who took it: no spender is named.
      assert(text().includes("is gone"), text());
      assert(!text().includes("spent by another transaction"), text());
    }
  });
}

/** init -> import -> scan -> dest -> plan -> sign -> verify; optionally broadcast everything. */
async function prepare(
  h: Harness,
  w: ScenarioWallet,
  options: RegtestTransportOptions,
  sendAll = false,
) {
  if (sendAll) {
    const r = await broadcastWallet(h, w, "ecx=2,xbt=2", options);
    return { cli: r.cli, planId: r.planId, dir: r.dir };
  }
  const cli = await makeCli(h.nodes, options);
  const { run, text } = cli;
  assertEquals(await run("init", "--yes"), 0, text());
  for (const d of w.descriptors) assertEquals(await run("import", d), 0, text());
  assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
  assertEquals(await run("dest", "set", "ecx", h.ecxDest), 0, text());
  assertEquals(await run("dest", "set", "xbt", h.xbtDest), 0, text());
  assertEquals(
    await run("plan", "--xbt-signer", "knots", "--fee-rate", "ecx=2,xbt=2", "--yes"),
    0,
    text(),
  );
  const [planId] = await planIds(cli.dir);
  const { dir, plan } = await readPlan(cli.dir, planId);
  await signPlan(dir, plan, w.keys);
  assertEquals(await run("verify", planId), 0, text());
  return { cli, planId, dir };
}
