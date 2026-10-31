import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { Transaction } from "@scure/btc-signer";
import { concatBytes, fromHex, toHex } from "../../src/core/bytes.ts";
import {
  decodePsbt,
  encodePsbtBase64,
  findValues,
  IN_BIP32_DERIVATION,
  IN_SIGHASH_TYPE,
  IN_WITNESS_UTXO,
  kv,
} from "../../src/core/psbt.ts";
import { unifiedSignatureHash } from "../../src/core/unified_sighash.ts";

/** Private keys by compressed public key (hex) for the test wallet's receive branch. */
export function keyMap(account: HDKey, count = 8): Map<string, Uint8Array> {
  return new Map(
    Array.from({ length: count }, (_, i) => {
      const k = account.deriveChild(0).deriveChild(i);
      return [toHex(k.publicKey!), k.privateKey!] as const;
    }),
  );
}

/** An ordinary wallet: signs every input it has a key for with SIGHASH_ALL (what ECX needs). */
export function stockSign(b64: string, keys: Map<string, Uint8Array>): string {
  const tx = Transaction.fromPSBT(Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0)));
  for (let i = 0; i < tx.inputsLength; i++) {
    for (const [pub, priv] of keys) {
      if (tx.getInput(i).bip32Derivation?.some(([p]) => toHex(p) === pub)) tx.signIdx(priv, i);
    }
  }
  return btoa(String.fromCharCode(...tx.toPSBT()));
}

/** A SIGHASH_UNIFIED signer for P2WPKH inputs (what Knots/Shrike do). hashType 0x21 = ALL|UNIFIED. */
export function unifiedSign(b64: string, keys: Map<string, Uint8Array>, hashType = 0x21): string {
  const psbt = decodePsbt(b64);
  const spent = psbt.inputs.map((m) => {
    const v = findValues(m, IN_WITNESS_UTXO)[0].value;
    return {
      amount: new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true),
      script: v.slice(9),
    };
  });
  const utx = {
    version: psbt.tx.version,
    lockTime: psbt.tx.lockTime,
    inputs: psbt.tx.inputs.map((i) => ({
      txid: fromHex(i.txid),
      index: i.vout,
      sequence: i.sequence,
    })),
    outputs: psbt.tx.outputs.map((o) => ({ amount: o.value, script: o.script })),
  };
  psbt.inputs.forEach((m, i) => {
    const pub = findValues(m, IN_BIP32_DERIVATION)[0].key.slice(1);
    const code = concatBytes(
      Uint8Array.of(0x76, 0xa9, 0x14),
      spent[i].script.slice(2),
      Uint8Array.of(0x88, 0xac),
    );
    const digest = unifiedSignatureHash(utx, i, hashType, spent, {
      scriptType: 1,
      scriptCode: code,
    })!;
    const der = secp256k1.sign(digest, keys.get(toHex(pub))!, {
      prehash: false,
      format: "der",
      lowS: true,
    });
    m.push(kv(0x02, pub, concatBytes(der, Uint8Array.of(hashType))));
  });
  return encodePsbtBase64(psbt);
}

/** A signer that doesn't know SIGHASH_UNIFIED: it drops the 0x21 request and signs plain ALL. */
export function ignoresUnifiedSign(b64: string, keys: Map<string, Uint8Array>): string {
  const psbt = decodePsbt(b64);
  psbt.inputs = psbt.inputs.map((m) => m.filter((e) => e.key[0] !== IN_SIGHASH_TYPE));
  return stockSign(encodePsbtBase64(psbt), keys);
}
