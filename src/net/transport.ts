import { classifyHost, type HostClass, isValidOnionV3 } from "./hosts.ts";
import { http1Exchange, type RawResponse } from "./http1.ts";
import { socks5Handshake, SocksError } from "./socks5.ts";

export type ProxySetting =
  | { kind: "tor" }
  | { kind: "none" }
  | { kind: "socks5"; host: string; port: number };

export interface SocksEndpoint {
  host: string;
  port: number;
}

/** How a single backend URL will be reached. Computed once, shown to the user, then enforced. */
export type Route =
  | { via: "direct"; hostClass: HostClass; reason: string }
  | { via: "socks"; socks: SocksEndpoint; tor: boolean; hostClass: HostClass; reason: string };

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export class TorUnavailableError extends Error {
  constructor(socks: SocksEndpoint, cause?: unknown) {
    super(
      `Tor SOCKS proxy at ${socks.host}:${socks.port} is not reachable. ` +
        "Refusing to fall back to clearnet. Start Tor, or if you use the Tor Browser run " +
        "`forksplit config tor 127.0.0.1:9150`, then `forksplit init` again.",
      { cause },
    );
    this.name = "TorUnavailableError";
  }
}

export class TimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`Request to ${url} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Decides the route for a backend URL. This is the single place where privacy policy lives:
 * - loopback/LAN hosts are reached directly (Tor can't reach them anyway);
 * - .onion hosts require a SOCKS proxy;
 * - public hosts go through Tor unless the user both chose proxy "none" AND opted this chain into
 *   clearnet. There is no automatic fallback between routes.
 */
export function resolveRoute(
  rawUrl: string,
  proxy: ProxySetting,
  clearnetOptIn: boolean,
  torSocks: SocksEndpoint,
): Route {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PolicyError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PolicyError("Backend URLs must use http:// or https://");
  }
  if (url.username || url.password) {
    throw new PolicyError("Put credentials in the backend's auth settings, not in the URL");
  }
  if (url.search || url.hash) throw new PolicyError("Backend URLs must not contain ? or #");
  const hostClass = classifyHost(url.hostname);

  if (hostClass === "onion") {
    if (!isValidOnionV3(url.hostname)) {
      throw new PolicyError(`${url.hostname} is not a valid v3 onion address (checksum failed)`);
    }
    if (proxy.kind === "none") throw new PolicyError("Onion addresses can only be reached via Tor");
    const socks = proxy.kind === "socks5" ? { host: proxy.host, port: proxy.port } : torSocks;
    return {
      via: "socks",
      socks,
      tor: proxy.kind === "tor",
      hostClass,
      reason: "onion service via Tor",
    };
  }
  if (hostClass === "loopback" || hostClass === "lan") {
    return {
      via: "direct",
      hostClass,
      reason: hostClass === "loopback" ? "local machine" : "local network",
    };
  }
  // Public host.
  if (url.protocol !== "https:") {
    throw new PolicyError(
      "Public backends must use https:// (plain http is allowed only for " +
        "localhost, your local network, or .onion addresses)",
    );
  }
  if (proxy.kind === "tor") {
    return { via: "socks", socks: torSocks, tor: true, hostClass, reason: "public host via Tor" };
  }
  if (proxy.kind === "socks5") {
    return {
      via: "socks",
      socks: { host: proxy.host, port: proxy.port },
      tor: false,
      hostClass,
      reason: "public host via custom SOCKS5 proxy",
    };
  }
  if (!clearnetOptIn) {
    throw new PolicyError(
      `${url.hostname} would be contacted over clearnet, revealing your IP address. ` +
        "Use the Tor proxy, or explicitly opt this chain into clearnet.",
    );
  }
  return { via: "direct", hostClass, reason: "public host over CLEARNET (opted in)" };
}

export interface RequestSpec {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Circuit isolation key, e.g. "btc" or "broadcast:<txid>". Ignored for direct routes. */
  isolation: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HttpResponse extends RawResponse {
  text(): string;
  json<T = unknown>(): T;
}

export interface Transport {
  readonly route: Route;
  request(spec: RequestSpec): Promise<HttpResponse>;
}

function wrap(raw: RawResponse): HttpResponse {
  return {
    ...raw,
    text: () => new TextDecoder().decode(raw.body),
    json: <T>() => JSON.parse(new TextDecoder().decode(raw.body)) as T,
  };
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** A random per-process value mixed into SOCKS credentials so runs don't share circuits. */
export const SESSION_ID: string = Array.from(
  crypto.getRandomValues(new Uint8Array(8)),
  (b) => b.toString(16).padStart(2, "0"),
).join("");

export class RoutedTransport implements Transport {
  constructor(readonly route: Route, private readonly sessionId: string = SESSION_ID) {}

  async request(spec: RequestSpec): Promise<HttpResponse> {
    const url = new URL(spec.url);
    const https = url.protocol === "https:";
    const defaultPort = https ? 443 : 80;
    const port = url.port ? Number(url.port) : defaultPort;
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const body = typeof spec.body === "string" ? new TextEncoder().encode(spec.body) : spec.body;

    let conn: Deno.Conn | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        conn?.close();
      } catch { /* already closed */ }
    }, timeoutMs);
    try {
      if (this.route.via === "socks") {
        const socks = this.route.socks;
        try {
          conn = await Deno.connect({ hostname: socks.host, port: socks.port });
        } catch (error) {
          throw new TorUnavailableError(socks, error);
        }
        await socks5Handshake(conn, {
          proxyHost: socks.host,
          proxyPort: socks.port,
          destHost: hostname,
          destPort: port,
          username: `forksplit:${spec.isolation}:${this.sessionId}`,
          password: this.sessionId,
        });
        if (https) conn = await Deno.startTls(conn as Deno.TcpConn, { hostname });
      } else {
        conn = https
          ? await Deno.connectTls({ hostname, port })
          : await Deno.connect({ hostname, port });
      }
      const raw = await http1Exchange(conn, {
        method: spec.method ?? "GET",
        host: hostname,
        port,
        defaultPort,
        path: `${url.pathname}${url.search}`,
        headers: spec.headers,
        body,
      }, spec.maxBytes ?? DEFAULT_MAX_BYTES);
      return wrap(raw);
    } catch (error) {
      if (timedOut) throw new TimeoutError(spec.url, timeoutMs);
      if (error instanceof SocksError || error instanceof TorUnavailableError) throw error;
      throw error;
    } finally {
      clearTimeout(timer);
      try {
        conn?.close();
      } catch { /* already closed */ }
    }
  }
}

export function describeRoute(route: Route): string {
  if (route.via === "direct") return `direct (${route.reason})`;
  return `${
    route.tor ? "Tor" : "SOCKS5"
  } ${route.socks.host}:${route.socks.port} (${route.reason})`;
}
