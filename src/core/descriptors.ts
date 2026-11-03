/**
 * Watch-only output descriptors (BIP380-386 subset).
 *
 * Supported: pkh(K), wpkh(K), sh(wpkh(K)), tr(K) (key path only), wsh(M), sh(wsh(M)), sh(M)
 * where M is multi(k,K,...) or sortedmulti(k,K,...).
 * Keys: [fingerprint/origin]xpub/<0;1>/* style extended keys (ypub/zpub/Ypub/Zpub are converted
 * to xpub), or a fixed hex public key. Private keys and hardened derivation after the xpub are
 * rejected: this tool never holds secrets.
 */
import { HDKey } from "@scure/bip32";
import { createBase58check, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { NETWORK, p2ms, p2pkh, p2sh, p2tr, p2wpkh, p2wsh, TEST_NETWORK } from "@scure/btc-signer";
import { toHex } from "./bytes.ts";

const b58c = createBase58check(sha256);

// ---- BIP380 checksum ----

const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(symbols: number[]): bigint {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) chk ^= GENERATOR[i];
  }
  return chk;
}

export function descriptorChecksum(desc: string): string {
  const symbols: number[] = [];
  let groups: number[] = [];
  for (const c of desc) {
    const v = INPUT_CHARSET.indexOf(c);
    if (v < 0) throw new DescriptorError(`Invalid character in descriptor: ${JSON.stringify(c)}`);
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups = [];
    }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  else if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);
  const chk = polymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = "";
  for (let i = 0; i < 8; i++) out += CHECKSUM_CHARSET[Number((chk >> BigInt(5 * (7 - i))) & 31n)];
  return out;
}

/** Miniscript fragments: all unsupported, and the timelock ones are explained. */
const TIMELOCKS = ["after", "older"];
const MINISCRIPT = [
  "pk",
  "pk_k",
  "pk_h",
  "and_v",
  "and_b",
  "and_n",
  "or_b",
  "or_c",
  "or_d",
  "or_i",
  "andor",
  "thresh",
  "multi_a",
  "sortedmulti_a",
  "sha256",
  "hash256",
  "ripemd160",
  "hash160",
  "just_0",
  "just_1",
];

function unsupportedFunction(name: string, wrapper: boolean): string {
  if (TIMELOCKS.includes(name)) {
    return `${name}() is a timelock, and scripts with timelocks (CLTV and CSV) are not supported. ` +
      "A timelocked input needs its own nLockTime or sequence, which cannot be combined with " +
      "the ECX replay marker (nLockTime 499,999,998 and a non-final sequence). Coins locked " +
      "this way can't be separated by splayed";
  }
  if (wrapper || MINISCRIPT.includes(name)) {
    return `${name}${wrapper ? ":" : "()"} is miniscript, which is not supported (only single ` +
      "keys, multi() and sortedmulti() are). If the script has a timelock (after() or older()), " +
      "it can't be separated by splayed at all: it can't be combined with the ECX replay marker";
  }
  return `Unsupported descriptor function ${name}()`;
}

export class DescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescriptorError";
  }
}

// ---- Parsing ----

type Step = { kind: "fixed"; index: number } | { kind: "multi"; indexes: number[] } | {
  kind: "wildcard";
};

interface KeyExpr {
  origin?: string; // "[fp/path]" exactly as normalized
  originFingerprint?: Uint8Array;
  originPath?: number[];
  xpub?: string; // normalized to xpub version
  pubkey?: Uint8Array; // fixed key
  steps: Step[];
}

type ScriptExpr =
  | { type: "pkh" | "wpkh" | "tr"; key: KeyExpr }
  | { type: "sh" | "wsh"; inner: ScriptExpr }
  | { type: "multi" | "sortedmulti"; threshold: number; keys: KeyExpr[] };

const XPUB_VERSION = 0x0488b21e;

/**
 * Which network a descriptor's keys and addresses belong to. Mainnet is the default and accepts
 * only mainnet extended keys; regtest (test profiles only) accepts the testnet versions that
 * wallets such as Sparrow export and encodes bcrt1 addresses.
 */
