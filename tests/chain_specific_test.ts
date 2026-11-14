import { assert, assertEquals } from "./assert.ts";
import { HDKey } from "@scure/bip32";
import {
  coinbaseHeight,
  ownHistoryFrom,
  proveChainSpecific,
  sharedHeight,
} from "../src/core/chain_specific.ts";
import { parseDescriptor } from "../src/core/descriptors.ts";
import { MAINNET } from "../src/core/profiles.ts";
import { classify, type CoinRecord } from "../src/core/state.ts";
import { serializeTx, type Tx, txid, type TxInput } from "../src/core/tx.ts";
import { toHex } from "../src/core/bytes.ts";
import { runScan } from "../src/core/scan.ts";
import { loadConfig } from "../src/core/config.ts";
import { EsploraBackend } from "../src/backends/esplora.ts";
import { type FakeChain, fakeChain, FakeEsploraTransport } from "./fakes.ts";
import type { OutputObservation } from "../src/backends/types.ts";

/** A DER-looking signature: only its shape and sighash byte matter to the checks. */
function derSig(sighash: number): Uint8Array {
  const out = new Uint8Array(72);
  out[0] = 0x30;
  out[1] = 72 - 3;
  out[2] = 0x02;
  out[71] = sighash;
  return out;
}
const input = (parent: string, sighash = 0x01, sequence = 0xffff_fffd): TxInput => ({
  txid: parent,
  vout: 0,
  scriptSig: new Uint8Array(),
  sequence,
  witness: [derSig(sighash), new Uint8Array(33)],
});
const P2WPKH = Uint8Array.from([0, 20, ...new Uint8Array(20)]);
const tx = (inputs: TxInput[], lockTime = 0, script = P2WPKH): Tx => ({
  version: 2,
  inputs,
  outputs: [{ value: 1000n, script }],
  lockTime,
});
/** A coinbase committing to `height` the BIP34 way (minimal little-endian push). */
const coinbase = (height: number): Tx => {
  const bytes: number[] = [];
  for (let h = height; h > 0; h = Math.floor(h / 256)) bytes.push(h % 256);
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return tx([{
    txid: "0".repeat(64),
    vout: 0xffff_ffff,
    scriptSig: Uint8Array.from([bytes.length, ...bytes, 0x00]),
    sequence: 0xffff_ffff,
    witness: [],
  }]);
};

class Txs {
  map = new Map<string, Tx>();
  add(t: Tx): string {
    const id = txid(t);
    this.map.set(id, t);
    return id;
  }
  deps(own = new Set<string>()) {
    return {
      profile: MAINNET,
      rawTransaction: (id: string) => {
        const t = this.map.get(id);
        return t ? Promise.resolve(toHex(serializeTx(t))) : Promise.reject(new Error("unknown"));
      },
      ownProtected: own,
    };
  }
}
const PRE_FORK = "ab".repeat(32);

Deno.test("chain-specific: fork heights each pair of chains shares", () => {
  assertEquals(sharedHeight(MAINNET, "btc", "xbt"), 961_631);
  assertEquals(sharedHeight(MAINNET, "btc", "ecx"), 973_727);
  assertEquals(sharedHeight(MAINNET, "xbt", "ecx"), 961_631);
  assertEquals(ownHistoryFrom(MAINNET, "xbt"), 961_631);
  assertEquals(ownHistoryFrom(MAINNET, "ecx"), 973_727);
  assertEquals(ownHistoryFrom(MAINNET, "btc"), 973_727);
});

Deno.test("chain-specific: BIP34 coinbase heights, including OP_N and multi-byte pushes", () => {
  assertEquals(coinbaseHeight(coinbase(974_001)), 974_001);
  assertEquals(coinbaseHeight(coinbase(200)), 200); // 0xc8 needs a sign byte
  const opN = tx([{
    txid: "0".repeat(64),
    vout: 0xffff_ffff,
    scriptSig: Uint8Array.of(0x55, 0x00),
    sequence: 0xffff_ffff,
    witness: [],
  }]);
  assertEquals(coinbaseHeight(opN), 5);
});

Deno.test("chain-specific: an XBT 0x21 signature or the ECX marker proves it; plain spends don't", async () => {
  const t = new Txs();
  const unified = t.add(tx([input(PRE_FORK, 0x21)]));
  const xbt = await proveChainSpecific(unified, "xbt", t.deps());
  assert(xbt.ok);
  assertEquals(xbt.proof.kind, "replay-protected");
  assert(xbt.proof.via.includes("0x21"), xbt.proof.via);
  // The same signature byte means nothing on ECX, which has no such rule.
  assertEquals((await proveChainSpecific(unified, "ecx", t.deps())).ok, false);

  const marked = t.add(tx([input(PRE_FORK)], 499_999_998));
  const ecx = await proveChainSpecific(marked, "ecx", t.deps());
  assert(ecx.ok);
  assert(ecx.proof.via.includes("499999998"), ecx.proof.via);
  // The marker needs a non-final input to count.
  const final = t.add(tx([input(PRE_FORK, 0x01, 0xffff_ffff)], 499_999_998));
  assertEquals((await proveChainSpecific(final, "ecx", t.deps())).ok, false);

  // An ordinary transaction spending a pre-fork coin could be broadcast on any chain.
  const plain = t.add(tx([input(PRE_FORK)]));
  const no = await proveChainSpecific(plain, "xbt", t.deps());
  assert(!no.ok);
  assert(no.reason.includes("couldn't read"), no.reason); // the pre-fork parent isn't served
});

