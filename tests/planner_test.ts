import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer";
import { type CliIO, main } from "../src/cli/main.ts";
import { toHex } from "../src/core/bytes.ts";
import { parseDescriptor } from "../src/core/descriptors.ts";
import { estimateVsize } from "../src/core/planner.ts";
import {
  decodePsbt,
  findValues,
  IN_BIP32_DERIVATION,
  IN_NON_WITNESS_UTXO,
  sighashTypeOf,
} from "../src/core/psbt.ts";
import type { ChainId } from "../src/core/profiles.ts";
import { parseTx } from "../src/core/tx.ts";
import { type FakeChain, fakeChain, FakeEsploraTransport, fund, spendReal } from "./fakes.ts";

const seed = (words: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(words));
const SOURCE = seed(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const OTHER = seed("legal winner thank year wave sausage worth useful legal winner thank yellow");
const fp = (k: HDKey) => k.fingerprint.toString(16).padStart(8, "0");
const SRC_DESC = `wpkh([${fp(SOURCE)}/84h/0h/0h]${
  SOURCE.derive("m/84'/0'/0'").publicExtendedKey
}/<0;1>/*)`;
const ECX_DEST = `wpkh([${fp(OTHER)}/84h/0h/0h]${
  OTHER.derive("m/84'/0'/0'").publicExtendedKey
}/0/*)`;
const XBT_DEST = `tr([${fp(OTHER)}/86h/0h/0h]${OTHER.derive("m/86'/0'/0'").publicExtendedKey}/0/*)`;
const src = parseDescriptor(SRC_DESC);

function harness(chains: Record<ChainId, FakeChain>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: () => true,
    env: {},
    transportFactory: (_c, chain) => new FakeEsploraTransport(chains[chain]),
  };
  return { io, text: () => out.join("\n"), errors: () => err.join("\n") };
}

async function setup() {
  const btc = fakeChain("btc", 975_000);
  const xbt = fakeChain("xbt", 970_000);
  const ecx = fakeChain("ecx", 974_500);
  const all = [btc, xbt, ecx];
  const at = (branch: number, i: number) => src.branches[branch].derive(i);
  const a = fund(all, [{ ...at(0, 0), value: 100_000 }], 900_000, 1);
  const b = fund(all, [{ ...at(0, 1), value: 250_000 }], 900_100, 2);
  const c = fund(all, [{ ...at(1, 0), value: 400_000 }], 900_200, 3);
  spendReal(xbt, c, 0, 965_000, 4);
  spendReal(ecx, c, 0, 974_000, 5);
  const chains = { btc, xbt, ecx };
  const dir = await Deno.makeTempDir({ prefix: "forksplit-plan-" });
  await Deno.writeTextFile(
    join(dir, "forksplit.toml"),
    "[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n",
  );
  const h = harness(chains);
  const run = (...args: string[]) => main(["--data-dir", dir, ...args], h.io);
  assertEquals(await run("init", "--yes"), 0);
  assertEquals(await run("import", SRC_DESC), 0);
  assertEquals(await run("scan"), 0);
  return { chains, dir, h, run, coins: { a, b, c } };
}

async function readPlan(dir: string) {
  const plansDir = join(dir, "plans");
  const ids: string[] = [];
  for await (const e of Deno.readDir(plansDir)) ids.push(e.name);
  ids.sort();
  const planDir = join(plansDir, ids[ids.length - 1]);
  return { planDir, plan: JSON.parse(await Deno.readTextFile(join(planDir, "plan.json"))) };
}

Deno.test("plan refuses XBT without a declared 0x21 signer, and needs destinations", async () => {
  const { run, h } = await setup();
  assertEquals(await run("plan", "--fee-rate", "ecx=2,xbt=3", "--yes"), 1);
  assert(h.errors().includes("stock hardware wallets"));
  assertEquals(await run("plan", "--chains", "ecx", "--fee-rate", "ecx=2", "--yes"), 1);
  assert(h.errors().includes("dest set ecx"));
});

