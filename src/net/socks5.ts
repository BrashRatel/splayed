/**
 * SOCKS5 client (RFC 1928 + RFC 1929 username/password).
 *
 * - The destination is always sent as a domain name (ATYP 0x03) so Tor resolves it: no local DNS
 *   lookup ever happens for a proxied host, and .onion names work.
 * - We only offer username/password auth. Tor's default IsolateSOCKSAuth puts streams with
 *   different credentials on different circuits, which is how we isolate chains and broadcasts.
 */
import { writeAll } from "./http1.ts";

export class SocksError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "SocksError";
  }
}

const REPLY_MESSAGES: Record<number, string> = {
  1: "general SOCKS server failure",
  2: "connection not allowed by ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

async function readExact(conn: Deno.Conn, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const n = await conn.read(out.subarray(offset));
    if (n === null) throw new SocksError("SOCKS proxy closed the connection");
    offset += n;
  }
  return out;
}

export interface SocksTarget {
  proxyHost: string;
  proxyPort: number;
  destHost: string;
  destPort: number;
  username: string;
  password: string;
}

/** Performs the SOCKS5 handshake on an already-open connection to the proxy. */
export async function socks5Handshake(conn: Deno.Conn, target: SocksTarget): Promise<void> {
  const enc = new TextEncoder();
  const user = enc.encode(target.username);
  const pass = enc.encode(target.password);
  const host = enc.encode(target.destHost);
  if (user.length < 1 || user.length > 255 || pass.length < 1 || pass.length > 255) {
    throw new SocksError("SOCKS credentials must be 1-255 bytes");
  }
  if (host.length < 1 || host.length > 255) throw new SocksError("Destination host too long");

  await writeAll(conn, Uint8Array.of(0x05, 0x01, 0x02));
  const method = await readExact(conn, 2);
  if (method[0] !== 0x05) throw new SocksError("Proxy is not a SOCKS5 server");
  if (method[1] !== 0x02) {
    throw new SocksError(
      "SOCKS proxy refused username/password auth (needed for stream isolation)",
    );
  }

  await writeAll(
    conn,
    Uint8Array.of(0x01, user.length, ...user, pass.length, ...pass),
  );
  const auth = await readExact(conn, 2);
  if (auth[1] !== 0x00) throw new SocksError("SOCKS authentication failed");

  await writeAll(
    conn,
    Uint8Array.of(
      0x05,
      0x01, // CONNECT
      0x00,
      0x03, // domain name
      host.length,
      ...host,
      (target.destPort >> 8) & 0xff,
      target.destPort & 0xff,
    ),
  );
  const head = await readExact(conn, 4);
  if (head[0] !== 0x05) throw new SocksError("Malformed SOCKS reply");
  if (head[1] !== 0x00) {
    throw new SocksError(
      `SOCKS connect to ${target.destHost}:${target.destPort} failed: ${
        REPLY_MESSAGES[head[1]] ?? `code ${head[1]}`
      }`,
      head[1],
    );
  }
  // Drain the bound address.
  const atyp = head[3];
  if (atyp === 0x01) await readExact(conn, 4 + 2);
  else if (atyp === 0x04) await readExact(conn, 16 + 2);
  else if (atyp === 0x03) {
    const len = (await readExact(conn, 1))[0];
    await readExact(conn, len + 2);
  } else throw new SocksError("Unknown SOCKS address type in reply");
}
