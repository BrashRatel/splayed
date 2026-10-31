import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { Transaction } from "@scure/btc-signer";
import { taprootTweakPrivKey } from "@scure/btc-signer/utils.js";
import { concatBytes, fromHex, toHex } from "../../src/core/bytes.ts";
import {
  decodePsbt,
  encodePsbtBase64,
  findValues,
  IN_BIP32_DERIVATION,
  IN_NON_WITNESS_UTXO,
  IN_REDEEM_SCRIPT,
  IN_SIGHASH_TYPE,
  IN_TAP_INTERNAL_KEY,
  IN_TAP_KEY_SIG,
  IN_WITNESS_SCRIPT,
  IN_WITNESS_UTXO,
  kv,
} from "../../src/core/psbt.ts";
import { parseTx } from "../../src/core/tx.ts";
import {
  UNIFIED_SCRIPT_TYPE_TAPROOT,
  unifiedSignatureHash,
} from "../../src/core/unified_sighash.ts";

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
    const input = tx.getInput(i);
    for (const [pub, priv] of keys) {
      const listed = input.bip32Derivation?.some(([p]) => toHex(p) === pub);
      // Taproot key-path inputs name only the x-only internal key.
      const internal = input.tapInternalKey && toHex(input.tapInternalKey) === pub.slice(2);
      if (listed || internal) tx.signIdx(priv, i);
    }
  }
  return btoa(String.fromCharCode(...tx.toPSBT()));
}

/**
 * A SIGHASH_UNIFIED signer (what Knots/Shrike do) for P2PKH, P2SH multisig, P2WPKH, P2WSH, P2SH-wrapped
 * segwit and Taproot key-path inputs. Every
 * key in `keys` that the PSBT lists for an input adds a partial signature, so a multisig input
 * collects one signature per cosigner key given. hashType 0x21 = ALL|UNIFIED.
 */
export function unifiedSign(b64: string, keys: Map<string, Uint8Array>, hashType = 0x21): string {
  const psbt = decodePsbt(b64);
  const spent = psbt.inputs.map((m, i) => {
    const witness = findValues(m, IN_WITNESS_UTXO)[0]?.value;
    if (witness) {
      return {
        amount: new DataView(witness.buffer, witness.byteOffset, 8).getBigUint64(0, true),
        script: witness.slice(9),
      };
    }
    // Legacy inputs carry the whole previous transaction instead.
    const prev = parseTx(findValues(m, IN_NON_WITNESS_UTXO)[0].value);
    const out = prev.outputs[psbt.tx.inputs[i].vout];
    return { amount: out.value, script: out.script };
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
    const internalKey = findValues(m, IN_TAP_INTERNAL_KEY)[0]?.value;
    if (internalKey) {
      // Taproot key path: Schnorr over the unified digest, with the BIP341-tweaked key.
      const entry = [...keys].find(([pub]) => pub.slice(2) === toHex(internalKey));
      if (!entry) return;
      const digest = unifiedSignatureHash(utx, i, hashType, spent, {
        scriptType: UNIFIED_SCRIPT_TYPE_TAPROOT,
      })!;
      const sig = schnorr.sign(digest, taprootTweakPrivKey(entry[1]));
      m.push(kv(IN_TAP_KEY_SIG, new Uint8Array(), concatBytes(sig, Uint8Array.of(hashType))));
      return;
    }
    const witnessScript = findValues(m, IN_WITNESS_SCRIPT)[0]?.value;
    const redeemScript = findValues(m, IN_REDEEM_SCRIPT)[0]?.value;
    const segwit = findValues(m, IN_WITNESS_UTXO).length > 0;
    let code: Uint8Array;
    if (!segwit) {
      // Legacy: P2PKH signs the output script, P2SH multisig signs the redeem script.
      code = redeemScript ?? spent[i].script;
    } else if (witnessScript) {
      code = witnessScript; // P2WSH and P2SH-P2WSH
    } else {
      // P2WPKH signs the implied P2PKH script; for P2SH-P2WPKH the key hash is in the redeem script.
      code = concatBytes(
        Uint8Array.of(0x76, 0xa9, 0x14),
        (redeemScript ?? spent[i].script).slice(2, 22),
        Uint8Array.of(0x88, 0xac),
      );
    }
    const digest = unifiedSignatureHash(utx, i, hashType, spent, {
      scriptType: segwit ? 1 : 0,
      scriptCode: code,
    })!;
    for (const entry of findValues(m, IN_BIP32_DERIVATION)) {
      const pub = entry.key.slice(1);
      const priv = keys.get(toHex(pub));
      if (!priv) continue;
      const der = secp256k1.sign(digest, priv, { prehash: false, format: "der", lowS: true });
      m.push(kv(0x02, pub, concatBytes(der, Uint8Array.of(hashType))));
    }
  });
  return encodePsbtBase64(psbt);
}

/** A signer that doesn't know SIGHASH_UNIFIED: it drops the 0x21 request and signs plain ALL. */
export function ignoresUnifiedSign(b64: string, keys: Map<string, Uint8Array>): string {
  const psbt = decodePsbt(b64);
  psbt.inputs = psbt.inputs.map((m) => m.filter((e) => e.key[0] !== IN_SIGHASH_TYPE));
  return stockSign(encodePsbtBase64(psbt), keys);
}