Deno.test("plan: ECX marker and XBT 0x21 are stamped; prev txs verified; dest indexes reserved", async () => {
  const { run, dir, coins, h } = await setup();
  assertEquals(await run("dest", "set", "ecx", ECX_DEST), 0);
  assertEquals(await run("dest", "set", "xbt", XBT_DEST), 0);
  assertEquals(
    await run("plan", "--xbt-signer", "knots", "--fee-rate", "ecx=2,xbt=3", "--yes"),
    0,
    h.errors(),
  );
  const { planDir, plan } = await readPlan(dir);
  assertEquals(plan.route, "forks-first-0x21");
  // Two shared coins (a, b) on each fork; c is already separated.
  const ecxTxs = plan.transactions.filter((t: { chain: string }) => t.chain === "ecx");
  const xbtTxs = plan.transactions.filter((t: { chain: string }) => t.chain === "xbt");
  assertEquals(ecxTxs.length, 2);
  assertEquals(xbtTxs.length, 2);
  assert(
    !plan.transactions.some((t: { inputs: { txid: string }[] }) =>
      t.inputs.some((i) => i.txid === coins.c)
    ),
  );
  // Smallest coin first, marked as the test transaction.
  assertEquals(ecxTxs[0].inputs[0].txid, coins.a);
  assertEquals(ecxTxs[0].testFirst, true);

  const ecxDest = parseDescriptor(ECX_DEST).branches[0];
  const xbtDest = parseDescriptor(XBT_DEST).branches[0];
  for (const t of ecxTxs) {
    const psbt = decodePsbt(await Deno.readTextFile(join(planDir, t.file)));
    assertEquals(psbt.tx.lockTime, 499_999_998);
    assert(psbt.tx.inputs.every((i) => i.sequence === 0xfffffffd));
    assertEquals(sighashTypeOf(psbt.inputs[0]), undefined);
    // Full previous transaction included and correct.
    const [prev] = findValues(psbt.inputs[0], IN_NON_WITNESS_UTXO);
    assertEquals(parseTx(prev.value).outputs[0].value, BigInt(t.inputs[0].value));
    // BIP32 origin for the signer: fingerprint + m/84'/0'/0'/0/i.
    const [deriv] = findValues(psbt.inputs[0], IN_BIP32_DERIVATION);
    assertEquals(toHex(deriv.value.subarray(0, 4)), fp(SOURCE));
  }
  assertEquals(ecxTxs.map((t: { output: { address: string } }) => t.output.address), [
    ecxDest.derive(0).address,
    ecxDest.derive(1).address,
  ]);
  for (const t of xbtTxs) {
    const psbt = decodePsbt(await Deno.readTextFile(join(planDir, t.file)));
    assertEquals(psbt.tx.lockTime, 0);
    assert(psbt.inputs.every((m) => sighashTypeOf(m) === 0x21));
  }
  assertEquals(xbtTxs[0].output.address, xbtDest.derive(0).address);
  // Fee arithmetic: 1 P2WPKH in -> 1 P2WPKH out at 2 sat/vB.
  assertEquals(ecxTxs[0].vsize, estimateVsize([{ kind: "wpkh" }], 22, false));
  assertEquals(ecxTxs[0].output.value, 100_000 - ecxTxs[0].fee);

  // Re-planning never reuses destination addresses.
  assertEquals(await run("plan", "--chains", "ecx", "--fee-rate", "ecx=2", "--yes"), 0);
  const second = (await readPlan(dir)).plan;
  assertEquals(second.transactions[0].output.address, ecxDest.derive(2).address);
});

Deno.test("plan: the ECX PSBT is signable by a stock signer and keeps the replay marker", async () => {
  const { run, dir } = await setup();
  await run("dest", "set", "ecx", ECX_DEST);
  assertEquals(await run("plan", "--chains", "ecx", "--fee-rate", "ecx=2", "--yes"), 0);
  const { planDir, plan } = await readPlan(dir);
  const t = plan.transactions[0];
  // @scure/btc-signer stands in for any ordinary PSBT signer.
  const tx = Transaction.fromPSBT(
    Uint8Array.from(
      atob((await Deno.readTextFile(join(planDir, t.file))).trim()),
      (c) => c.charCodeAt(0),
    ),
  );
  tx.signIdx(SOURCE.derive("m/84'/0'/0'/0/0").privateKey!, 0);
  tx.finalize();
  const signed = parseTx(tx.extract());
  assertEquals(signed.lockTime, 499_999_998);
  assertEquals(signed.inputs[0].sequence, 0xfffffffd);
  assertEquals(tx.id, t.unsignedTxid);
});

Deno.test("plan: --batch all combines coins and says so", async () => {
  const { run, dir, h } = await setup();
  await run("dest", "set", "ecx", ECX_DEST);
  assertEquals(
    await run("plan", "--chains", "ecx", "--batch", "all", "--fee-rate", "ecx=2", "--yes"),
    0,
  );
  const { plan } = await readPlan(dir);
  assertEquals(plan.transactions.length, 1);
  assertEquals(plan.transactions[0].inputs.length, 2);
  assert(h.text().includes("publicly linking"));
});

Deno.test("plan skips coins that changed since the scan", async () => {
  const { run, dir, chains, coins, h } = await setup();
  await run("dest", "set", "ecx", ECX_DEST);
  spendReal(chains.ecx, coins.a, 0, undefined, 9); // someone spent it on ECX since the scan
  assertEquals(await run("plan", "--chains", "ecx", "--fee-rate", "ecx=2", "--yes"), 0);
  const { plan } = await readPlan(dir);
  assertEquals(plan.transactions.length, 1);
  assertEquals(plan.transactions[0].inputs[0].txid, coins.b);
  assert(h.errors().includes("now spent"));
});
