/**
 * Wallet import from QR codes: what wallets and signers show when you export a public key or a
 * whole wallet.
 *
 * - UR `crypto-account` (BCR-2020-015; tag 311) and its successor `account-descriptor` (40311):
 *   one device's account keys, one per script type. SeedSigner's default xpub export. For
 *   multisig it holds only that device's own key, so cosigners are combined here.
 * - UR `crypto-output` (BCR-2020-010; tag 308) and `output-descriptor` (40308, a text template
 *   with `@n` key slots): a whole wallet descriptor, as coordinators such as Sparrow export it.
 * - Plain text: SeedSigner's "Static" export `[fingerprint/path]zpub…`, or a descriptor.
 *
 * Keyless rule: anything carrying private key material is refused before it is looked at.
 * Results are descriptor TEXT; `parseDescriptor` (descriptors.ts) still validates everything,
 * and the import itself goes through the normal `import` / `dest set` commands.
 */
import { HDKey } from "@scure/bip32";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import type { AddressNetwork } from "./descriptors.ts";

export class WalletQrError extends Error {}

// ---- A bounded CBOR reader (what wallet registry types use) ----

type Cbor =
  | number
  | boolean
  | null
  | string
  | Uint8Array
  | Cbor[]
  | CborMap
  | CborTag;
interface CborMap {
  map: Map<number | string, Cbor>;
}
interface CborTag {
  tag: number;
  value: Cbor;
}
const isMap = (v: Cbor): v is CborMap => typeof v === "object" && v !== null && "map" in v;
const isTag = (v: Cbor): v is CborTag => typeof v === "object" && v !== null && "tag" in v;

const MAX_DEPTH = 16;
const MAX_ITEMS = 64;
const MAX_TEXT = 4096;

export function readCbor(data: Uint8Array): Cbor {
  let i = 0;
  const head = () => {
    const first = data[i++];
    if (first === undefined) throw new WalletQrError("Truncated CBOR");
    const major = first >> 5;
    const info = first & 31;
    if (info < 24) return { major, info, n: info };
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!width) throw new WalletQrError("Unsupported CBOR (indefinite length)");
    let n = 0;
    for (let k = 0; k < width; k++) {
      const b = data[i++];
      if (b === undefined) throw new WalletQrError("Truncated CBOR");
      n = n * 256 + b;
    }
    if (!Number.isSafeInteger(n)) throw new WalletQrError("CBOR number too large");
    return { major, info, n };
  };
  const bytes = (n: number) => {
    if (i + n > data.length) throw new WalletQrError("Truncated CBOR");
    const out = data.slice(i, i + n);
    i += n;
    return out;
  };
  const item = (depth: number): Cbor => {
    if (depth > MAX_DEPTH) throw new WalletQrError("CBOR nested too deeply");
    const { major, info, n } = head();
    switch (major) {
      case 0:
        return n;
      case 2:
        return bytes(n);
      case 3: {
        if (n > MAX_TEXT) throw new WalletQrError("CBOR text too long");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes(n));
      }
      case 4: {
        if (n > MAX_ITEMS) throw new WalletQrError("CBOR array too long");
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        if (n > MAX_ITEMS) throw new WalletQrError("CBOR map too long");
        const map = new Map<number | string, Cbor>();
        for (let k = 0; k < n; k++) {
          const key = item(depth + 1);
          if (typeof key !== "number" && typeof key !== "string") {
            throw new WalletQrError("Unsupported CBOR map key");
          }
          if (map.has(key)) throw new WalletQrError("Malformed CBOR: repeated map key");
          map.set(key, item(depth + 1));
        }
        return { map };
      }
      case 6:
        return { tag: n, value: item(depth + 1) };
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new WalletQrError("Unsupported CBOR simple value");
      default:
        throw new WalletQrError("Unsupported CBOR (negative numbers)");
    }
  };
  const out = item(0);
  if (i !== data.length) throw new WalletQrError("Trailing CBOR bytes");
  return out;
}

// ---- Registry tags: legacy (BCR-2020-*) and current (403xx) ----

const T = {
  hdkey: [303, 40303],
  keypath: [304, 40304],
  coininfo: [305, 40305],
  eckey: [306, 40306],
  address: [307, 40307],
  output: [308, 40308],
  account: [311, 40311],
};
const is = (tag: number, kind: keyof typeof T) => T[kind].includes(tag);

