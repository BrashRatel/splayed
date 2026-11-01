import { assert, assertEquals } from "./assert.ts";
import { carriesUnifiedSignature, proveFunding } from "../src/core/origin.ts";
import { serializeTx, type Tx, txid, type TxInput } from "../src/core/tx.ts";
import { toHex } from "../src/core/bytes.ts";

/** A DER-looking signature (not a valid one: only its shape and last byte matter here). */
function derSig(sighash: number): Uint8Array {
  const out = new Uint8Array(72);
  out[0] = 0x30;
  out[1] = 72 - 3;
  out[2] = 0x02;
  out[71] = sighash;
  return out;
}

const spend = (parent: string, witness: Uint8Array[]): TxInput => ({
  txid: parent,
  vout: 0,
  scriptSig: new Uint8Array(),
  sequence: 0xffff_fffd,
  witness,
});
const mk = (inputs: TxInput[]): Tx => ({
  version: 2,
  inputs,
  outputs: [{ value: 1000n, script: Uint8Array.from([0, 20, ...new Uint8Array(20)]) }],
  lockTime: 0,
});
const coinbase = (n: number): Tx =>
  mk([{
    txid: "0".repeat(64),
    vout: 0xffff_ffff,
    scriptSig: Uint8Array.from([1, n]),
    sequence: 0xffff_ffff,
    witness: [],
  }]);

class Chain {
  txs = new Map<string, Tx>();
  add(tx: Tx): string {
    const id = txid(tx);
    this.txs.set(id, tx);
    return id;
  }
  deps(home: "xbt" | "btc", absent = true, own = new Set<string>()) {
    return {
      home,
      rawTransaction: (id: string) => {
        const tx = this.txs.get(id);
        if (!tx) return Promise.reject(new Error("unknown tx"));
        return Promise.resolve(toHex(serializeTx(tx)));
      },
      absentElsewhere: () => Promise.resolve(absent),
      ownProtected: own,
    };
  }
}

Deno.test("origin: a 0x21 signature is detected, plain ones are not", () => {
  assert(carriesUnifiedSignature(mk([spend("aa".repeat(32), [derSig(0x21), new Uint8Array(33)])])));
  assert(
    !carriesUnifiedSignature(mk([spend("aa".repeat(32), [derSig(0x01), new Uint8Array(33)])])),
  );
  // A 33-byte pubkey or a random 72-byte blob is not a signature.
  const blob = new Uint8Array(72).fill(0x21);
  assert(!carriesUnifiedSignature(mk([spend("aa".repeat(32), [blob, new Uint8Array(33)])])));
  // Taproot key path: one 65-byte item.
  const schnorr = new Uint8Array(65);
  schnorr[64] = 0x21;
  assert(carriesUnifiedSignature(mk([spend("aa".repeat(32), [schnorr])])));
  // Two items of 65 bytes is a script path, not a key path: not counted.
  assert(!carriesUnifiedSignature(mk([spend("aa".repeat(32), [schnorr, new Uint8Array(33)])])));
});

Deno.test("origin: coinbase funding is proven only when absent on the other chains", async () => {
  const c = new Chain();
  const cb = c.add(coinbase(1));
  const f = c.add(mk([spend(cb, [derSig(0x01), new Uint8Array(33)])]));
  assertEquals((await proveFunding(f, c.deps("xbt"))).ok, true);
  const shared = await proveFunding(f, c.deps("xbt", false));
  assertEquals(shared.ok, false);
});

Deno.test("origin: a chain of donor spends back to a coinbase is followed", async () => {
  const c = new Chain();
  let id = c.add(coinbase(2));
  for (let i = 0; i < 4; i++) id = c.add(mk([spend(id, [derSig(0x01), new Uint8Array(33)])]));
  const ok = await proveFunding(id, c.deps("btc"));
  assert(ok.ok);
  // Too far for the search limit.
  const far = await proveFunding(id, c.deps("btc"), { depth: 2, fetches: 40 });
  assertEquals(far.ok, false);
});

Deno.test("origin: a plain-signed spend of an unproven coin is unproven; a 0x21 one is proven", async () => {
  const c = new Chain();
  const shared = c.add(mk([spend("bb".repeat(32), [derSig(0x01), new Uint8Array(33)])]));
  const plain = c.add(mk([spend(shared, [derSig(0x01), new Uint8Array(33)])]));
  const plainResult = await proveFunding(plain, c.deps("xbt"));
  assertEquals(plainResult.ok, false);
  const protectedTx = c.add(mk([spend(shared, [derSig(0x21), new Uint8Array(33)])]));
  assertEquals((await proveFunding(protectedTx, c.deps("xbt"))).ok, true);
  // BTC has no 0x21: the same transaction proves nothing on the BTC side.
  assertEquals((await proveFunding(protectedTx, c.deps("btc"))).ok, false);
});

Deno.test("origin: a transaction this tool verified counts", async () => {
  const c = new Chain();
  const t = c.add(mk([spend("cc".repeat(32), [derSig(0x01), new Uint8Array(33)])]));
  assertEquals((await proveFunding(t, c.deps("xbt", true, new Set([t])))).ok, true);
});
