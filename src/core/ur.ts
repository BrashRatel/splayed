/**
 * Uniform Resources (BCR-2020-005), enough to move PSBTs to and from air-gapped signers as animated
 * QR codes: `ur:crypto-psbt/<seq>-<total>/<bytewords>`.
 *
 * A message is cut into equal fragments. The first `total` parts carry one fragment each; every
 * part after that is a fountain part, the XOR of a pseudo-random subset of fragments, so a scanner
 * that missed some frames can still finish. Which fragments a part mixes is derived from its
 * sequence number and the message checksum (SHA-256 seeding a xoshiro256** generator), so the
 * decoder needs nothing but the part itself. Checked against the reference implementation's output
 * in tests/ur_test.ts (testdata/ur_vectors.json).
 *
 * Written here rather than imported: the reference library drags in a tree of dependencies, and
 * this tool signs nothing and holds no keys, so the less code that touches a PSBT the better.
 */
import { sha256 } from "@noble/hashes/sha2.js";

export class URError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "URError";
  }
}

// ---- CRC-32 (IEEE, as in zlib) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Bytewords (minimal style: the first and last letter of each word) ----

const WORDS =
  "ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom";

const MINIMAL: string[] = Array.from({ length: 256 }, (_, i) => WORDS[i * 4] + WORDS[i * 4 + 3]);
const MINIMAL_INDEX = new Map(MINIMAL.map((w, i) => [w, i]));

export function bytewordsEncode(data: Uint8Array): string {
  const crc = crc32(data);
  const withCrc = new Uint8Array(data.length + 4);
  withCrc.set(data);
  new DataView(withCrc.buffer).setUint32(data.length, crc, false);
  return Array.from(withCrc, (b) => MINIMAL[b]).join("");
}

export function bytewordsDecode(text: string): Uint8Array {
  const s = text.toLowerCase();
  if (s.length % 2 !== 0 || s.length < 10) throw new URError("Not a valid bytewords string");
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const index = MINIMAL_INDEX.get(s.slice(2 * i, 2 * i + 2));
    if (index === undefined) throw new URError("Not a valid bytewords string");
    bytes[i] = index;
  }
  const body = bytes.subarray(0, bytes.length - 4);
  const want = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0);
  if (crc32(body) !== want) throw new URError("Checksum mismatch: a frame was scanned wrongly");
  return body.slice();
}

// ---- A sliver of CBOR: unsigned integers, byte strings, arrays ----

function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) {
    return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  throw new URError("CBOR number too large");
}

export function cborBytes(data: Uint8Array): Uint8Array {
  const head = cborHead(2, data.length);
  const out = new Uint8Array(head.length + data.length);
  out.set(head);
  out.set(data, head.length);
  return out;
}

type CborItem = number | Uint8Array | CborItem[];

function cborEncode(item: CborItem): number[] {
  if (typeof item === "number") return cborHead(0, item);
  if (item instanceof Uint8Array) return [...cborHead(2, item.length), ...item];
  return [...cborHead(4, item.length), ...item.flatMap(cborEncode)];
}

function cborDecode(data: Uint8Array): CborItem {
  let i = 0;
  const readHead = (): { major: number; n: number } => {
    const first = data[i++];
    if (first === undefined) throw new URError("Truncated CBOR");
    const major = first >> 5;
    const info = first & 31;
    if (info < 24) return { major, n: info };
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
    if (!width) throw new URError("Unsupported CBOR");
    let n = 0;
    for (let k = 0; k < width; k++) {
      const b = data[i++];
      if (b === undefined) throw new URError("Truncated CBOR");
      n = n * 256 + b;
    }
    return { major, n };
  };
  const item = (depth: number): CborItem => {
    if (depth > 4) throw new URError("CBOR nested too deeply");
    const { major, n } = readHead();
    if (major === 0) return n;
    if (major === 2) {
      if (i + n > data.length) throw new URError("Truncated CBOR");
      const out = data.slice(i, i + n);
      i += n;
      return out;
    }
    if (major === 4) {
      if (n > 16) throw new URError("CBOR array too long");
      return Array.from({ length: n }, () => item(depth + 1));
    }
    throw new URError("Unsupported CBOR");
  };
  const result = item(0);
  if (i !== data.length) throw new URError("Trailing CBOR bytes");
  return result;
}

// ---- xoshiro256** and the fragment chooser ----

const MASK = (1n << 64n) - 1n;
const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (64n - k))) & MASK;

class Xoshiro {
  private s: bigint[] = [];
  constructor(seed: Uint8Array) {
    const digest = sha256(seed);
    const view = new DataView(digest.buffer, digest.byteOffset, 32);
    for (let i = 0; i < 4; i++) this.s.push(view.getBigUint64(i * 8, false));
  }
  private roll(): bigint {
    const s = this.s;
    const result = (rotl((s[1] * 5n) & MASK, 7n) * 9n) & MASK;
    const t = (s[1] << 17n) & MASK;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 45n);
    return result;
  }
  nextDouble(): number {
    return Number(this.roll()) / 18446744073709551616;
  }
  nextInt(low: number, high: number): number {
    return Math.floor(this.nextDouble() * (high - low + 1) + low);
  }
}