const SCRIPT_TAGS: Record<number, string> = {
  400: "sh",
  401: "wsh",
  402: "pk",
  403: "pkh",
  404: "wpkh",
  405: "combo",
  406: "multi",
  407: "sortedmulti",
  408: "raw",
  409: "tr",
  410: "cosigner",
};

/** The script types this tool can import, by name as used in descriptors. */
export type ScriptKind = "wpkh" | "sh-wpkh" | "tr" | "pkh" | "wsh" | "sh-wsh";

/** One extended public key with its origin, as a descriptor key expression is built from. */
export interface WalletKey {
  /** Master key fingerprint (hex, 8 chars). */
  fingerprint: string;
  /** Origin path below the master key, `h` for hardened, e.g. "48h/0h/0h/2h". */
  path: string;
  xpub: string;
  /** True when the parent fingerprint was missing and was set to zero (BCR default). */
  parentFingerprintMissing?: boolean;
}

export type WalletQr =
  | { kind: "account"; fingerprint: string; keys: { script: ScriptKind; key: WalletKey }[] }
  | { kind: "output"; descriptor: string; name?: string };

const fp8 = (n: number) => n.toString(16).padStart(8, "0");

const XPUB_VERSION = { main: 0x0488b21e, test: 0x043587cf };

function field(m: CborMap, k: number): Cbor | undefined {
  return m.map.get(k);
}

/** A keypath's components as [index, hardened] pairs; wildcards and multipath are not origins. */
function keypath(v: Cbor | undefined, what: string) {
  if (!v) return undefined;
  const m = isTag(v) && is(v.tag, "keypath") ? v.value : v;
  if (!isMap(m)) throw new WalletQrError(`Malformed ${what}`);
  const comps = field(m, 1);
  if (!Array.isArray(comps) || comps.length % 2) throw new WalletQrError(`Malformed ${what}`);
  const steps: { index: number; hardened: boolean }[] = [];
  for (let k = 0; k < comps.length; k += 2) {
    const index = comps[k];
    const hardened = comps[k + 1];
    if (typeof index !== "number" || typeof hardened !== "boolean") {
      throw new WalletQrError(
        `The ${what} has a wildcard or range where a fixed step was expected`,
      );
    }
    if (index >= 0x80000000) throw new WalletQrError(`Malformed ${what}`);
    steps.push({ index, hardened });
  }
  const source = field(m, 2);
  const depth = field(m, 3);
  return {
    steps,
    sourceFingerprint: typeof source === "number" ? source : undefined,
    depth: typeof depth === "number" ? depth : undefined,
  };
}

function networkOf(useInfo: Cbor | undefined): "main" | "test" {
  if (useInfo === undefined) return "main";
  const m = isTag(useInfo) && is(useInfo.tag, "coininfo") ? useInfo.value : useInfo;
  if (!isMap(m)) throw new WalletQrError("Malformed coin info");
  const type = field(m, 1);
  if (type !== undefined && type !== 0) {
    throw new WalletQrError("This key is for a different coin than Bitcoin");
  }
  const net = field(m, 2);
  return net === undefined || net === 0 ? "main" : "test";
}

