import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { type CliIO, main } from "../src/cli/main.ts";
import { fromHex, toHex } from "../src/core/bytes.ts";
import { parseDescriptor } from "../src/core/descriptors.ts";
import { linkedGroups, spentScript } from "../src/core/linkage.ts";
import { pushData, serializeTx, type Tx, txid, type TxInput } from "../src/core/tx.ts";
import type { ChainId } from "../src/core/profiles.ts";
import { type FakeChain, fakeChain, FakeEsploraTransport } from "./fakes.ts";

const SOURCE = HDKey.fromMasterSeed(mnemonicToSeedSync(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
));
const OTHER = HDKey.fromMasterSeed(
  mnemonicToSeedSync("legal winner thank year wave sausage worth useful legal winner thank yellow"),
);
const fp = (k: HDKey) => k.fingerprint.toString(16).padStart(8, "0");
const SRC_DESC = `wpkh([${fp(SOURCE)}/84h/0h/0h]${
  SOURCE.derive("m/84'/0'/0'").publicExtendedKey
}/<0;1>/*)`;
const ECX_DEST = `wpkh([${fp(OTHER)}/84h/0h/0h]${
  OTHER.derive("m/84'/0'/0'").publicExtendedKey
}/0/*)`;
const src = parseDescriptor(SRC_DESC);
const at = (branch: number, i: number) => src.branches[branch].derive(i);
const pubkeyOf = (branch: number, i: number) =>
  SOURCE.derive(`m/84'/0'/0'/${branch}/${i}`).publicKey!;

const sig = () => {
  const s = new Uint8Array(72);
  s.set([0x30, 69, 0x02]);
  s[71] = 0x01;
  return s;
};
/** An input spending `prev:vout` from a P2WPKH key, as a signed transaction shows it. */
const wpkhInput = (prev: string, pubkey: Uint8Array, vout = 0): TxInput => ({
  txid: prev,
  vout,
  scriptSig: new Uint8Array(),
  sequence: 0xffff_fffd,
  witness: [sig(), pubkey],
});
const payTo = (inputs: TxInput[], scripts: string[], value = 100_000): Tx => ({
  version: 2,
  inputs,
  outputs: scripts.map((s) => ({ value: BigInt(value), script: fromHex(s) })),
  lockTime: 0,
});

Deno.test("spentScript: P2WPKH, P2WSH, nested and P2PKH inputs; Taproot is unknown", () => {
  const pk = pubkeyOf(0, 3);
  assertEquals(spentScript(wpkhInput("aa".repeat(32), pk)), at(0, 3).scriptPubKey);
  // Nested P2WPKH: the scriptSig pushes the witness program.
  const program = fromHex(at(0, 3).scriptPubKey);
  const nested = { ...wpkhInput("aa".repeat(32), pk), scriptSig: pushData(program) };
  const shWpkh = spentScript(nested)!;
  assert(shWpkh.startsWith("a914") && shWpkh.endsWith("87"), shWpkh);
  // P2WSH multisig: the last witness item is the witness script.
  const ws = Uint8Array.of(0x51, 0x21, ...pk, 0x51, 0xae);
  const wsh = spentScript({
    ...wpkhInput("aa".repeat(32), pk),
    witness: [new Uint8Array(), sig(), ws],
  });
  assert(wsh!.startsWith("0020"), wsh);
  // P2PKH: <sig> <pubkey>.
  const pkh = spentScript({
    txid: "aa".repeat(32),
    vout: 0,
    scriptSig: Uint8Array.of(...pushData(sig()), ...pushData(pk)),
    sequence: 0xffff_ffff,
    witness: [],
  });
  assert(pkh!.startsWith("76a914") && pkh!.endsWith("88ac"), pkh);
  // Taproot key path: one 64-byte signature, nothing to read.
  assertEquals(
    spentScript({ ...wpkhInput("aa".repeat(32), pk), witness: [new Uint8Array(64)] }),
    undefined,
  );
});