/** Walker/Vose alias sampling over the weights 1, 1/2, 1/3, ... 1/n (the soliton-like degree law). */
function chooseDegree(seqLen: number, rng: Xoshiro): number {
  const weights = Array.from({ length: seqLen }, (_, i) => 1 / (i + 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  const scaled = weights.map((w) => (w * seqLen) / sum);
  const prob = new Array<number>(seqLen).fill(0);
  const alias = new Array<number>(seqLen).fill(0);
  const small: number[] = [];
  const large: number[] = [];
  for (let i = seqLen - 1; i >= 0; i--) (scaled[i] < 1 ? small : large).push(i);
  while (small.length && large.length) {
    const less = small.pop()!;
    const more = large.pop()!;
    prob[less] = scaled[less];
    alias[less] = more;
    scaled[more] = scaled[more] + scaled[less] - 1;
    (scaled[more] < 1 ? small : large).push(more);
  }
  for (const i of [...large, ...small]) prob[i] = 1;
  const c = Math.floor(rng.nextDouble() * seqLen);
  return (rng.nextDouble() < prob[c] ? c : alias[c]) + 1;
}

export function chooseFragments(seqNum: number, seqLen: number, checksum: number): number[] {
  if (seqNum <= seqLen) return [seqNum - 1];
  const seed = new Uint8Array(8);
  new DataView(seed.buffer).setUint32(0, seqNum, false);
  new DataView(seed.buffer).setUint32(4, checksum, false);
  const rng = new Xoshiro(seed);
  const degree = chooseDegree(seqLen, rng);
  const remaining = Array.from({ length: seqLen }, (_, i) => i);
  const shuffled: number[] = [];
  while (remaining.length) {
    shuffled.push(remaining.splice(rng.nextInt(0, remaining.length - 1), 1)[0]);
  }
  return shuffled.slice(0, degree);
}

function xorInto(target: Uint8Array, other: Uint8Array) {
  for (let i = 0; i < target.length; i++) target[i] ^= other[i];
}

// ---- Encoder ----

export class UREncoder {
  readonly fragments: Uint8Array[];
  readonly fragmentLen: number;
  private seqNum = 0;
  private readonly checksum: number;

  constructor(
    readonly type: string,
    /** The UR payload, already CBOR (for a PSBT: a CBOR byte string). */
    private readonly message: Uint8Array,
    maxFragmentLen = 100,
    minFragmentLen = 10,
  ) {
    if (!message.length) throw new URError("Nothing to encode");
    if (!/^[a-z0-9-]+$/u.test(type)) throw new URError("Bad UR type");
    if (maxFragmentLen < minFragmentLen) throw new URError("Fragments too small");
    let len = 0;
    const most = Math.ceil(message.length / minFragmentLen);
    for (let count = 1; count <= most; count++) {
      len = Math.ceil(message.length / count);
      if (len <= maxFragmentLen) break;
    }
    this.fragmentLen = len;
    this.checksum = crc32(message);
    this.fragments = [];
    for (let at = 0; at < message.length; at += len) {
      const f = new Uint8Array(len);
      f.set(message.subarray(at, at + len));
      this.fragments.push(f);
    }
  }

  get isSinglePart(): boolean {
    return this.fragments.length === 1;
  }

  get fragmentCount(): number {
    return this.fragments.length;
  }

  nextPart(): string {
    if (this.isSinglePart) return `ur:${this.type}/${bytewordsEncode(this.message)}`;
    this.seqNum++;
    const indexes = chooseFragments(this.seqNum, this.fragments.length, this.checksum);
    const mixed = new Uint8Array(this.fragmentLen);
    for (const i of indexes) xorInto(mixed, this.fragments[i]);
    const body = cborEncode([
      this.seqNum,
      this.fragments.length,
      this.message.length,
      this.checksum,
      mixed,
    ]);
    return `ur:${this.type}/${this.seqNum}-${this.fragments.length}/${
      bytewordsEncode(Uint8Array.from(body))
    }`;
  }
}

// ---- Decoder ----

interface Mixed {
  indexes: Set<number>;
  data: Uint8Array;
}

export class URDecoder {
  type?: string;
  private seqLen = 0;
  private messageLen = 0;
  private checksum = 0;
  private fragmentLen = 0;
  private simple = new Map<number, Uint8Array>();
  private mixed: Mixed[] = [];
  private seen = new Set<number>();
  private message?: Uint8Array;

  get isComplete(): boolean {
    return this.message !== undefined;
  }

  /** How many different parts have been taken in, and the fragment count once known. */
  get progress(): { parts: number; fragments: number; known: number; percent: number } {
    const known = this.message ? this.seqLen || 1 : this.simple.size;
    const fragments = this.seqLen || (this.message ? 1 : 0);
    return {
      parts: this.seen.size,
      fragments,
      known,
      percent: this.message ? 100 : fragments ? Math.floor((known * 100) / fragments) : 0,
    };
  }

  /** The CBOR payload, once complete. */
  get result(): { type: string; cbor: Uint8Array } {
    if (!this.message || !this.type) throw new URError("Not complete yet");
    return { type: this.type, cbor: this.message };
  }

  /** Takes in one scanned frame. Returns false for a frame it had already seen. */
  receive(frame: string): boolean {
    const text = frame.trim();
    const m = /^ur:([a-z0-9-]+)\/(?:(\d+)-(\d+)\/)?([a-z]+)$/iu.exec(text);
    if (!m) throw new URError("Not a UR frame");
    const type = m[1].toLowerCase();
    if (this.type && this.type !== type) {
      throw new URError("This frame belongs to another transfer");
    }
    if (this.message) return false;
    const body = bytewordsDecode(m[4]);
    if (m[2] === undefined) {
      this.type = type;
      this.message = body;
      this.seqLen = 1;
      this.seen.add(0);
      return true;
    }
    const seqNum = Number(m[2]);
    const seqLen = Number(m[3]);
    const part = cborDecode(body);
    if (
      !Array.isArray(part) || part.length !== 5 || typeof part[0] !== "number" ||
      typeof part[1] !== "number" || typeof part[2] !== "number" || typeof part[3] !== "number" ||
      !(part[4] instanceof Uint8Array)
    ) throw new URError("Malformed frame");
    const [pSeq, pLen, messageLen, checksum, data] = part as [
      number,
      number,
      number,
      number,
      Uint8Array,
    ];
    if (pSeq !== seqNum || pLen !== seqLen || seqNum < 1 || seqLen < 1 || !data.length) {
      throw new URError("Malformed frame");
    }
    if (messageLen > 1 << 20 || seqLen > 4096) throw new URError("Transfer too large");
    if (data.length * seqLen < messageLen || data.length * (seqLen - 1) >= messageLen) {
      throw new URError("Malformed frame");
    }
    if (!this.type) {
      this.type = type;
      this.seqLen = seqLen;
      this.messageLen = messageLen;
      this.checksum = checksum;
      this.fragmentLen = data.length;
    } else if (
      this.seqLen !== seqLen || this.messageLen !== messageLen || this.checksum !== checksum ||
      this.fragmentLen !== data.length
    ) {
      throw new URError("This frame belongs to another transfer");
    }
    if (this.seen.has(seqNum)) return false;
    this.seen.add(seqNum);
    const indexes = new Set(chooseFragments(seqNum, seqLen, checksum));
    this.absorb({ indexes, data: data.slice() });
    return true;
  }

  private absorb(first: Mixed) {
    const queue: Mixed[] = [first];
    while (queue.length) {
      const part = queue.pop()!;
      // Take out the fragments we already know.
      for (const i of [...part.indexes]) {
        const known = this.simple.get(i);
        if (known && part.indexes.size > 1) {
          xorInto(part.data, known);
          part.indexes.delete(i);
        }
      }
      if (part.indexes.size === 1) {
        const [i] = part.indexes;
        if (this.simple.has(i)) continue;
        this.simple.set(i, part.data);
        // Every stored mix may now lose this fragment.
        const stored = this.mixed;
        this.mixed = [];
        queue.push(...stored);
      } else if (part.indexes.size > 1) {
        this.mixed.push(part);
      }
    }
    if (this.simple.size === this.seqLen) this.finish();
  }

  private finish() {
    const all = new Uint8Array(this.seqLen * this.fragmentLen);
    for (let i = 0; i < this.seqLen; i++) all.set(this.simple.get(i)!, i * this.fragmentLen);
    const message = all.subarray(0, this.messageLen);
    if (all.subarray(this.messageLen).some((b) => b !== 0)) {
      throw new URError("Padding is not zero: the transfer is corrupt");
    }
    if (crc32(message) !== this.checksum) {
      throw new URError("The assembled data fails its checksum");
    }
    this.message = message.slice();
  }
}

// ---- PSBTs ----

/** Frames for a PSBT: the plain parts first, then fountain parts so a missed frame can be made up. */
export function psbtToUr(
  psbt: Uint8Array,
  maxFragmentLen = 100,
): { type: string; frames: string[] } {
  const enc = new UREncoder("crypto-psbt", cborBytes(psbt), maxFragmentLen);
  const count = enc.isSinglePart ? 1 : enc.fragmentCount * 2;
  return { type: "crypto-psbt", frames: Array.from({ length: count }, () => enc.nextPart()) };
}

/** The PSBT bytes from a finished decoder (types crypto-psbt and psbt). */
export function psbtFromUr(decoder: URDecoder): Uint8Array {
  const { type, cbor } = decoder.result;
  if (type !== "crypto-psbt" && type !== "psbt") {
    throw new URError(`This is a "${type}" transfer, not a PSBT`);
  }
  const item = cborDecode(cbor);
  if (!(item instanceof Uint8Array)) throw new URError("The transfer does not hold a PSBT");
  return item;
}