/** An HD public key → base58 xpub with its origin. Private keys are refused outright. */
function hdKey(v: Cbor, network: AddressNetwork, masterFp?: number): WalletKey {
  const m = isTag(v) ? v.value : v;
  if (!isMap(m)) throw new WalletQrError("Malformed HD key");
  if (field(m, 2) === true) {
    throw new WalletQrError(
      "This QR code contains a PRIVATE key. splayed never takes private keys: export the public key (xpub) instead, and keep this one secret.",
    );
  }
  const key = field(m, 3);
  const chainCode = field(m, 4);
  if (!(key instanceof Uint8Array) || !(chainCode instanceof Uint8Array)) {
    throw new WalletQrError("Malformed HD key");
  }
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) {
    throw new WalletQrError(
      key.length === 33 && key[0] === 0
        ? "This QR code contains a PRIVATE key. splayed never takes private keys."
        : "Malformed HD key: not a compressed public key",
    );
  }
  if (chainCode.length !== 32) throw new WalletQrError("Malformed HD key: chain code");
  if (field(m, 1) === true) {
    throw new WalletQrError("This is a master key, not an account key: export the account xpub");
  }
  const net = networkOf(field(m, 5));
  const wantMain = network.id === "main";
  if ((net === "main") !== wantMain) {
    throw new WalletQrError(
      `This key is for ${net === "main" ? "mainnet" : "a test network"}, but splayed is set to ${
        wantMain ? "mainnet" : "a test network"
      }`,
    );
  }
  const origin = keypath(field(m, 6), "key origin");
  if (!origin || !origin.steps.length) {
    throw new WalletQrError("The key has no origin path, so its wallet can't be identified");
  }
  const sourceFp = origin.sourceFingerprint ?? masterFp;
  if (sourceFp === undefined) throw new WalletQrError("The key has no master fingerprint");
  checkChildren(field(m, 7));
  const last = origin.steps[origin.steps.length - 1];
  const parent = field(m, 8);
  let hd: HDKey;
  try {
    hd = new HDKey({
      versions: { private: 0, public: XPUB_VERSION[net] },
      publicKey: key,
      chainCode,
      depth: origin.depth ?? origin.steps.length,
      index: last.index + (last.hardened ? 0x80000000 : 0),
      parentFingerprint: typeof parent === "number" ? parent : 0,
    });
  } catch (error) {
    throw new WalletQrError(`Malformed HD key: ${(error as Error).message}`);
  }
  return {
    fingerprint: fp8(sourceFp),
    path: origin.steps.map((s) => `${s.index}${s.hardened ? "h" : ""}`).join("/"),
    xpub: hd.publicExtendedKey,
    parentFingerprintMissing: typeof parent !== "number" || undefined,
  };
}

/**
 * The derivation below the account key (field 7). splayed always derives receive/change as
 * `<0;1>/*` (import) or `0/*` (destination), so only exports meaning the same are accepted:
 * none given, `<0;1>/*`, or `0/*`. Anything else would silently give different addresses.
 */
function checkChildren(v: Cbor | undefined): void {
  if (v === undefined) return;
  const m = isTag(v) && is(v.tag, "keypath") ? v.value : v;
  const comps = isMap(m) ? field(m, 1) : undefined;
  if (!Array.isArray(comps)) throw new WalletQrError("Malformed key derivation (children)");
  const steps: string[] = [];
  for (let k = 0; k < comps.length; k++) {
    const c = comps[k];
    const hardenedNext = typeof comps[k + 1] === "boolean" ? comps[++k] as boolean : false;
    if (hardenedNext) {
      throw new WalletQrError("Hardened steps below the account key aren't supported");
    }
    if (typeof c === "number") steps.push(String(c));
    else if (Array.isArray(c) && c.length === 0) steps.push("*");
    else if (Array.isArray(c) && c.every((x) => typeof x === "number" || typeof x === "boolean")) {
      // Multipath: [index, hardened, index, hardened, …]
      const idx = c.filter((_x, j) => j % 2 === 0);
      if (c.some((x, j) => j % 2 === 1 && x === true)) {
        throw new WalletQrError("Hardened steps below the account key aren't supported");
      }
      steps.push(`<${idx.join(";")}>`);
    } else throw new WalletQrError("Unsupported key derivation (children)");
  }
  const path = steps.join("/");
  if (!["<0;1>/*", "0/*"].includes(path)) {
    throw new WalletQrError(
      `This export derives addresses as /${path}; splayed only supports /<0;1>/* (receive and change)`,
    );
  }
}

const keyExpr = (k: WalletKey) => `[${k.fingerprint}/${k.path}]${k.xpub}`;

/**
 * The key suffixes in a descriptor (e.g. `/<0;1>/*`). A whole-wallet descriptor is accepted only
 * when every key uses receive/change as splayed expects; `/<1;0>/*` or `/1/*` would make the first
 * "receive" address a change address, or the reverse.
 */
export function checkDescriptorBranches(descriptor: string): void {
  const suffixes = descriptor.match(/\/(?:<[^>]*>|\d+h?)\/\*/gu) ?? [];
  const bad = suffixes.find((x) => x !== "/<0;1>/*" && x !== "/0/*");
  if (bad) {
    throw new WalletQrError(
      `This descriptor derives addresses as ${bad}; splayed only supports /<0;1>/* (receive and change) or /0/*`,
    );
  }
}

