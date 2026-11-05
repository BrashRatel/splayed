import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { NETWORK, p2tr, Transaction } from "@scure/btc-signer";
import { hash160, sha256, taprootTweakPrivKey } from "@scure/btc-signer/utils.js";
import { concatBytes, fromHex, toHex, utf8 } from "../../src/core/bytes.ts";
import {
  decodePsbt,
  encodePsbtBase64,
  findValues,
  IN_BIP32_DERIVATION,
  IN_NON_WITNESS_UTXO,
  IN_REDEEM_SCRIPT,
  IN_SIGHASH_TYPE,
  IN_TAP_BIP32_DERIVATION,
  IN_TAP_INTERNAL_KEY,
  IN_TAP_KEY_SIG,
  IN_WITNESS_SCRIPT,
  IN_WITNESS_UTXO,
  kv,
} from "../../src/core/psbt.ts";
import { parseTx, txid } from "../../src/core/tx.ts";
import {
  UNIFIED_SCRIPT_TYPE_TAPROOT,
  unifiedSignatureHash,
} from "../../src/core/unified_sighash.ts";
import type { Rpc } from "./rpc.ts";

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

/** One hardware signer: the master fingerprint it reports and the keys it holds. */
export interface Device {
  fingerprint: string;
  keys: Map<string, Uint8Array>;
  /**
   * The wallet descriptor as this device holds it: its own key private (tprv), every other
   * cosigner's public (tpub), in the regtest nodes' encoding. For a node's own wallet to sign with.
   */
  descriptor: string;
}

/** What the person holding the device would check on its screen. */
export interface DeviceRules {
  /** Output scripts (hex) the person accepts as the destination. */
  allowedOutputs: Set<string>;
  /** The device refuses a fee above this share of the inputs' value. */
  maxFeeFraction: number;
}

export class DeviceRefusal extends Error {}

const hex = toHex;

/** The 33-byte keys of an OP_m <keys> OP_n OP_CHECKMULTISIG script, or none if it isn't one. */
function multisigKeys(script: Uint8Array): Uint8Array[] {
  const keys: Uint8Array[] = [];
  if (script.length < 37 || script[script.length - 1] !== 0xae) return keys;
  for (let i = 1; i + 34 <= script.length - 2 && script[i] === 0x21; i += 34) {
    keys.push(script.slice(i + 1, i + 34));
  }
  return keys;
}

/**
 * A hardware wallet's view of one of our PSBTs (Coldcard, Trezor, Ledger): stricter than a
 * software signer. It refuses unless the PSBT is self-contained and every claim in it checks out,
 * then signs with plain SIGHASH_ALL, which is all these devices can do. It signs only inputs whose
 * key origin names its own fingerprint, and leaves the rest to the other devices, so a multisig is
 * signed by running the same unsigned PSBT through each cosigner's device on its own.
 *
 *   - every input has the data to price it: the whole previous transaction (which must hash to the
 *     outpoint), or for Taproot the previous output;
 *   - at least one input names this device's fingerprint in its key origin, and the key is in the
 *     script it would sign (for multisig every cosigner key has a key origin);
 *   - redeem and witness scripts hash to what the output script commits to;
 *   - the sighash type, if given, is plain ALL (a 0x21 request would be refused or ignored);
 *   - every output goes to a destination the person accepts, and the fee is sane.
 */