Deno.test("chain-specific: coinbases count only above the heights shared with every other chain", async () => {
  const t = new Txs();
  const xbtNew = t.add(coinbase(962_000));
  const r = await proveChainSpecific(xbtNew, "xbt", t.deps());
  assert(r.ok);
  assertEquals(r.proof.kind, "coinbase");
  // A BTC block at 965,000 is also an ECX block (ECX forked from BTC at 973,728).
  const btcMid = t.add(coinbase(965_000));
  assertEquals((await proveChainSpecific(btcMid, "btc", t.deps())).ok, false);
  const btcNew = t.add(coinbase(974_000));
  assertEquals((await proveChainSpecific(btcNew, "btc", t.deps())).ok, true);
  // Before the forks: every chain has that block.
  const old = t.add(coinbase(900_000));
  assertEquals((await proveChainSpecific(old, "xbt", t.deps())).ok, false);
});

Deno.test("chain-specific: protection carries down a chain of plain spends, and from own sends", async () => {
  const t = new Txs();
  const marked = t.add(tx([input(PRE_FORK)], 499_999_998));
  const child = t.add(tx([input(marked, 0x01, 0xffff_ffff)]));
  const grandchild = t.add(tx([input(child, 0x01, 0xffff_ffff), input(PRE_FORK)]));
  const r = await proveChainSpecific(grandchild, "ecx", t.deps());
  assert(r.ok, JSON.stringify(r));
  assertEquals(r.proof.kind, "inherited");
  assert(r.proof.via.includes("reached through an input"), r.proof.via);

  // A transaction this tool verified and sent is protected without being fetched.
  const ownSplit = "cd".repeat(32);
  const spendOfSplit = t.add(tx([input(ownSplit)]));
  const own = await proveChainSpecific(spendOfSplit, "xbt", t.deps(new Set([ownSplit])));
  assert(own.ok);
  assert(own.proof.via.includes("this tool verified and sent"), own.proof.via);

  // Ruling out only some chains isn't enough: a BTC coinbase at 965,000 isn't on XBT, but its
  // block is on ECX, so a spend of it could be broadcast there.
  const midCb = t.add(coinbase(965_000));
  const both = t.add(tx([input(midCb)]));
  assertEquals((await proveChainSpecific(both, "btc", t.deps())).ok, false);

  // The search is bounded: a long enough chain runs out.
  let id = marked;
  for (let i = 0; i < 6; i++) id = t.add(tx([input(id, 0x01, 0xffff_ffff)]));
  const far = await proveChainSpecific(id, "ecx", t.deps());
  assert(!far.ok);
  assert(far.reason.includes("search limit"), far.reason);
});

// ---- classification ----

const coin = (
  obs: Partial<Record<"btc" | "xbt" | "ecx", OutputObservation>>,
  onlyOn?: CoinRecord["onlyOn"],
): CoinRecord => ({
  txid: "aa".repeat(32),
  vout: 0,
  value: 5000,
  scriptPubKey: "51",
  observations: {
    btc: { state: "absent" },
    xbt: { state: "absent" },
    ecx: { state: "absent" },
    ...obs,
  },
  ...(onlyOn ? { onlyOn } : {}),
});
const ctx = {
  tips: { btc: 975_000, xbt: 975_000, ecx: 975_000 },
  confirmations: { btc: 6, xbt: 50, ecx: 50 },
};
const proof = { chain: "xbt" as const, kind: "replay-protected" as const, via: "a 0x21 signature" };
const onXbt: OutputObservation = { state: "unspent", value: 5000, createdHeight: 970_000 };

Deno.test("classify: a proven chain-specific coin is separated even when another chain can't be asked", () => {
  const unknownBtc = coin({ xbt: onXbt, btc: { state: "unknown", error: "timeout" } });
  assertEquals(classify(unknownBtc, ctx).status, "unverified");
  const proven = classify({ ...unknownBtc, onlyOn: proof }, ctx);
  assertEquals(proven.status, "separated");
  assertEquals(proven.chainSpecific, proof);
  assertEquals(proven.reasons, ["XBT only: created by a 0x21 signature"]);
  // "Spent or never existed" can only be "never existed".
  assertEquals(
    classify(coin({ xbt: onXbt, ecx: { state: "gone" } }, proof), ctx).status,
    "separated",
  );
});