/** A legacy crypto-output expression (nested script tags around a key or multi) → text. */
function legacyOutput(v: Cbor, network: AddressNetwork, masterFp?: number): string {
  if (!isTag(v)) throw new WalletQrError("Malformed output descriptor");
  if (is(v.tag, "output")) return legacyOutput(v.value, network, masterFp);
  if (is(v.tag, "hdkey")) return `${keyExpr(hdKey(v, network, masterFp))}/<0;1>/*`;
  if (is(v.tag, "eckey") || is(v.tag, "address")) {
    throw new WalletQrError("This output uses a single fixed key or address, not an xpub");
  }
  const name = SCRIPT_TAGS[v.tag];
  if (!name) throw new WalletQrError(`Unknown output descriptor element (tag ${v.tag})`);
  if (["combo", "raw", "pk", "cosigner"].includes(name)) {
    throw new WalletQrError(`"${name}()" outputs aren't supported`);
  }
  if (name === "multi" || name === "sortedmulti") {
    const m = v.value;
    if (!isMap(m)) throw new WalletQrError("Malformed multisig");
    const threshold = field(m, 1);
    const keys = field(m, 2);
    if (typeof threshold !== "number" || !Array.isArray(keys) || !keys.length) {
      throw new WalletQrError("Malformed multisig");
    }
    return `${name}(${threshold},${keys.map((k) => legacyOutput(k, network, masterFp)).join(",")})`;
  }
  if (name === "tr" && !(isTag(v.value) && is(v.value.tag, "hdkey"))) {
    throw new WalletQrError("Taproot script trees aren't supported (key path only)");
  }
  return `${name}(${legacyOutput(v.value, network, masterFp)})`;
}

/** A current output-descriptor (40308): a text template with @n key slots. */
function templateOutput(
  m: CborMap,
  network: AddressNetwork,
): { descriptor: string; name?: string } {
  const source = field(m, 1);
  const keys = field(m, 2) ?? [];
  if (typeof source !== "string" || !Array.isArray(keys)) {
    throw new WalletQrError("Malformed output descriptor");
  }
  const resolved = keys.map((k) => {
    if (!isTag(k) || !is(k.tag, "hdkey")) {
      throw new WalletQrError("This output uses a single fixed key or address, not an xpub");
    }
    return `${keyExpr(hdKey(k, network))}/<0;1>/*`;
  });
  const descriptor = source.replace(/@(\d+)/gu, (_, n) => {
    const r = resolved[Number(n)];
    if (r === undefined) throw new WalletQrError("Output descriptor refers to a missing key");
    return r;
  });
  const name = field(m, 3);
  return { descriptor, name: typeof name === "string" ? name : undefined };
}

/** Script kind of an account output, from its tag chain (e.g. 400(404(key)) → sh-wpkh). */
function accountScript(v: Cbor): { script?: ScriptKind; key: Cbor } {
  const names: string[] = [];
  let cur = v;
  while (isTag(cur) && SCRIPT_TAGS[cur.tag]) {
    names.push(SCRIPT_TAGS[cur.tag]);
    cur = cur.value;
  }
  // Multisig account keys may be marked cosigner(…) inside wsh / sh(wsh).
  if (names[names.length - 1] === "cosigner") names.pop();
  const kinds: Record<string, ScriptKind> = {
    "wpkh": "wpkh",
    "sh/wpkh": "sh-wpkh",
    "tr": "tr",
    "pkh": "pkh",
    "wsh": "wsh",
    "sh/wsh": "sh-wsh",
  };
  return { script: kinds[names.join("/")], key: cur };
}

