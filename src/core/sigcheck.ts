/**
 * Independent signature checking and canonical finalization.
 *
 * Signatures are taken from the signer's output (partial sigs, a finalized PSBT, or a raw
 * transaction), but every script, key and amount comes from the tool's OWN unsigned PSBT. Each
 * signature is verified against the digest the target chain will compute:
 *   ECX: Bitcoin's own digests (legacy, BIP143, BIP341). Only SIGHASH_ALL / DEFAULT accepted.
 *   XBT: Bitcoin Knots' unified digest; every signature must carry exactly 0x21.
 * The final transaction is then rebuilt canonically from the verified signatures.
 */
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  concatBytes,
  fromHex,
  i64le,
  reverseBytes,
  toHex,
  u32le,
  utf8,
  varBytes,
} from "./bytes.ts";
import type { OutputKind } from "./descriptors.ts";
import {
  findValues,
  IN_FINAL_SCRIPTSIG,
  IN_FINAL_SCRIPTWITNESS,
  IN_NON_WITNESS_UTXO,
  IN_PARTIAL_SIG,
  IN_REDEEM_SCRIPT,
  IN_TAP_KEY_SIG,
  IN_WITNESS_SCRIPT,
  IN_WITNESS_UTXO,
  type Psbt,
} from "./psbt.ts";
import { parsePushes, parseTx, pushData, serializeStripped, type Tx, type TxOutput } from "./tx.ts";
import {
  UNIFIED_SCRIPT_TYPE_BASE,
  UNIFIED_SCRIPT_TYPE_TAPROOT,
  UNIFIED_SCRIPT_TYPE_WITNESS_V0,
  unifiedSignatureHash,
} from "./unified_sighash.ts";

export type SigMode = "standard" | "unified";

export class SigCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigCheckError";
  }
}

const sha256d = (b: Uint8Array) => sha256(sha256(b));

function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(utf8(tag));
  return sha256(concatBytes(t, t, msg));
}

// ---- Bitcoin's standard digests (SIGHASH_ALL / DEFAULT only) ----

function outpoints(tx: Tx): Uint8Array {
  return concatBytes(
    ...tx.inputs.map((i) => concatBytes(reverseBytes(fromHex(i.txid)), u32le(i.vout))),
  );
}
function sequences(tx: Tx): Uint8Array {
  return concatBytes(...tx.inputs.map((i) => u32le(i.sequence)));
}
function outputsSer(tx: Tx): Uint8Array {
  return concatBytes(...tx.outputs.map((o) => concatBytes(i64le(o.value), varBytes(o.script))));
}

export function legacySighashAll(tx: Tx, index: number, scriptCode: Uint8Array): Uint8Array {
  const copy: Tx = {
    ...tx,
    inputs: tx.inputs.map((input, i) => ({
      ...input,
      scriptSig: i === index ? scriptCode : new Uint8Array(),
      witness: [],
    })),
  };
  return sha256d(concatBytes(serializeStripped(copy), u32le(1)));
}

export function bip143SighashAll(
  tx: Tx,
  index: number,
  scriptCode: Uint8Array,
  amount: bigint,
): Uint8Array {
  const input = tx.inputs[index];
  return sha256d(concatBytes(
    u32le(tx.version >>> 0),
    sha256d(outpoints(tx)),
    sha256d(sequences(tx)),
    reverseBytes(fromHex(input.txid)),
    u32le(input.vout),
    varBytes(scriptCode),
    i64le(amount),
    u32le(input.sequence),
    sha256d(outputsSer(tx)),
    u32le(tx.lockTime),
    u32le(1),
  ));
}

/** BIP341 key-path digest, no annex, hash type DEFAULT (0) or ALL (1). */
export function bip341Sighash(
  tx: Tx,
  index: number,
  spent: TxOutput[],
  hashType: 0 | 1,
): Uint8Array {
  return taggedHash(
    "TapSighash",
    concatBytes(
      Uint8Array.of(0, hashType),
      u32le(tx.version >>> 0),
      u32le(tx.lockTime),
      sha256(outpoints(tx)),
      sha256(concatBytes(...spent.map((o) => i64le(o.value)))),
      sha256(concatBytes(...spent.map((o) => varBytes(o.script)))),
      sha256(sequences(tx)),
      sha256(outputsSer(tx)),
      Uint8Array.of(0), // spend type: key path, no annex
      u32le(index),
    ),
  );
}

// ---- Input context from the tool's own unsigned PSBT ----

export interface InputContext {
  kind: OutputKind;
  spent: TxOutput;
  redeemScript?: Uint8Array;
  witnessScript?: Uint8Array;
  /** Keys allowed to sign, in script order (multisig) or the single key. */
  pubkeys: Uint8Array[];
  threshold: number;
}