export interface AddressNetwork {
  id: "main" | "regtest";
  /** Address encoding parameters. */
  params: typeof NETWORK;
  /** Extended public key versions (other than xpub) that are converted to xpub internally. */
  convertible: ReadonlySet<number>;
  /** Extended private key versions, refused with an explanation. */
  privateVersions: readonly number[];
  /**
   * The BIP32 version bytes the network's own extended public keys use (xpub on mainnet, tpub on
   * testnets and regtest). PSBT_GLOBAL_XPUB is written with these: BIP174 says "78 byte serialized
   * extended public key as defined by BIP 32", and Sparrow, rust-bitcoin (so BDK) and btcd-based
   * wallets write and expect the network's version, refusing the other network's.
   */
  xpubVersion: number;
  keyHint: string;
}

export const MAIN_NETWORK: AddressNetwork = {
  id: "main",
  params: NETWORK,
  // ypub, Ypub, zpub, Zpub
  convertible: new Set([0x049d7cb2, 0x0295b43f, 0x04b24746, 0x02aa7ed3]),
  privateVersions: [0x0488ade4, 0x049d7878, 0x04b2430c],
  xpubVersion: XPUB_VERSION,
  keyHint: "Only mainnet extended public keys (xpub/ypub/zpub) are supported",
};

export const REGTEST_NETWORK: AddressNetwork = {
  id: "regtest",
  params: { ...TEST_NETWORK, bech32: "bcrt" },
  // tpub, upub, vpub, Upub, Vpub
  convertible: new Set([0x043587cf, 0x044a5262, 0x045f1cf6, 0x024289ef, 0x02575483]),
  privateVersions: [0x04358394, 0x044a4e28, 0x045f18bc, 0x0488ade4],
  xpubVersion: 0x043587cf,
  keyHint:
    "Only regtest extended public keys (tpub/upub/vpub, or the xpub splayed stores) are supported",
};

/** The descriptor network a profile uses (mainnet unless the profile says otherwise). */
export function networkForProfile(
  profile: { addressNetwork?: "main" | "regtest" },
): AddressNetwork {
  return profile.addressNetwork === "regtest" ? REGTEST_NETWORK : MAIN_NETWORK;
}

function normalizeXpub(text: string, network: AddressNetwork): string {
  let raw: Uint8Array;
  try {
    raw = b58c.decode(text);
  } catch {
    throw new DescriptorError(`Invalid extended key: ${text.slice(0, 12)}…`);
  }
  if (raw.length !== 78) throw new DescriptorError("Extended key has the wrong length");
  const version = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
  if (version === XPUB_VERSION) return text;
  if (network.convertible.has(version)) {
    const copy = Uint8Array.from(raw);
    new DataView(copy.buffer).setUint32(0, XPUB_VERSION);
    return b58c.encode(copy);
  }
  if (network.privateVersions.includes(version)) {
    throw new DescriptorError(
      "That is a PRIVATE extended key. splayed is keyless: give it the xpub and sign in your own wallet",
    );
  }
  throw new DescriptorError(network.keyHint);
}

class Parser {
  pos = 0;
  constructor(readonly text: string, readonly network: AddressNetwork) {}