export function decodeWalletUr(type: string, cbor: Uint8Array, network: AddressNetwork): WalletQr {
  const top = readCbor(cbor);
  const body = isTag(top) && (is(top.tag, "account") || is(top.tag, "output")) ? top.value : top;
  if (type === "crypto-account" || type === "account-descriptor") {
    if (!isMap(body)) throw new WalletQrError("Malformed account");
    const master = field(body, 1);
    const outputs = field(body, 2);
    if (typeof master !== "number" || !Array.isArray(outputs)) {
      throw new WalletQrError("Malformed account");
    }
    if (type === "account-descriptor") {
      // A list of full output descriptors: offer each as a whole-wallet output.
      const keys: { script: ScriptKind; key: WalletKey }[] = [];
      for (const o of outputs) {
        const m = isTag(o) ? o.value : o;
        if (!isMap(m)) continue;
        const src = field(m, 1);
        const k = (field(m, 2) as Cbor[] | undefined)?.[0];
        const script = typeof src === "string"
          ? ({
            "wpkh(@0)": "wpkh",
            "sh(wpkh(@0))": "sh-wpkh",
            "tr(@0)": "tr",
            "pkh(@0)": "pkh",
            "wsh(@0)": "wsh",
            "sh(wsh(@0))": "sh-wsh",
            "wsh(cosigner(@0))": "wsh",
            "sh(wsh(cosigner(@0)))": "sh-wsh",
          } as Record<string, ScriptKind>)[src.replace(/\s/gu, "")]
          : undefined;
        if (script && k && isTag(k) && is(k.tag, "hdkey")) {
          keys.push({ script, key: hdKey(k, network, master) });
        }
      }
      if (!keys.length) throw new WalletQrError("No supported keys in this account export");
      return { kind: "account", fingerprint: fp8(master), keys };
    }
    const keys: { script: ScriptKind; key: WalletKey }[] = [];
    for (const o of outputs) {
      const inner = isTag(o) && is(o.tag, "output") ? o.value : o;
      const { script, key } = accountScript(inner);
      if (!script || !isTag(key) || !is(key.tag, "hdkey")) continue; // skip types we can't use
      keys.push({ script, key: hdKey(key, network, master) });
    }
    if (!keys.length) throw new WalletQrError("No supported keys in this account export");
    return { kind: "account", fingerprint: fp8(master), keys };
  }
  if (type === "crypto-output" || type === "output-descriptor" || type === "output") {
    const out = isMap(body)
      ? templateOutput(body, network)
      : { descriptor: legacyOutput(body, network) };
    checkDescriptorBranches(out.descriptor);
    return { kind: "output", ...out };
  }
  throw new WalletQrError(
    `This QR code is a "${type}", not a wallet export. Export the xpub or the wallet descriptor.`,
  );
}

// ---- Plain text: SeedSigner "Static" ([fp/path]zpub…) or a descriptor ----

const b58 = createBase58check(sha256);
const SLIP132: Record<string, { version: number; script?: ScriptKind }> = {
  "xpub": { version: 0x0488b21e },
  "ypub": { version: 0x0488b21e, script: "sh-wpkh" },
  "zpub": { version: 0x0488b21e, script: "wpkh" },
  "Ypub": { version: 0x0488b21e, script: "sh-wsh" },
  "Zpub": { version: 0x0488b21e, script: "wsh" },
  "tpub": { version: 0x043587cf },
  "upub": { version: 0x043587cf, script: "sh-wpkh" },
  "vpub": { version: 0x043587cf, script: "wpkh" },
  "Upub": { version: 0x043587cf, script: "sh-wsh" },
  "Vpub": { version: 0x043587cf, script: "wsh" },
};

/** Script kind from a BIP44/49/84/86/48 path. */
export function scriptFromPath(path: string): ScriptKind | undefined {
  const steps = path.split("/");
  switch (steps[0]) {
    case "84h":
      return "wpkh";
    case "49h":
      return "sh-wpkh";
    case "86h":
      return "tr";
    case "44h":
      return "pkh";
    case "48h":
      return steps[3] === "2h" ? "wsh" : steps[3] === "1h" ? "sh-wsh" : undefined;
    default:
      return undefined;
  }
}

