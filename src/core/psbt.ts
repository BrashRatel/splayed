/**
 * BIP174 (PSBT v0) encoder/decoder.
 *
 * Written here instead of using a library because the XBT step needs PSBT_IN_SIGHASH_TYPE = 0x21
 * (SIGHASH_ALL | SIGHASH_UNIFIED), which general-purpose libraries reject as an unknown sighash.
 * Only the fields this tool emits are given names; everything else round-trips as unknown pairs.
 */
import { base64 } from "@scure/base";
import { compactSize, concatBytes, toHex, u32le } from "./bytes.ts";
import { parseTx, serializeStripped, type Tx } from "./tx.ts";

export const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);

// Key types used by this tool.
export const GLOBAL_UNSIGNED_TX = 0x00;
export const GLOBAL_XPUB = 0x01;
export const IN_NON_WITNESS_UTXO = 0x00;
export const IN_WITNESS_UTXO = 0x01;
export const IN_PARTIAL_SIG = 0x02;
export const IN_SIGHASH_TYPE = 0x03;
export const IN_REDEEM_SCRIPT = 0x04;
export const IN_WITNESS_SCRIPT = 0x05;
export const IN_BIP32_DERIVATION = 0x06;
export const IN_FINAL_SCRIPTSIG = 0x07;
export const IN_FINAL_SCRIPTWITNESS = 0x08;
export const IN_TAP_KEY_SIG = 0x13;
export const IN_TAP_BIP32_DERIVATION = 0x16;
export const IN_TAP_INTERNAL_KEY = 0x17;
export const OUT_REDEEM_SCRIPT = 0x00;
export const OUT_WITNESS_SCRIPT = 0x01;
export const OUT_BIP32_DERIVATION = 0x02;
export const OUT_TAP_INTERNAL_KEY = 0x05;
export const OUT_TAP_BIP32_DERIVATION = 0x07;

export interface KeyValue {
  key: Uint8Array; // key type byte followed by key data
  value: Uint8Array;
}

export interface Psbt {
  tx: Tx;
  global: KeyValue[];
  inputs: KeyValue[][];
  outputs: KeyValue[][];
}

export class PsbtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsbtError";
  }
}

export function kv(type: number, keyData: Uint8Array, value: Uint8Array): KeyValue {
  return { key: concatBytes(Uint8Array.of(type), keyData), value };
}

export function derivationValue(fingerprint: Uint8Array, path: number[]): Uint8Array {
  if (fingerprint.length !== 4) throw new PsbtError("Fingerprint must be 4 bytes");
  return concatBytes(fingerprint, ...path.map((p) => u32le(p >>> 0)));
}

export function tapDerivationValue(fingerprint: Uint8Array, path: number[]): Uint8Array {
  // No leaf hashes: key-path spends only.
  return concatBytes(compactSize(0), derivationValue(fingerprint, path));
}

function serializeMap(entries: KeyValue[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    if (toHex(sorted[i].key) === toHex(sorted[i - 1].key)) {
      throw new PsbtError("Duplicate PSBT key");
    }
  }
  return concatBytes(
    ...sorted.map((e) =>
      concatBytes(compactSize(e.key.length), e.key, compactSize(e.value.length), e.value)
    ),
    Uint8Array.of(0),
  );
}

export function encodePsbt(psbt: Psbt): Uint8Array {
  if (psbt.tx.inputs.some((i) => i.scriptSig.length || i.witness.length)) {
    throw new PsbtError("The unsigned transaction must have empty scriptSigs and witnesses");
  }
  if (
    psbt.inputs.length !== psbt.tx.inputs.length || psbt.outputs.length !== psbt.tx.outputs.length
  ) {
    throw new PsbtError("PSBT map count doesn't match the transaction");
  }
  return concatBytes(
    PSBT_MAGIC,
    serializeMap([
      kv(GLOBAL_UNSIGNED_TX, new Uint8Array(), serializeStripped(psbt.tx)),
      ...psbt.global,
    ]),
    ...psbt.inputs.map(serializeMap),
    ...psbt.outputs.map(serializeMap),
  );
}

export function encodePsbtBase64(psbt: Psbt): string {
  return base64.encode(encodePsbt(psbt));
}

class Cursor {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  take(n: number): Uint8Array {
    if (this.pos + n > this.b.length) throw new PsbtError("PSBT truncated");
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Uint8Array.from(out);
  }
  varint(): number {
    const f = this.take(1)[0];
    if (f < 0xfd) return f;
    const n = f === 0xfd ? 2 : f === 0xfe ? 4 : 8;
    const bytes = this.take(n);
    let v = 0;
    for (let i = n - 1; i >= 0; i--) v = v * 256 + bytes[i];
    if (!Number.isSafeInteger(v)) throw new PsbtError("CompactSize too large");
    return v;
  }
  map(): KeyValue[] {
    const out: KeyValue[] = [];
    const seen = new Set<string>();
    while (true) {
      const keyLen = this.varint();
      if (keyLen === 0) return out;
      const key = this.take(keyLen);
      const value = this.take(this.varint());
      const id = toHex(key);
      if (seen.has(id)) throw new PsbtError("Duplicate key in PSBT map");
      seen.add(id);
      out.push({ key, value });
    }
  }
}

export function decodePsbt(input: Uint8Array | string): Psbt {
  const bytes = typeof input === "string" ? base64.decode(input.trim()) : input;
  const c = new Cursor(bytes);
  const magic = c.take(5);
  if (toHex(magic) !== toHex(PSBT_MAGIC)) throw new PsbtError("Not a PSBT (bad magic)");
  const globalAll = c.map();
  const txEntry = globalAll.find((e) => e.key.length === 1 && e.key[0] === GLOBAL_UNSIGNED_TX);
  if (!txEntry) throw new PsbtError("PSBT has no unsigned transaction (PSBT v2 is not supported)");
  const tx = parseTx(txEntry.value);
  const global = globalAll.filter((e) => e !== txEntry);
  const inputs = tx.inputs.map(() => c.map());
  const outputs = tx.outputs.map(() => c.map());
  if (c.pos !== bytes.length) throw new PsbtError("Trailing bytes after PSBT");
  return { tx, global, inputs, outputs };
}

export function findValues(map: KeyValue[], type: number): KeyValue[] {
  return map.filter((e) => e.key[0] === type);
}

export function sighashTypeOf(map: KeyValue[]): number | undefined {
  const [entry] = findValues(map, IN_SIGHASH_TYPE);
  if (!entry) return undefined;
  if (entry.value.length !== 4) throw new PsbtError("Bad sighash type field");
  return new DataView(entry.value.buffer, entry.value.byteOffset, 4).getUint32(0, true);
}
