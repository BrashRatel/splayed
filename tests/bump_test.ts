import { assert, assertEquals, assertThrows } from "./assert.ts";
import {
  buildReplacement,
  BumpError,
  defaultBumpRate,
  INCREMENTAL_RELAY_FEE_RATE,
  minimumReplacementFee,
} from "../src/core/bump.ts";
import { fromHex } from "../src/core/bytes.ts";
import type { PlannedTx } from "../src/core/planner.ts";
import { decodePsbt, encodePsbtBase64, type Psbt } from "../src/core/psbt.ts";
import { txid } from "../src/core/tx.ts";

const SCRIPT = fromHex("0014" + "11".repeat(20)); // P2WPKH
const INPUT_VALUE = 1_000_000;

function fixture(feeRate = 2, vsize = 110): { old: PlannedTx; own: Psbt } {
  const fee = Math.ceil(vsize * feeRate);
  const own: Psbt = {
    tx: {
      version: 2,
      inputs: [{
        txid: "aa".repeat(32),
        vout: 0,
        scriptSig: new Uint8Array(),
        sequence: 0xffff_fffd,
        witness: [],
      }],
      outputs: [{ value: BigInt(INPUT_VALUE - fee), script: SCRIPT }],
      lockTime: 499_999_998,
    },
    global: [],
    inputs: [[]],
    outputs: [[]],
  };
  const old = {
    chain: "ecx",
    order: 1,
    testFirst: false,
    file: "ecx/001-old.psbt",
    unsignedTxid: txid(own.tx),
    inputs: [{ txid: "aa".repeat(32), vout: 0, value: INPUT_VALUE, kind: "wpkh" }],
    output: { address: "bc1qtest", value: INPUT_VALUE - fee, destinationIndex: 0 },
    fee,
    feeRate,
    vsize,
    lockTime: 499_999_998,
    sequence: 0xffff_fffd,
    psbt: encodePsbtBase64(own),
  } as PlannedTx;
  return { old, own };
}

const options = (f: ReturnType<typeof fixture>, feeRate: number) => ({
  oldPlanId: "plan1",
  old: f.old,
  oldTxid: "bb".repeat(32),
  own: f.own,
  feeRate,
  order: 1,
});

Deno.test("BIP125 minimum: old fee plus the incremental relay fee for the new size", () => {
  assertEquals(minimumReplacementFee(220, 110), 220 + 110 * INCREMENTAL_RELAY_FEE_RATE);
});

Deno.test("default bump rate is at least 1.5x the old rate and never below the BIP125 minimum", () => {
  const { old } = fixture(2, 110);
  assertEquals(defaultBumpRate(old), 3);
  assertEquals(defaultBumpRate(old, 10), 10); // a higher estimate wins
  // A tiny old rate: 1.5x is under the +1 sat/vB floor, so the floor applies.
  const small = fixture(1, 110).old;
  assert(defaultBumpRate(small) * small.vsize >= minimumReplacementFee(small.fee, small.vsize));
});

Deno.test("a replacement keeps inputs, sequence, locktime and destination; only the value moves", () => {
  const f = fixture();
  const r = buildReplacement(options(f, 5));
  assertEquals(r.fee, 550);
  assertEquals(r.output.value, INPUT_VALUE - 550);
  assertEquals(r.output.address, f.old.output.address);
  assert(r.unsignedTxid !== f.old.unsignedTxid);
  assertEquals(r.replaces, {
    plan: "plan1",
    file: "ecx/001-old.psbt",
    txid: "bb".repeat(32),
    fee: 220,
    feeRate: 2,
  });
  const psbt = decodePsbt(r.psbt);
  assertEquals(psbt.tx.lockTime, 499_999_998);
  assertEquals(psbt.tx.inputs.map((i) => [i.txid, i.vout, i.sequence]), [
    ["aa".repeat(32), 0, 0xffff_fffd],
  ]);
  assertEquals(psbt.tx.outputs[0].script, SCRIPT);
  assertEquals(psbt.tx.outputs[0].value, BigInt(INPUT_VALUE - 550));
  assertEquals(txid(psbt.tx), r.unsignedTxid);
  assert(r.file.includes(r.unsignedTxid.slice(0, 8)));
});

Deno.test("a rate that can't replace the original is refused with the minimum spelled out", () => {
  const f = fixture(); // fee 220 for 110 vB
  const error = assertThrows(() => buildReplacement(options(f, 2.5)), BumpError);
  assert(error.message.includes("at least 330 sats"), error.message);
  // Exactly the minimum is allowed.
  assertEquals(buildReplacement(options(f, 3)).fee, 330);
});

Deno.test("a bump that would leave dust or burn over 10% of the coin is refused", () => {
  const f = fixture();
  assertThrows(() => buildReplacement(options(f, 20_000)), BumpError); // 2.2M sat fee > value
  assertThrows(() => buildReplacement(options(f, 1_000)), BumpError); // 110k fee > 10%
});