function parseMultisig(script: Uint8Array): { m: number; keys: Uint8Array[] } {
  const m = script[0] - 0x50;
  const keys: Uint8Array[] = [];
  let i = 1;
  while (script[i] === 33) {
    keys.push(script.slice(i + 1, i + 34));
    i += 34;
  }
  const n = script[i] - 0x50;
  if (m < 1 || n !== keys.length || script[i + 1] !== 0xae || i + 2 !== script.length) {
    throw new SigCheckError("Not a standard multisig script");
  }
  return { m, keys };
}

export function inputContexts(own: Psbt, kinds: OutputKind[]): InputContext[] {
  return own.tx.inputs.map((input, i) => {
    const map = own.inputs[i];
    const kind = kinds[i];
    let spent: TxOutput | undefined;
    const [wu] = findValues(map, IN_WITNESS_UTXO);
    if (wu) {
      const value = new DataView(wu.value.buffer, wu.value.byteOffset, 8).getBigUint64(0, true);
      spent = { value, script: wu.value.slice(9) };
    }
    const [nwu] = findValues(map, IN_NON_WITNESS_UTXO);
    if (nwu) {
      const prev = parseTx(nwu.value);
      const out = prev.outputs[input.vout];
      if (!out) {
        throw new SigCheckError(`Input ${i}: previous transaction lacks output ${input.vout}`);
      }
      if (spent && (spent.value !== out.value || toHex(spent.script) !== toHex(out.script))) {
        throw new SigCheckError(`Input ${i}: witness UTXO disagrees with the previous transaction`);
      }
      spent = out;
    }
    if (!spent) throw new SigCheckError(`Input ${i}: the plan's PSBT has no UTXO data`);
    const redeemScript = findValues(map, IN_REDEEM_SCRIPT)[0]?.value;
    const witnessScript = findValues(map, IN_WITNESS_SCRIPT)[0]?.value;
    let pubkeys: Uint8Array[];
    let threshold = 1;
    if (kind === "tr") {
      pubkeys = [spent.script.slice(2, 34)]; // output (tweaked) key signs a key-path spend
    } else if (kind === "wsh-ms" || kind === "sh-wsh-ms" || kind === "sh-ms") {
      const ms = parseMultisig((kind === "sh-ms" ? redeemScript : witnessScript)!);
      pubkeys = ms.keys;
      threshold = ms.m;
    } else {
      pubkeys = findValues(map, 0x06).map((e) => e.key.slice(1));
      if (pubkeys.length !== 1) throw new SigCheckError(`Input ${i}: expected exactly one key`);
    }
    return { kind, spent, redeemScript, witnessScript, pubkeys, threshold };
  });
}

// ---- Signature extraction ----

/** Signatures found for one input: keyed by pubkey hex when known, else unassigned. */
export interface FoundSigs {
  byKey: Map<string, Uint8Array>;
  unassigned: Uint8Array[];
}

function parseWitness(bytes: Uint8Array): Uint8Array[] {
  let i = 0;
  const read = () => {
    const f = bytes[i++];
    if (f < 0xfd) return f;
    const v = bytes[i] | (bytes[i + 1] << 8);
    i += 2;
    if (f !== 0xfd) throw new SigCheckError("Witness item too large");
    return v;
  };
  const n = read();
  const out: Uint8Array[] = [];
  for (let k = 0; k < n; k++) {
    const len = read();
    out.push(bytes.slice(i, i + len));
    i += len;
  }
  if (i !== bytes.length) throw new SigCheckError("Malformed final witness");
  return out;
}

function sigsFromFinal(ctx: InputContext, scriptSig: Uint8Array, witness: Uint8Array[]): FoundSigs {
  const found: FoundSigs = { byKey: new Map(), unassigned: [] };
  const pushes = scriptSig.length ? parsePushes(scriptSig) : [];
  switch (ctx.kind) {
    case "wpkh":
    case "sh-wpkh":
    case "pkh": {
      const stack = ctx.kind === "pkh" ? pushes : witness;
      if (stack.length !== 2) throw new SigCheckError("Expected [signature, pubkey]");
      if (toHex(stack[1]) !== toHex(ctx.pubkeys[0])) {
        throw new SigCheckError("Unexpected public key");
      }
      found.byKey.set(toHex(ctx.pubkeys[0]), stack[0]);
      break;
    }
    case "tr":
      if (witness.length !== 1) {
        throw new SigCheckError("Expected a single key-path signature (no annex)");
      }
      found.byKey.set(toHex(ctx.pubkeys[0]), witness[0]);
      break;
    case "wsh-ms":
    case "sh-wsh-ms":
    case "sh-ms": {
      const stack = ctx.kind === "sh-ms" ? pushes : witness;
      if (stack.length < 3 || stack[0].length !== 0) {
        throw new SigCheckError("Malformed multisig stack");
      }
      found.unassigned.push(...stack.slice(1, -1));
      break;
    }
  }
  return found;
}

