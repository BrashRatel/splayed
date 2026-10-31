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