export function hardwareStyleSign(b64: string, device: Device, rules: DeviceRules): string {
  const psbt = decodePsbt(b64);
  const refuse = (m: string): never => {
    throw new DeviceRefusal(`device ${device.fingerprint} refuses: ${m}`);
  };
  let inputValue = 0n;
  let mine = 0;
  psbt.inputs.forEach((m, i) => {
    const outpoint = psbt.tx.inputs[i];
    const full = findValues(m, IN_NON_WITNESS_UTXO)[0]?.value;
    const part = findValues(m, IN_WITNESS_UTXO)[0]?.value;
    const taproot = findValues(m, IN_TAP_INTERNAL_KEY).length > 0;
    let spk: Uint8Array;
    let amount: bigint;
    if (full) {
      const prev = parseTx(full);
      if (txid(prev) !== outpoint.txid) {
        refuse(`input ${i}: previous transaction is not the outpoint's`);
      }
      const out = prev.outputs[outpoint.vout];
      if (!out) refuse(`input ${i}: previous transaction has no output ${outpoint.vout}`);
      ({ script: spk, value: amount } = out);
      if (part) {
        const claimed = new DataView(part.buffer, part.byteOffset, 8).getBigUint64(0, true);
        if (claimed !== amount) {
          refuse(`input ${i}: witness amount differs from the previous transaction`);
        }
      }
    } else if (taproot && part) {
      amount = new DataView(part.buffer, part.byteOffset, 8).getBigUint64(0, true);
      spk = part.slice(9);
    } else {
      return refuse(`input ${i}: no full previous transaction (needed to price a segwit input)`);
    }
    inputValue += amount;

    const origins = findValues(m, taproot ? IN_TAP_BIP32_DERIVATION : IN_BIP32_DERIVATION).map(
      (e) => {
        const pub = e.key.slice(1);
        // Taproot: <compact count of leaf hashes><hashes><fingerprint><path>; ours has no leaves.
        const value = taproot ? e.value.slice(1 + 32 * e.value[0]) : e.value;
        return { pub, fingerprint: hex(value.slice(0, 4)) };
      },
    );
    const own = origins.filter((o) => o.fingerprint === device.fingerprint);
    if (!own.length) return; // not this device's input
    mine++;
    const sighash = findValues(m, IN_SIGHASH_TYPE)[0]?.value;
    if (sighash) {
      const type = new DataView(sighash.buffer, sighash.byteOffset, 4).getUint32(0, true);
      if (type !== 1 && !(taproot && type === 0)) {
        refuse(`input ${i}: sighash type 0x${type.toString(16)}`);
      }
    }
    const redeem = findValues(m, IN_REDEEM_SCRIPT)[0]?.value;
    const witnessScript = findValues(m, IN_WITNESS_SCRIPT)[0]?.value;
    let committed = spk; // the script that must contain the key (or its hash)
    if (redeem) {
      if (
        !(spk.length === 23 && spk[0] === 0xa9 && hex(spk.slice(2, 22)) === hex(hash160(redeem)))
      ) {
        refuse(`input ${i}: redeem script does not hash to the output script`);
      }
      committed = redeem;
    }
    if (witnessScript) {
      if (
        !(committed.length === 34 && committed[0] === 0 &&
          hex(committed.slice(2)) === hex(sha256(witnessScript)))
      ) {
        refuse(`input ${i}: witness script does not hash to the output script`);
      }
      committed = witnessScript;
    }
    const cosigners = multisigKeys(committed);
    if (cosigners.length) {
      for (const k of cosigners) {
        if (!origins.some((o) => hex(o.pub) === hex(k))) {
          refuse(`input ${i}: a multisig key has no key origin`);
        }
      }
    }
    if (taproot) {
      // The output key must be the BIP341 tweak of the internal key the PSBT names.
      const internal = findValues(m, IN_TAP_INTERNAL_KEY)[0].value;
      if (hex(p2tr(internal, undefined, NETWORK).script) !== hex(spk)) {
        refuse(`input ${i}: output key is not the tweak of the internal key`);
      }
    } else {
      for (const o of own) {
        const inScript = cosigners.length
          ? cosigners.some((k) => hex(k) === hex(o.pub))
          : hex(committed).includes(hex(hash160(o.pub)));
        if (!inScript) refuse(`input ${i}: my key is not in the script`);
      }
    }
  });
  if (!mine) refuse("no input names my fingerprint");
  let outputValue = 0n;
  for (const o of psbt.tx.outputs) {
    outputValue += o.value;
    if (!rules.allowedOutputs.has(hex(o.script))) {
      refuse(`output ${hex(o.script)} is not a destination I was shown`);
    }
  }
  const fee = inputValue - outputValue;
  if (fee < 0n) refuse("outputs exceed inputs");
  if (Number(fee) > Number(inputValue) * rules.maxFeeFraction) {
    refuse(`fee ${fee} sats is too high`);
  }
  return stockSign(b64, device.keys);
}

const nodeWallets = new Map<string, Rpc>();

/**
 * A regtest node's own wallet as the signer: the real signing code of Bitcoin Core, Bitcoin Knots
 * or eCash. The wallet holds only this device's key (its descriptor has the other cosigners as
 * public keys), so a multisig is signed by running the same unsigned PSBT through each device's
 * wallet on its own. Returns the PSBT with this device's partial signatures, not finalized.
 */
export async function nodeWalletSign(
  node: Rpc,
  device: Device,
  b64: string,
  sighashType: string,
): Promise<{ psbt: string; complete: boolean }> {
  // getdescriptorinfo returns the canonical descriptor without private keys; its checksum is the
  // input's, which is what importing the private form needs.
  const info = await node.call<{ checksum: string }>("getdescriptorinfo", device.descriptor);
  const name = `dev-${device.fingerprint}-${toHex(sha256(utf8(device.descriptor))).slice(0, 10)}`;
  const key = `${node.port}:${name}`;
  let wallet = nodeWallets.get(key);
  if (!wallet) {
    // Blank descriptor wallet with private keys, then only this device's descriptor.
    await node.call("createwallet", name, false, true, "", false, true).catch((e: Error) => {
      if (!e.message.includes("already exists")) throw e;
    });
    wallet = node.withWallet(name);
    const imported = await wallet.call<{ success: boolean; error?: unknown }[]>(
      "importdescriptors",
      [{ desc: `${device.descriptor}#${info.checksum}`, timestamp: "now", range: [0, 20] }],
    );
    if (!imported[0].success) throw new Error(`importdescriptors: ${JSON.stringify(imported[0])}`);
    nodeWallets.set(key, wallet);
  }
  // sign=true, bip32derivs=true, finalize=false: leave a partial signature, like a cosigner.
  return await wallet.call("walletprocesspsbt", b64.trim(), true, sighashType, true, false);
}