export function extractSignatures(
  ctxs: InputContext[],
  signed: { psbt?: Psbt; tx?: Tx },
): FoundSigs[] {
  return ctxs.map((ctx, i) => {
    if (signed.tx) {
      return sigsFromFinal(ctx, signed.tx.inputs[i].scriptSig, signed.tx.inputs[i].witness);
    }
    const map = signed.psbt!.inputs[i];
    const finalSig = findValues(map, IN_FINAL_SCRIPTSIG)[0]?.value;
    const finalWit = findValues(map, IN_FINAL_SCRIPTWITNESS)[0]?.value;
    if (finalSig || finalWit) {
      return sigsFromFinal(
        ctx,
        finalSig ?? new Uint8Array(),
        finalWit ? parseWitness(finalWit) : [],
      );
    }
    const found: FoundSigs = { byKey: new Map(), unassigned: [] };
    if (ctx.kind === "tr") {
      const tap = findValues(map, IN_TAP_KEY_SIG)[0]?.value;
      if (tap) found.byKey.set(toHex(ctx.pubkeys[0]), tap);
    } else {
      for (const e of findValues(map, IN_PARTIAL_SIG)) {
        found.byKey.set(toHex(e.key.slice(1)), e.value);
      }
    }
    return found;
  });
}

// ---- Verification ----

function scriptCodeFor(ctx: InputContext): { code: Uint8Array; unifiedType: 0 | 1 | 2 } {
  switch (ctx.kind) {
    case "pkh":
      return { code: ctx.spent.script, unifiedType: UNIFIED_SCRIPT_TYPE_BASE };
    case "sh-ms":
      return { code: ctx.redeemScript!, unifiedType: UNIFIED_SCRIPT_TYPE_BASE };
    case "wpkh":
    case "sh-wpkh": {
      const hash = ctx.kind === "wpkh"
        ? ctx.spent.script.slice(2, 22)
        : ctx.redeemScript!.slice(2, 22);
      return {
        code: concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac)),
        unifiedType: UNIFIED_SCRIPT_TYPE_WITNESS_V0,
      };
    }
    case "wsh-ms":
    case "sh-wsh-ms":
      return { code: ctx.witnessScript!, unifiedType: UNIFIED_SCRIPT_TYPE_WITNESS_V0 };
    case "tr":
      return { code: new Uint8Array(), unifiedType: UNIFIED_SCRIPT_TYPE_TAPROOT };
  }
}

export interface InputVerdict {
  index: number;
  hashTypes: number[];
  /** Verified signatures in the key order the final script needs. */
  ordered: { pubkey: Uint8Array; sig: Uint8Array }[];
}

function hashTypeOf(sig: Uint8Array, schnorrSig: boolean): number {
  if (schnorrSig) {
    if (sig.length === 64) return 0;
    if (sig.length === 65) return sig[64];
    throw new SigCheckError("Schnorr signature must be 64 or 65 bytes");
  }
  return sig[sig.length - 1];
}

function verifyOne(
  tx: Tx,
  index: number,
  ctxs: InputContext[],
  ctx: InputContext,
  pubkey: Uint8Array,
  sig: Uint8Array,
  mode: SigMode,
): number {
  const isTr = ctx.kind === "tr";
  const hashType = hashTypeOf(sig, isTr);
  if (mode === "unified") {
    if (hashType !== 0x21) {
      throw new SigCheckError(
        `Input ${index}: signature hash type 0x${
          hashType.toString(16).padStart(2, "0")
        }, not 0x21. ` +
          "Without SIGHASH_UNIFIED this XBT transaction would also be valid on BTC.",
      );
    }
  } else if (!(hashType === 1 || (isTr && hashType === 0))) {
    throw new SigCheckError(
      `Input ${index}: hash type 0x${hashType.toString(16)}; only SIGHASH_ALL/DEFAULT are accepted`,
    );
  }
  const { code, unifiedType } = scriptCodeFor(ctx);
  let digest: Uint8Array | null;
  if (mode === "unified") {
    digest = unifiedSignatureHash(
      {
        version: tx.version,
        lockTime: tx.lockTime,
        inputs: tx.inputs.map((i) => ({
          txid: fromHex(i.txid),
          index: i.vout,
          sequence: i.sequence,
        })),
        outputs: tx.outputs.map((o) => ({ amount: o.value, script: o.script })),
      },
      index,
      hashType,
      ctxs.map((c) => ({ amount: c.spent.value, script: c.spent.script })),
      { scriptType: unifiedType, scriptCode: isTr ? undefined : code },
    );
    if (!digest) {
      throw new SigCheckError(`Input ${index}: unified digest undefined for this hash type`);
    }
  } else if (isTr) {
    digest = bip341Sighash(tx, index, ctxs.map((c) => c.spent), hashType as 0 | 1);
  } else if (ctx.kind === "pkh" || ctx.kind === "sh-ms") {
    digest = legacySighashAll(tx, index, code);
  } else {
    digest = bip143SighashAll(tx, index, code, ctx.spent.value);
  }
  const ok = isTr
    ? schnorr.verify(sig.slice(0, 64), digest, pubkey)
    : secp256k1.verify(sig.slice(0, -1), digest, pubkey, { prehash: false, format: "der" });
  if (!ok) throw new SigCheckError(`Input ${index}: signature does not verify`);
  return hashType;
}

