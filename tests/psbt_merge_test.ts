import { assert, assertEquals, assertThrows } from "./assert.ts";
import {
  decodePsbt,
  encodePsbt,
  IN_FINAL_SCRIPTWITNESS,
  kv,
  mergePsbts,
  type Psbt,
} from "../src/core/psbt.ts";
import type { Tx } from "../src/core/tx.ts";
import { toHex } from "../src/core/bytes.ts";

const tx = (vout: number): Tx => ({
  version: 2,
  inputs: [{
    txid: "11".repeat(32),
    vout,
    scriptSig: new Uint8Array(),
    sequence: 0xfffffffd,
    witness: [],
  }],
  outputs: [{ value: 1000n, script: Uint8Array.of(0x00, 0x14, ...new Array(20).fill(7)) }],
  lockTime: 0,
});
const sig = (pub: number, body: number) =>
  kv(0x02, Uint8Array.of(2, pub, ...new Array(32).fill(pub)), Uint8Array.of(body, 1));
const psbt = (vout: number, ...entries: ReturnType<typeof kv>[]): Psbt => ({
  tx: tx(vout),
  global: [],
  inputs: [entries],
  outputs: [[]],
});
const sigsOf = (p: Psbt) =>
  p.inputs[0].filter((e) => e.key[0] === 0x02).map((e) => e.key[2]).sort();

Deno.test("mergePsbts: signatures from separate signers add up, and survive a round trip", () => {
  const utxo = kv(0x01, new Uint8Array(), Uint8Array.of(1, 2, 3));
  const merged = mergePsbts(psbt(0, utxo, sig(10, 1)), psbt(0, sig(20, 2)));
  assertEquals(sigsOf(merged), [10, 20]);
  assert(merged.inputs[0].some((e) => e.key[0] === 0x01), "fields only one side had are kept");
  assertEquals(sigsOf(decodePsbt(encodePsbt(merged))), [10, 20]);
  // Order doesn't matter, and merging the same signer twice keeps one (the newer) signature.
  assertEquals(sigsOf(mergePsbts(psbt(0, sig(20, 2)), psbt(0, utxo, sig(10, 1)))), [10, 20]);
  const again = mergePsbts(psbt(0, sig(10, 1)), psbt(0, sig(10, 9)));
  assertEquals(sigsOf(again), [10]);
  assertEquals(toHex(again.inputs[0][0].value), "0901");
});

Deno.test("mergePsbts: a finalized input stays finalized; different transactions are refused", () => {
  const final = kv(IN_FINAL_SCRIPTWITNESS, new Uint8Array(), Uint8Array.of(0));
  for (
    const [a, b] of [[psbt(0, final), psbt(0, sig(10, 1))], [psbt(0, sig(10, 1)), psbt(0, final)]]
  ) {
    const m = mergePsbts(a, b);
    assertEquals(m.inputs[0].length, 1);
    assertEquals(m.inputs[0][0].key[0], IN_FINAL_SCRIPTWITNESS);
  }
  assertThrows(
    () => mergePsbts(psbt(0, sig(10, 1)), psbt(1, sig(20, 2))),
    Error,
    "different transactions",
  );
});