Deno.test("linkedGroups: reuse, a shared funding address and siblings link; payments to you and coinjoins don't", async () => {
  const txs = new Map<string, Tx>();
  const add = (t: Tx) => {
    txs.set(txid(t), t);
    return txid(t);
  };
  const ours = new Set<string>();
  for (let i = 0; i < 20; i++) for (const b of [0, 1]) ours.add(at(b, i).scriptPubKey);
  const stranger = Uint8Array.of(0x02, ...new Uint8Array(32).fill(9));
  // T1: your wallet (address 0/5) pays itself two coins, 0/0 and 0/1.
  const t1 = add(
    payTo([wpkhInput("01".repeat(32), pubkeyOf(0, 5))], [
      at(0, 0).scriptPubKey,
      at(0, 1).scriptPubKey,
    ]),
  );
  // T2: spends 0/5 again (it held two coins) and 0/6 together, paying 1/0.
  const t2 = add(
    payTo(
      [wpkhInput("02".repeat(32), pubkeyOf(0, 5)), wpkhInput("03".repeat(32), pubkeyOf(0, 6))],
      [at(1, 0).scriptPubKey],
    ),
  );
  // T3: someone else pays you at 0/2.
  const t3 = add(payTo([wpkhInput("04".repeat(32), stranger)], [at(0, 2).scriptPubKey]));
  // T4: a coinjoin-like transaction: one of your inputs (0/6) and a stranger's, paying 0/3.
  const t4 = add(
    payTo([wpkhInput("05".repeat(32), pubkeyOf(0, 6)), wpkhInput("06".repeat(32), stranger)], [
      at(0, 3).scriptPubKey,
    ]),
  );
  // 0/2 again: address reuse links it to the coin T3 paid there.
  const t5 = add(payTo([wpkhInput("07".repeat(32), stranger)], [at(0, 2).scriptPubKey]));
  const coins = [
    { txid: t1, vout: 0, scriptPubKey: at(0, 0).scriptPubKey },
    { txid: t1, vout: 1, scriptPubKey: at(0, 1).scriptPubKey },
    { txid: t2, vout: 0, scriptPubKey: at(1, 0).scriptPubKey },
    { txid: t3, vout: 0, scriptPubKey: at(0, 2).scriptPubKey },
    { txid: t4, vout: 0, scriptPubKey: at(0, 3).scriptPubKey },
    { txid: t5, vout: 0, scriptPubKey: at(0, 2).scriptPubKey },
  ];
  const fetched: string[] = [];
  const r = await linkedGroups(coins, {
    ours,
    rawTransaction: (id) => {
      fetched.push(id);
      const t = txs.get(id);
      return t ? Promise.resolve(toHex(serializeTx(t))) : Promise.reject(new Error("no"));
    },
  });
  const sorted = r.groups.map((g) => g.sort()).sort((a, b) => a[0] - b[0]);
  assertEquals(sorted, [[0, 1, 2], [3, 5], [4]]);
  assertEquals(r.unread, 0);
  // Inputs read from their witnesses: only the coins' own creating transactions were fetched.
  assertEquals(fetched.length, 5);
});

Deno.test("linkedGroups: a funding transaction that can't be read links nothing", async () => {
  const r = await linkedGroups([
    { txid: "aa".repeat(32), vout: 0, scriptPubKey: at(0, 0).scriptPubKey },
    { txid: "bb".repeat(32), vout: 0, scriptPubKey: at(0, 1).scriptPubKey },
  ], {
    ours: new Set([at(0, 0).scriptPubKey]),
    rawTransaction: () => Promise.reject(new Error("x")),
  });
  assertEquals(r.groups.length, 2);
  assertEquals(r.unread, 2);
});

// ---- through `plan --batch linked` ----

Deno.test("plan --batch linked: one transaction per group of already-linked coins", async () => {
  const btc = fakeChain("btc", 975_000);
  const xbt = fakeChain("xbt", 970_000);
  const ecx = fakeChain("ecx", 974_500);
  const all = [btc, xbt, ecx];
  const put = (t: Tx, height: number) => {
    const id = txid(t);
    for (const c of all) {
      c.txs.set(id, {
        vout: t.outputs.map((o) => ({ value: Number(o.value), scriptpubkey: toHex(o.script) })),
        height,
        raw: toHex(serializeTx(t)),
      });
      t.outputs.forEach((o, i) => {
        const a = [0, 1].flatMap((b) => Array.from({ length: 10 }, (_, k) => at(b, k)))
          .find((x) => x.scriptPubKey === toHex(o.script));
        if (a) c.history.set(a.address, [...(c.history.get(a.address) ?? []), `${id}:${i}`]);
      });
    }
    return id;
  };
  const stranger = Uint8Array.of(0x03, ...new Uint8Array(32).fill(7));
  // Your own transaction made coins 0/0 and 0/1; someone else paid 0/2.
  const own = put(
    payTo([wpkhInput("01".repeat(32), pubkeyOf(0, 4))], [
      at(0, 0).scriptPubKey,
      at(0, 1).scriptPubKey,
    ]),
    900_000,
  );
  const paid = put(payTo([wpkhInput("02".repeat(32), stranger)], [at(0, 2).scriptPubKey]), 900_010);
  const chains: Record<ChainId, FakeChain> = { btc, xbt, ecx };
  const dir = await Deno.makeTempDir({ prefix: "splayed-linked-" });
  await Deno.writeTextFile(
    join(dir, "splayed.toml"),
    "[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n",
  );
  const err: string[] = [];
  const io: CliIO = {
    out: () => {},
    err: (t) => err.push(t),
    confirm: () => true,
    env: {},
    tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
    transportFactory: (_c, chain) => new FakeEsploraTransport(chains[chain]),
  };
  const run = (...args: string[]) => main(["--data-dir", dir, ...args], io);
  assertEquals(await run("init", "--yes"), 0);
  assertEquals(await run("import", SRC_DESC), 0);
  assertEquals(await run("scan"), 0, err.join("\n"));
  assertEquals(await run("dest", "set", "ecx", ECX_DEST), 0);
  assertEquals(
    await run("plan", "--chains", "ecx", "--batch", "linked", "--fee-rate", "ecx=2", "--yes"),
    0,
    err.join("\n"),
  );
  const ids: string[] = [];
  for await (const e of Deno.readDir(join(dir, "plans"))) ids.push(e.name);
  const plan = JSON.parse(await Deno.readTextFile(join(dir, "plans", ids[0], "plan.json")));
  assertEquals(plan.batch, { kind: "linked" });
  const inputs = plan.transactions.map((t: { inputs: { txid: string; vout: number }[] }) =>
    t.inputs.map((i) => `${i.txid === own ? "own" : i.txid === paid ? "paid" : "?"}:${i.vout}`)
      .sort()
  ).sort();
  assertEquals(inputs, [["own:0", "own:1"], ["paid:0"]]);
});
