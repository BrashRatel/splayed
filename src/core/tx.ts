/** Minimal Bitcoin transaction (de)serialization: enough to verify previous transactions and to
 *  build unsigned transactions for PSBTs. Same wire format on BTC, XBT and ECX. */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  compactSize,
  concatBytes,
  fromHex,
  i64le,
  reverseBytes,
  toHex,
  u32le,
  varBytes,
} from "./bytes.ts";

export interface TxInput {
  /** Display-order txid hex. */
  txid: string;
  vout: number;
  scriptSig: Uint8Array;
  sequence: number;
  witness: Uint8Array[];
}

export interface TxOutput {
  value: bigint;
  script: Uint8Array;
}

export interface Tx {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  lockTime: number;
}

export class TxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxParseError";
  }
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.bytes.length) throw new TxParseError("Transaction truncated");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0];
  }
  u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }
  u64(): bigint {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }
  varint(): number {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const b = this.take(2);
      return b[0] | (b[1] << 8);
    }
    if (first === 0xfe) return this.u32();
    const n = this.u64();
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new TxParseError("CompactSize too large");
    return Number(n);
  }
  varBytes(): Uint8Array {
    return this.take(this.varint());
  }
}

export function parseTx(raw: Uint8Array | string): Tx {
  const r = new Reader(typeof raw === "string" ? fromHex(raw) : raw);
  const version = r.u32();
  let segwit = false;
  let inputCount = r.varint();
  if (inputCount === 0) {
    const flag = r.u8();
    if (flag !== 1) throw new TxParseError("Bad segwit flag");
    segwit = true;
    inputCount = r.varint();
  }
  if (inputCount > 100_000) throw new TxParseError("Too many inputs");
  const inputs: TxInput[] = [];
  for (let i = 0; i < inputCount; i++) {
    const txid = toHex(reverseBytes(r.take(32)));
    const vout = r.u32();
    const scriptSig = Uint8Array.from(r.varBytes());
    const sequence = r.u32();
    inputs.push({ txid, vout, scriptSig, sequence, witness: [] });
  }
  const outputCount = r.varint();
  if (outputCount > 100_000) throw new TxParseError("Too many outputs");
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    const value = r.u64();
    outputs.push({ value, script: Uint8Array.from(r.varBytes()) });
  }
  if (segwit) {
    for (const input of inputs) {
      const items = r.varint();
      for (let j = 0; j < items; j++) input.witness.push(Uint8Array.from(r.varBytes()));
    }
  }
  const lockTime = r.u32();
  if (r.pos !== r.bytes.length) throw new TxParseError("Trailing bytes after transaction");
  return { version, inputs, outputs, lockTime };
}

/** Serialization without witness data: what the txid commits to, and PSBT's unsigned tx. */
export function serializeStripped(tx: Tx): Uint8Array {
  return concatBytes(
    u32le(tx.version >>> 0),
    compactSize(tx.inputs.length),
    ...tx.inputs.map((i) =>
      concatBytes(
        reverseBytes(fromHex(i.txid)),
        u32le(i.vout),
        varBytes(i.scriptSig),
        u32le(i.sequence),
      )
    ),
    compactSize(tx.outputs.length),
    ...tx.outputs.map((o) => concatBytes(i64le(o.value), varBytes(o.script))),
    u32le(tx.lockTime),
  );
}

export function txid(tx: Tx): string {
  return toHex(reverseBytes(sha256(sha256(serializeStripped(tx)))));
}

/** sha256(script) in reversed hex: the Electrum protocol's "scripthash". */
export function electrumScripthash(script: Uint8Array): string {
  return toHex(reverseBytes(sha256(script)));
}

/** Full serialization (with witness data when any input has some). */
export function serializeTx(tx: Tx): Uint8Array {
  const segwit = tx.inputs.some((i) => i.witness.length > 0);
  if (!segwit) return serializeStripped(tx);
  return concatBytes(
    u32le(tx.version >>> 0),
    Uint8Array.of(0, 1),
    compactSize(tx.inputs.length),
    ...tx.inputs.map((i) =>
      concatBytes(
        reverseBytes(fromHex(i.txid)),
        u32le(i.vout),
        varBytes(i.scriptSig),
        u32le(i.sequence),
      )
    ),
    compactSize(tx.outputs.length),
    ...tx.outputs.map((o) => concatBytes(i64le(o.value), varBytes(o.script))),
    ...tx.inputs.map((i) => concatBytes(compactSize(i.witness.length), ...i.witness.map(varBytes))),
    u32le(tx.lockTime),
  );
}

/** Data pushes of a push-only script (scriptSig). Throws on any non-push opcode. */
export function parsePushes(script: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    let len: number;
    if (op === 0) {
      out.push(new Uint8Array());
      continue;
    } else if (op >= 1 && op <= 75) len = op;
    else if (op === 0x4c) len = script[i++];
    else if (op === 0x4d) {
      len = script[i] | (script[i + 1] << 8);
      i += 2;
    } else throw new TxParseError(`scriptSig contains a non-push opcode 0x${op.toString(16)}`);
    if (i + len > script.length) throw new TxParseError("Truncated push in scriptSig");
    out.push(script.slice(i, i + len));
    i += len;
  }
  return out;
}

export function pushData(data: Uint8Array): Uint8Array {
  if (data.length === 0) return Uint8Array.of(0);
  if (data.length <= 75) return concatBytes(Uint8Array.of(data.length), data);
  if (data.length <= 255) return concatBytes(Uint8Array.of(0x4c, data.length), data);
  if (data.length <= 520) {
    return concatBytes(Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8), data);
  }
  throw new TxParseError("Push too large");
}