export function verifyInputs(
  tx: Tx,
  ctxs: InputContext[],
  sigs: FoundSigs[],
  mode: SigMode,
): InputVerdict[] {
  return ctxs.map((ctx, index) => {
    const found = sigs[index];
    const ordered: { pubkey: Uint8Array; sig: Uint8Array }[] = [];
    const hashTypes: number[] = [];
    const pool = [...found.unassigned];
    for (const pubkey of ctx.pubkeys) {
      if (ordered.length >= ctx.threshold) break;
      const keyed = found.byKey.get(toHex(pubkey));
      if (keyed) {
        hashTypes.push(verifyOne(tx, index, ctxs, ctx, pubkey, keyed, mode));
        ordered.push({ pubkey, sig: keyed });
        continue;
      }
      // Final multisig stacks don't say which key made which signature: try in order.
      for (let k = 0; k < pool.length; k++) {
        try {
          hashTypes.push(verifyOne(tx, index, ctxs, ctx, pubkey, pool[k], mode));
          ordered.push({ pubkey, sig: pool[k] });
          pool.splice(k, 1);
          break;
        } catch (error) {
          if (
            (error as Error).message.includes("not 0x21") ||
            (error as Error).message.includes("only SIGHASH")
          ) {
            throw error;
          }
        }
      }
    }
    for (const [keyHex] of found.byKey) {
      if (!ctx.pubkeys.some((p) => toHex(p) === keyHex)) {
        throw new SigCheckError(`Input ${index}: signature from an unexpected key`);
      }
    }
    if (ordered.length < ctx.threshold) {
      throw new SigCheckError(
        `Input ${index}: ${ordered.length} of ${ctx.threshold} required signature(s) present`,
      );
    }
    return { index, hashTypes, ordered };
  });
}

/** Rebuilds scriptSig/witness canonically from verified signatures. */
export function finalize(unsigned: Tx, ctxs: InputContext[], verdicts: InputVerdict[]): Tx {
  return {
    ...unsigned,
    inputs: unsigned.inputs.map((input, i) => {
      const ctx = ctxs[i];
      const sigs = verdicts[i].ordered;
      let scriptSig: Uint8Array = new Uint8Array();
      let witness: Uint8Array[] = [];
      switch (ctx.kind) {
        case "wpkh":
          witness = [sigs[0].sig, sigs[0].pubkey];
          break;
        case "sh-wpkh":
          scriptSig = pushData(ctx.redeemScript!);
          witness = [sigs[0].sig, sigs[0].pubkey];
          break;
        case "pkh":
          scriptSig = concatBytes(pushData(sigs[0].sig), pushData(sigs[0].pubkey));
          break;
        case "tr":
          witness = [sigs[0].sig];
          break;
        case "wsh-ms":
          witness = [new Uint8Array(), ...sigs.map((s) => s.sig), ctx.witnessScript!];
          break;
        case "sh-wsh-ms":
          scriptSig = pushData(ctx.redeemScript!);
          witness = [new Uint8Array(), ...sigs.map((s) => s.sig), ctx.witnessScript!];
          break;
        case "sh-ms":
          scriptSig = concatBytes(
            Uint8Array.of(0),
            ...sigs.map((s) => pushData(s.sig)),
            pushData(ctx.redeemScript!),
          );
          break;
      }
      return { ...input, scriptSig, witness };
    }),
  };
}

/** Same version, locktime, inputs (outpoint + sequence) and outputs, ignoring signatures. */
export function sameUnsigned(a: Tx, b: Tx): boolean {
  const strip = (t: Tx) =>
    toHex(
      serializeStripped({
        ...t,
        inputs: t.inputs.map((i) => ({ ...i, scriptSig: new Uint8Array(), witness: [] })),
      }),
    );
  return strip(a) === strip(b);
}
