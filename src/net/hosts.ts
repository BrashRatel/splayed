import { base32 } from "@scure/base";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { concatBytes, equalBytes, utf8 } from "../core/bytes.ts";

/**
 * Where a host lives decides how we may reach it:
 * - loopback / lan: direct connection only (Tor cannot reach it), plaintext HTTP tolerated.
 * - onion: Tor only, plaintext HTTP fine (onion services are end-to-end encrypted).
 * - public: Tor by default; direct only with the per-chain clearnet opt-in.
 */
export type HostClass = "loopback" | "lan" | "onion" | "public";

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : NaN));
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null;
}

export function isValidOnionV3(host: string): boolean {
  const lower = host.toLowerCase();
  if (!lower.endsWith(".onion")) return false;
  const label = lower.slice(0, -".onion".length).split(".").pop() ?? "";
  if (!/^[a-z2-7]{56}$/u.test(label)) return false;
  let raw: Uint8Array;
  try {
    raw = base32.decode(label.toUpperCase());
  } catch {
    return false;
  }
  if (raw.length !== 35) return false;
  const pubkey = raw.slice(0, 32);
  const checksum = raw.slice(32, 34);
  const version = raw.slice(34);
  if (version[0] !== 3) return false;
  const expected = sha3_256(concatBytes(utf8(".onion checksum"), pubkey, version)).slice(0, 2);
  return equalBytes(expected, checksum);
}

export function classifyHost(hostname: string): HostClass {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host.endsWith(".onion")) return "onion";
  if (host === "localhost" || host === "::1") return "loopback";
  const v4 = ipv4Octets(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
    if (a === 169 && b === 254) return "lan";
    return "public";
  }
  if (host.includes(":")) {
    if (/^f[cd][0-9a-f]{2}:/u.test(host) || /^fe[89ab][0-9a-f]:/u.test(host)) return "lan";
    return "public";
  }
  if (host.endsWith(".local")) return "lan";
  return "public";
}
