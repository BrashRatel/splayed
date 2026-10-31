import { assert, assertEquals } from "./assert.ts";
import { Transaction } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { fromHex, toHex } from "../src/core/bytes.ts";
import { parseTx, serializeStripped, txid } from "../src/core/tx.ts";
import { decodePsbt, encodePsbt, IN_SIGHASH_TYPE, kv, sighashTypeOf } from "../src/core/psbt.ts";

Deno.test("tx: our txid matches @scure/btc-signer for a segwit transaction", () => {
  const t = new Transaction({ version: 2, lockTime: 499_999_998 });
  t.addInput({ txid: "11".repeat(32), index: 3, sequence: 0xfffffffd });
  t.addOutputAddress("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", 12_345n);
  const unsigned = t.unsignedTx;
  const parsed = parseTx(unsigned);
  assertEquals(parsed.lockTime, 499_999_998);
  assertEquals(parsed.inputs[0].txid, "11".repeat(32));
  assertEquals(parsed.inputs[0].vout, 3);
  assertEquals(txid(parsed), t.id);
  assertEquals(toHex(serializeStripped(parsed)), toHex(unsigned));
});

Deno.test("psbt: round trip keeps unknown fields and a 0x21 sighash type", () => {
  const tx = parseTx(
    new Transaction({ version: 2 }).unsignedTx.length
      ? (() => {
        const t = new Transaction({ version: 2 });
        t.addInput({ txid: "22".repeat(32), index: 0, sequence: 0xfffffffd });
        t.addOutput({ script: fromHex("0014" + "33".repeat(20)), amount: 1000n });
        return t.unsignedTx;
      })()
      : new Uint8Array(),
  );
  const psbt = {
    tx,
    global: [],
    inputs: [[
      kv(IN_SIGHASH_TYPE, new Uint8Array(), Uint8Array.of(0x21, 0, 0, 0)),
      kv(0xfc, Uint8Array.of(1, 2), Uint8Array.of(9)),
    ]],
    outputs: [[]],
  };
  const decoded = decodePsbt(encodePsbt(psbt));
  assertEquals(sighashTypeOf(decoded.inputs[0]), 0x21);
  assertEquals(decoded.inputs[0].length, 2);
  assertEquals(txid(decoded.tx), txid(tx));
});

export const TEST_SEED = mnemonicToSeedSync(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
export const TEST_MASTER = HDKey.fromMasterSeed(TEST_SEED);
assert(TEST_MASTER.privateKey);