  peek(s: string): boolean {
    return this.text.startsWith(s, this.pos);
  }
  expect(s: string): void {
    if (!this.peek(s)) {
      throw new DescriptorError(`Expected "${s}" at position ${this.pos} of the descriptor`);
    }
    this.pos += s.length;
  }
  word(): string {
    const m = /^[a-z][a-z0-9_]*/u.exec(this.text.slice(this.pos));
    if (!m) throw new DescriptorError(`Expected a function name at position ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }
  until(stops: string): string {
    let end = this.pos;
    while (end < this.text.length && !stops.includes(this.text[end])) end++;
    const out = this.text.slice(this.pos, end);
    this.pos = end;
    return out;
  }

  script(context: "top" | "sh" | "wsh"): ScriptExpr {
    const name = this.word();
    // A miniscript wrapper such as v:pk(...) or a:older(...).
    if (this.text[this.pos] === ":") throw new DescriptorError(unsupportedFunction(name, true));
    this.expect("(");
    let expr: ScriptExpr;
    switch (name) {
      case "pkh":
      case "wpkh":
      case "tr": {
        if (name === "tr" && context !== "top") throw new DescriptorError("tr() must be top level");
        if (name === "wpkh" && context === "wsh") {
          throw new DescriptorError("wpkh() inside wsh() is invalid");
        }
        const key = this.key();
        if (name === "tr" && this.peek(",")) {
          throw new DescriptorError("tr() script trees are not supported yet (key-path only)");
        }
        expr = { type: name, key };
        break;
      }
      case "sh":
        if (context !== "top") throw new DescriptorError("sh() must be top level");
        expr = { type: "sh", inner: this.script("sh") };
        if (!["wpkh", "wsh", "multi", "sortedmulti"].includes(expr.inner.type)) {
          throw new DescriptorError("Only sh(wpkh), sh(wsh(...)) and sh(multi) are supported");
        }
        break;
      case "wsh":
        if (context === "wsh") throw new DescriptorError("Nested wsh() is invalid");
        expr = { type: "wsh", inner: this.script("wsh") };
        if (!["multi", "sortedmulti"].includes(expr.inner.type)) {
          throw new DescriptorError("Only wsh(multi(...)) and wsh(sortedmulti(...)) are supported");
        }
        break;
      case "multi":
      case "sortedmulti": {
        if (context === "top") throw new DescriptorError("Bare multisig is not supported");
        const k = Number(this.until(","));
        const keys: KeyExpr[] = [];
        while (this.peek(",")) {
          this.expect(",");
          keys.push(this.key());
        }
        if (!Number.isInteger(k) || k < 1 || k > keys.length || keys.length > 20) {
          throw new DescriptorError("Invalid multisig threshold or key count");
        }
        expr = { type: name, threshold: k, keys };
        break;
      }
      default:
        throw new DescriptorError(unsupportedFunction(name, false));
    }
    this.expect(")");
    return expr;
  }

  key(): KeyExpr {
    let origin: string | undefined;
    if (this.peek("[")) {
      const start = this.pos;
      this.until("]");
      this.expect("]");
      const body = this.text.slice(start + 1, this.pos - 1).replaceAll("'", "h");
      if (!/^[0-9a-fA-F]{8}(\/\d+h?)*$/u.test(body)) {
        throw new DescriptorError(`Invalid key origin [${body}]`);
      }
      // Each step is below 2^31; the hardened flag is what adds 2^31.
      if (body.split("/").slice(1).some((step) => Number(step.replace(/h$/u, "")) >= 0x8000_0000)) {
        throw new DescriptorError(`Invalid key origin [${body}]: path step out of range`);
      }
      origin = `[${body.toLowerCase()}]`;
    }
    const token = this.until("/,)");
    const key: KeyExpr = { origin, steps: [] };
    if (origin) {
      const [fp, ...path] = origin.slice(1, -1).split("/");
      key.originFingerprint = hex.decode(fp);
      key.originPath = path.map((p) =>
        p.endsWith("h") ? (Number(p.slice(0, -1)) + 0x8000_0000) >>> 0 : Number(p)
      );
    }
    if (/^[0-9a-fA-F]+$/u.test(token)) {
      const bytes = hex.decode(token.toLowerCase());
      if (bytes.length === 32) {
        // A bare 32-byte hex string is a valid x-only key but also what a raw private key looks
        // like, and the two can't be told apart. splayed is keyless, so refuse it rather than
        // quietly treat a pasted secret as a public key.
        throw new DescriptorError(
          "A bare 32-byte hex key could be a PRIVATE key. splayed is keyless: give it an xpub " +
            "or a 33-byte compressed public key, and sign in your own wallet",
        );
      }
      if (bytes.length !== 33) {
        throw new DescriptorError("Fixed public keys must be 33-byte compressed");
      }
      key.pubkey = bytes;
      if (this.peek("/")) throw new DescriptorError("A fixed public key cannot be derived");
      return key;
    }
    if (/^[xyztuvYZUV]prv/u.test(token)) {
      throw new DescriptorError(
        "That is a PRIVATE extended key. splayed is keyless: give it the xpub and sign in your own wallet",
      );
    }
    key.xpub = normalizeXpub(token, this.network);
    while (this.peek("/")) {
      this.expect("/");
      if (this.peek("*")) {
        this.expect("*");
        if (this.peek("'") || this.peek("h")) {
          throw new DescriptorError("Hardened wildcards need private keys; not supported");
        }
        key.steps.push({ kind: "wildcard" });
        if (this.peek("/")) throw new DescriptorError("The wildcard must be the last step");
        continue;
      }
      if (this.peek("<")) {
        this.expect("<");
        const body = this.until(">");
        this.expect(">");
        const indexes = body.split(";").map((p) => parseStep(p));
        if (indexes.length < 2) throw new DescriptorError("Multipath needs at least two values");
        key.steps.push({ kind: "multi", indexes });
        continue;
      }
      key.steps.push({ kind: "fixed", index: parseStep(this.until("/,)")) });
    }
    if (key.steps.filter((s) => s.kind === "multi").length > 1) {
      throw new DescriptorError("Only one multipath step per key is allowed");
    }
    return key;
  }
}

function parseStep(text: string): number {
  if (/['h]$/u.test(text)) {
    throw new DescriptorError("Hardened steps after an xpub need private keys; not supported");
  }
  if (!/^\d+$/u.test(text)) throw new DescriptorError(`Invalid derivation step "${text}"`);
  const n = Number(text);
  if (n >= 0x8000_0000) throw new DescriptorError(`Derivation step ${n} out of range`);
  return n;
}

// ---- Expansion and derivation ----

function allKeys(expr: ScriptExpr): KeyExpr[] {
  if ("key" in expr) return [expr.key];
  if ("inner" in expr) return allKeys(expr.inner);
  return expr.keys;
}

function keyToString(key: KeyExpr, branch: number): string {
  if (key.pubkey) return `${key.origin ?? ""}${toHex(key.pubkey)}`;
  const steps = key.steps.map((s) =>
    s.kind === "fixed" ? `/${s.index}` : s.kind === "wildcard" ? "/*" : `/${s.indexes[branch]}`
  ).join("");
  return `${key.origin ?? ""}${key.xpub}${steps}`;
}

function exprToString(expr: ScriptExpr, branch: number): string {
  if ("key" in expr) return `${expr.type}(${keyToString(expr.key, branch)})`;
  if ("inner" in expr) return `${expr.type}(${exprToString(expr.inner, branch)})`;
  return `${expr.type}(${expr.threshold},${
    expr.keys.map((k) => keyToString(k, branch)).join(",")
  })`;
}

const hdCache = new Map<string, HDKey>();

function hdNode(xpub: string): HDKey {
  let node = hdCache.get(xpub);
  if (!node) {
    node = HDKey.fromExtendedKey(xpub);
    hdCache.set(xpub, node);
  }
  return node;
}

function fingerprintBytes(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}

/** A derived key plus what a PSBT signer needs to find it (BIP32 origin). */
export interface KeyInfo {
  pubkey: Uint8Array;
  fingerprint: Uint8Array;
  path: number[];
  /** False when the descriptor had no [fingerprint/path] origin: most signers can't match it. */
  hasOrigin: boolean;
}

function deriveKey(key: KeyExpr, branch: number, index: number): KeyInfo {
  if (key.pubkey) {
    return {
      pubkey: key.pubkey,
      fingerprint: key.originFingerprint ?? new Uint8Array(4),
      path: key.originPath ?? [],
      hasOrigin: key.originFingerprint !== undefined,
    };
  }
  const root = hdNode(key.xpub!);
  let node = root;
  const rel: number[] = [];
  for (const step of key.steps) {
    const n = step.kind === "fixed"
      ? step.index
      : step.kind === "multi"
      ? step.indexes[branch]
      : index;
    rel.push(n);
    node = node.deriveChild(n);
  }
  if (!node.publicKey) throw new DescriptorError("Derivation produced no public key");
  return {
    pubkey: node.publicKey,
    fingerprint: key.originFingerprint ?? fingerprintBytes(root.fingerprint),
    path: [...(key.originPath ?? []), ...rel],
    hasOrigin: key.originFingerprint !== undefined,
  };
}

export type OutputKind = "pkh" | "wpkh" | "sh-wpkh" | "tr" | "wsh-ms" | "sh-wsh-ms" | "sh-ms";

interface Built {
  script: Uint8Array;
  address?: string;
  redeemScript?: Uint8Array;
  witnessScript?: Uint8Array;
  keys: KeyInfo[];
  multisig?: { m: number; n: number };
}

function build(
  expr: ScriptExpr,
  branch: number,
  index: number,
  net: typeof NETWORK,
): Built {
  switch (expr.type) {
    case "pkh": {
      const k = deriveKey(expr.key, branch, index);
      return { ...p2pkh(k.pubkey, net), keys: [k] };
    }
    case "wpkh": {
      const k = deriveKey(expr.key, branch, index);
      return { ...p2wpkh(k.pubkey, net), keys: [k] };
    }
    case "tr": {
      const k = deriveKey(expr.key, branch, index);
      const xonly = k.pubkey.length === 33 ? k.pubkey.slice(1) : k.pubkey;
      return { ...p2tr(xonly, undefined, net), keys: [{ ...k, pubkey: xonly }] };
    }
    case "multi":
    case "sortedmulti": {
      const keys = expr.keys.map((k) => deriveKey(k, branch, index));
      if (expr.type === "sortedmulti") {
        keys.sort((a, b) => (toHex(a.pubkey) < toHex(b.pubkey) ? -1 : 1));
      }
      const ms = p2ms(expr.threshold, keys.map((k) => k.pubkey));
      return { script: ms.script, keys, multisig: { m: expr.threshold, n: keys.length } };
    }
    case "wsh": {
      const inner = build(expr.inner, branch, index, net);
      // deno-lint-ignore no-explicit-any
      const out = p2wsh({ type: "ms", script: inner.script } as any, net);
      return { ...out, witnessScript: inner.script, keys: inner.keys, multisig: inner.multisig };
    }
    case "sh": {
      const inner = build(expr.inner, branch, index, net);
      // deno-lint-ignore no-explicit-any
      const out = p2sh({ type: "unknown", script: inner.script } as any, net, true);
      return {
        ...out,
        redeemScript: inner.script,
        witnessScript: inner.witnessScript,
        keys: inner.keys,
        multisig: inner.multisig,
      };
    }
  }
}

function kindOf(expr: ScriptExpr): OutputKind {
  if (expr.type === "sh") {
    if (expr.inner.type === "wpkh") return "sh-wpkh";
    if (expr.inner.type === "wsh") return "sh-wsh-ms";
    return "sh-ms";
  }
  if (expr.type === "wsh") return "wsh-ms";
  if (expr.type === "pkh" || expr.type === "wpkh" || expr.type === "tr") return expr.type;
  throw new DescriptorError("Unsupported top-level descriptor");
}

export interface DerivedOutput {
  index: number;
  address: string;
  scriptPubKey: string;
  kind: OutputKind;
  redeemScript?: Uint8Array;
  witnessScript?: Uint8Array;
  keys: KeyInfo[];
  multisig?: { m: number; n: number };
}

export interface GlobalXpub {
  /** 78-byte serialized extended public key, with the network's version bytes (xpub or tpub). */
  raw: Uint8Array;
  fingerprint: Uint8Array;
  path: number[];
}

export interface DescriptorBranch {
  /** Single-path descriptor with checksum, e.g. "wpkh([..]xpub/0/*)#abcd1234". */
  descriptor: string;
  /** Without checksum, for node RPC (scantxoutset). */
  body: string;
  branch: number;
  ranged: boolean;
  derive(index: number): DerivedOutput;
}

export interface ParsedDescriptor {
  input: string;
  normalized: string;
  branches: DescriptorBranch[];
  hadChecksum: boolean;
  kind: OutputKind;
  /** Every extended key with its origin, for PSBT_GLOBAL_XPUB. */
  xpubs: GlobalXpub[];
  /** False if any key lacks a [fingerprint/path] origin. */
  allKeysHaveOrigin: boolean;
}

export function parseDescriptor(
  input: string,
  network: AddressNetwork = MAIN_NETWORK,
): ParsedDescriptor {
  const trimmed = input.trim();
  const hashAt = trimmed.lastIndexOf("#");
  let body = trimmed;
  let hadChecksum = false;
  if (hashAt >= 0) {
    body = trimmed.slice(0, hashAt);
    const given = trimmed.slice(hashAt + 1);
    const expected = descriptorChecksum(body);
    if (given !== expected) {
      throw new DescriptorError(
        `Descriptor checksum mismatch (got #${given}, expected #${expected})`,
      );
    }
    hadChecksum = true;
  }
  const parser = new Parser(body, network);
  const expr = parser.script("top");
  if (parser.pos !== body.length) {
    throw new DescriptorError(
      `Unexpected text after position ${parser.pos}: "${body.slice(parser.pos)}"`,
    );
  }
  const keys = allKeys(expr);
  const multiCounts = new Set(
    keys.map((k) => k.steps.find((s) => s.kind === "multi"))
      .map((s) => (s && s.kind === "multi" ? s.indexes.length : 1)),
  );
  if (multiCounts.size > 1) {
    throw new DescriptorError("All keys must use the same number of multipath values");
  }
  const branchCount = [...multiCounts][0];
  const ranged = keys.some((k) => k.steps.some((s) => s.kind === "wildcard"));
  if (
    ranged &&
    !keys.every((k) => k.pubkey === undefined && k.steps.some((s) => s.kind === "wildcard"))
  ) {
    throw new DescriptorError("Either every key or no key may end in /*");
  }
  const branches: DescriptorBranch[] = [];
  for (let branch = 0; branch < branchCount; branch++) {
    const text = exprToString(expr, branch);
    branches.push({
      descriptor: `${text}#${descriptorChecksum(text)}`,
      body: text,
      branch,
      ranged,
      derive(index: number): DerivedOutput {
        if (!ranged && index !== 0) throw new DescriptorError("Descriptor is not ranged");
        const built = build(expr, branch, index, network.params);
        if (!built.address) throw new DescriptorError("Could not derive an address");
        return {
          index,
          address: built.address,
          scriptPubKey: toHex(built.script),
          kind: kindOf(expr),
          redeemScript: built.redeemScript,
          witnessScript: built.witnessScript,
          keys: built.keys,
          multisig: built.multisig,
        };
      },
    });
  }
  const normalized = exprToStringMulti(expr);
  const xpubs: GlobalXpub[] = keys.filter((k) => k.xpub).map((k) => {
    const root = hdNode(k.xpub!);
    // Keys are held as xpub internally; the PSBT gets the network's own version bytes.
    const raw = b58c.decode(k.xpub!);
    new DataView(raw.buffer, raw.byteOffset).setUint32(0, network.xpubVersion);
    return {
      raw,
      fingerprint: k.originFingerprint ?? fingerprintBytes(root.fingerprint),
      path: k.originPath ?? [],
    };
  });
  return {
    kind: kindOf(expr),
    xpubs,
    allKeysHaveOrigin: keys.every((k) => k.originFingerprint !== undefined),
    input: trimmed,
    normalized: `${normalized}#${descriptorChecksum(normalized)}`,
    branches,
    hadChecksum,
  };
}

function exprToStringMulti(expr: ScriptExpr): string {
  const keyStr = (key: KeyExpr) => {
    if (key.pubkey) return `${key.origin ?? ""}${toHex(key.pubkey)}`;
    const steps = key.steps.map((s) =>
      s.kind === "fixed"
        ? `/${s.index}`
        : s.kind === "wildcard"
        ? "/*"
        : `/<${s.indexes.join(";")}>`
    ).join("");
    return `${key.origin ?? ""}${key.xpub}${steps}`;
  };
  if ("key" in expr) return `${expr.type}(${keyStr(expr.key)})`;
  if ("inner" in expr) return `${expr.type}(${exprToStringMulti(expr.inner)})`;
  return `${expr.type}(${expr.threshold},${expr.keys.map(keyStr).join(",")})`;
}