export function parseWalletText(text: string, network: AddressNetwork): WalletQr {
  const t = text.trim();
  if (/^[xyztuvYZUV]prv|^tprv/u.test(t) || /prv[1-9A-HJ-NP-Za-km-z]{100,}/u.test(t)) {
    throw new WalletQrError("This contains a PRIVATE key. splayed never takes private keys.");
  }
  const m = /^\[([0-9a-fA-F]{8})((?:\/\d+['hH]?)+)\]([1-9A-HJ-NP-Za-km-z]{100,120})$/u.exec(t);
  if (m) {
    const prefix = m[3].slice(0, 4);
    const known = SLIP132[prefix];
    if (!known) throw new WalletQrError(`Unknown key type "${prefix}"`);
    const raw = b58.decode(m[3]);
    const wantMain = network.id === "main";
    if ((known.version === 0x0488b21e) !== wantMain) {
      throw new WalletQrError("This key is for a different network than splayed is set to");
    }
    const v = known.version;
    const xpub = b58.encode(
      new Uint8Array([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, ...raw.subarray(4)]),
    );
    const path = m[2].slice(1).replace(/['H]/gu, "h");
    if (path.split("/").some((step) => Number(step.replace(/h$/u, "")) >= 0x80000000)) {
      throw new WalletQrError("Path step out of range");
    }
    if (raw.length !== 78) throw new WalletQrError("Malformed extended public key");
    const script = known.script ?? scriptFromPath(path);
    if (!script) {
      throw new WalletQrError(`Can't tell the script type of a key on path ${path}`);
    }
    const key = { fingerprint: m[1].toLowerCase(), path, xpub };
    return { kind: "account", fingerprint: key.fingerprint, keys: [{ script, key }] };
  }
  if (/^[a-z]+\(/u.test(t)) {
    checkDescriptorBranches(t);
    return { kind: "output", descriptor: t };
  }
  if (/^([a-z]{3,8}\s+){11,23}[a-z]{3,8}$/u.test(t) || /^\d{48}$|^\d{96}$/u.test(t)) {
    throw new WalletQrError(
      "This looks like a SEED (recovery words or a SeedQR). Never show it to any app: export the xpub instead, and keep the seed secret.",
    );
  }
  throw new WalletQrError(
    "Not a wallet export: expected an animated UR code, a [fingerprint/path]xpub key, or a descriptor",
  );
}

// ---- Building descriptors ----

export type Purpose = "import" | "dest";
const suffix = (purpose: Purpose) => (purpose === "import" ? "/<0;1>/*" : "/0/*");

export function singleSigDescriptor(script: ScriptKind, key: WalletKey, purpose: Purpose): string {
  const k = `${keyExpr(key)}${suffix(purpose)}`;
  switch (script) {
    case "wpkh":
      return `wpkh(${k})`;
    case "sh-wpkh":
      return `sh(wpkh(${k}))`;
    case "tr":
      return `tr(${k})`;
    case "pkh":
      return `pkh(${k})`;
    default:
      throw new WalletQrError(
        `This is a multisig key (${script}): add it as a cosigner instead`,
      );
  }
}

/** The public key inside an xpub (hex), so the same key with other metadata still matches. */
export function publicKeyOf(xpub: string): string {
  let raw: Uint8Array;
  try {
    raw = b58.decode(xpub);
  } catch {
    throw new WalletQrError("Malformed extended public key");
  }
  if (raw.length !== 78) throw new WalletQrError("Malformed extended public key");
  return Array.from(raw.subarray(45), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function multisigDescriptor(opts: {
  script: ScriptKind;
  threshold: number;
  sorted: boolean;
  keys: WalletKey[];
  purpose: Purpose;
}): string {
  const { script, threshold, sorted, keys, purpose } = opts;
  if (script !== "wsh" && script !== "sh-wsh") {
    throw new WalletQrError("Cosigner keys must be multisig keys (48'/…/2' or 48'/…/1')");
  }
  if (keys.length < 1 || keys.length > 20) throw new WalletQrError("Multisig needs 1 to 20 keys");
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > keys.length) {
    throw new WalletQrError(`The threshold must be between 1 and ${keys.length}`);
  }
  const seen = new Set<string>();
  for (const k of keys) {
    const id = publicKeyOf(k.xpub);
    if (seen.has(id)) {
      throw new WalletQrError(`The same key was added twice (fingerprint ${k.fingerprint})`);
    }
    seen.add(id);
  }
  const inner = `${sorted ? "sortedmulti" : "multi"}(${threshold},${
    keys.map((k) => `${keyExpr(k)}${suffix(purpose)}`).join(",")
  })`;
  return script === "wsh" ? `wsh(${inner})` : `sh(wsh(${inner}))`;
}

/** An import descriptor turned into the destination form (receive branch only). */
export function asDestination(descriptor: string): string {
  return descriptor.replace(/\/<0;1>\/\*/gu, "/0/*").replace(/#[a-z0-9]{8}$/u, "");
}