Deno.test("classify: a proof contradicted by another chain is ignored", () => {
  const shared = classify(
    coin({ xbt: onXbt, btc: { state: "unspent", value: 5000, createdHeight: 9 } }, proof),
    ctx,
  );
  assertEquals(shared.status, "shared");
  assertEquals(shared.chainSpecific, undefined);
  // Once spent on its own chain the proof says nothing more: the observations decide.
  const spentHere = classify(
    coin({ xbt: { state: "spent", spendDetailKnown: true, spendHeight: 974_000 } }, proof),
    ctx,
  );
  assertEquals(spentHere.status, "spent");
  assertEquals(spentHere.chainSpecific, undefined);
});

// ---- the scan step ----

Deno.test("scan: proves single-chain coins after the fork, skips pre-fork ones, and records how", async () => {
  const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));
  const fp = master.fingerprint.toString(16).padStart(8, "0");
  const desc = parseDescriptor(
    `wpkh([${fp}/84h/0h/0h]${master.derive("m/84'/0'/0'").publicExtendedKey}/0/*)`,
  );
  const addr = (i: number) => desc.branches[0].derive(i);
  const chains = {
    btc: fakeChain("btc", 975_000),
    xbt: fakeChain("xbt", 975_000),
    ecx: fakeChain("ecx", 975_000),
  };
  const put = (c: FakeChain, t: Tx, height: number, address?: ReturnType<typeof addr>) => {
    const raw = toHex(serializeTx(t));
    const id = txid(t);
    c.txs.set(id, {
      vout: t.outputs.map((o) => ({ value: Number(o.value), scriptpubkey: toHex(o.script) })),
      height,
      raw,
    });
    if (address) {
      c.history.set(address.address, [...(c.history.get(address.address) ?? []), `${id}:0`]);
    }
    return id;
  };
  const script = (i: number) =>
    Uint8Array.from(addr(i).scriptPubKey.match(/../g)!.map((h) => parseInt(h, 16)));
  // 0: received on XBT through a 0x21-signed transaction.
  put(chains.xbt, tx([input(PRE_FORK, 0x21)], 0, script(0)), 970_000, addr(0));
  // 1: received on XBT through a plain transaction: absent elsewhere, but not provably.
  put(chains.xbt, tx([input(PRE_FORK)], 0, script(1)), 970_000, addr(1));
  // 2: received on ECX by a marked transaction; BTC's server is down for it.
  put(chains.ecx, tx([input(PRE_FORK)], 499_999_998, script(2)), 974_100, addr(2));
  // 3: a pre-fork coin, already split on BTC and ECX: nothing to prove, nothing fetched.
  const old = put(chains.xbt, tx([input("ef".repeat(32))], 0, script(3)), 900_000, addr(3));
  chains.btc.spends.set(`${old}:0`, { txid: "01".repeat(32), height: 974_000 });
  chains.ecx.spends.set(`${old}:0`, { txid: "02".repeat(32), height: 974_000 });
  put(chains.btc, tx([input("ef".repeat(32))], 0, script(3)), 900_000);
  put(chains.ecx, tx([input("ef".repeat(32))], 0, script(3)), 900_000);
  chains.btc.fail = new RegExp(`^/tx/${txid(tx([input(PRE_FORK)], 499_999_998, script(2)))}`);

  const config = await loadConfig({ dataDir: await Deno.makeTempDir(), env: {} });
  const backend = (chain: "btc" | "xbt" | "ecx") =>
    new EsploraBackend(
      chain,
      {
        kind: "esplora",
        url: "http://x/api",
        proxy: { kind: "tor" },
        role: "both",
        priority: 0,
        origin: "user",
      },
      new FakeEsploraTransport(chains[chain]),
    );
  const hexLookups = () => chains.xbt.requests.filter((r) => r.endsWith("/hex")).length;
  const result = await runScan(config, [desc], {
    backends: { btc: backend("btc"), xbt: backend("xbt"), ecx: backend("ecx") },
    sleep: () => Promise.resolve(),
  });
  const byIndex = (i: number) => result.coins.find((c) => c.derivationIndex === i)!;
  assertEquals(byIndex(0).onlyOn?.chain, "xbt");
  assertEquals(byIndex(0).onlyOn?.kind, "replay-protected");
  assertEquals(byIndex(1).onlyOn, undefined);
  assertEquals(byIndex(2).onlyOn?.chain, "ecx");
  assertEquals(byIndex(2).observations.btc.state, "unknown");
  assertEquals(
    classify(byIndex(2), { tips: result.tips, confirmations: { btc: 6, xbt: 50, ecx: 50 } }).status,
    "separated",
  );
  assertEquals(byIndex(3).onlyOn, undefined);
  // XBT: coin 0 (one fetch) and coin 1 (its own transaction, then its unknown parent).
  assertEquals(hexLookups(), 3, chains.xbt.requests.filter((r) => r.endsWith("/hex")).join("\n"));
});
