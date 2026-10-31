import { base58check, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import type { HttpResponse, RequestSpec, Route, Transport } from "../../src/net/transport.ts";

export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string) {
    super(`${method}: ${message} (${code})`);
  }
}

/** Minimal JSON-RPC client for the regtest nodes (user/password regtest:regtest). */
export class Rpc {
  private id = 1;
  constructor(readonly port: number, readonly wallet?: string) {}

  withWallet(wallet: string): Rpc {
    return new Rpc(this.port, wallet);
  }

  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    const path = this.wallet ? `/wallet/${this.wallet}` : "/";
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: "POST",
      headers: { authorization: "Basic " + btoa("regtest:regtest") },
      body: JSON.stringify({ jsonrpc: "1.0", id: this.id++, method, params }),
    });
    const body = await res.json() as { result: T; error: { code: number; message: string } | null };
    if (body.error) throw new RpcError(method, body.error.code, body.error.message);
    return body.result;
  }

  async mine(n: number, address: string): Promise<string[]> {
    return await this.call<string[]>("generatetoaddress", n, address);
  }
}

const XPUB = 0x0488b21e;
const TPUB = 0x043587cf;
const b58 = base58check(sha256);

/** Re-encode a mainnet xpub with the testnet/regtest version bytes. */
export function xpubToTpub(xpub: string): string {
  const raw = b58.decode(xpub);
  if (new DataView(raw.buffer, raw.byteOffset).getUint32(0) !== XPUB) return xpub;
  const out = Uint8Array.from(raw);
  new DataView(out.buffer).setUint32(0, TPUB);
  return b58.encode(out);
}

/**
 * Transport to a regtest node. Regtest nodes reject mainnet xpubs, so scantxoutset descriptors are
 * rewritten to tpubs (with a fresh checksum from the node's own getdescriptorinfo). Every other
 * request is passed through untouched, so the application still talks to real node RPC.
 */
export class RegtestRpcTransport implements Transport {
  readonly route: Route = { via: "direct", hostClass: "loopback", reason: "regtest" };
  readonly methods: string[] = [];
  constructor(readonly rpc: Rpc) {}

  async request(spec: RequestSpec): Promise<HttpResponse> {
    const body = JSON.parse(spec.body as string);
    this.methods.push(body.method);
    if (body.method === "scantxoutset" && Array.isArray(body.params?.[1])) {
      body.params[1] = await Promise.all(
        body.params[1].map(async (d: string | { desc: string }) => {
          const obj = typeof d === "string" ? { desc: d } : { ...d };
          const bare = obj.desc.replace(/#[a-z0-9]{8}$/u, "").replace(
            /xpub[1-9A-HJ-NP-Za-km-z]+/gu,
            xpubToTpub,
          );
          const info = await this.rpc.call<{ descriptor: string }>("getdescriptorinfo", bare);
          obj.desc = info.descriptor;
          return typeof d === "string" ? obj.desc : obj;
        }),
      );
    }
    const res = await fetch(`http://127.0.0.1:${this.rpc.port}/`, {
      method: "POST",
      headers: { authorization: "Basic " + btoa("regtest:regtest") },
      body: JSON.stringify(body),
      signal: spec.timeoutMs ? AbortSignal.timeout(spec.timeoutMs) : undefined,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = () => new TextDecoder().decode(bytes);
    return {
      status: res.status,
      headers: new Map(),
      body: bytes,
      text,
      json: <T>() => JSON.parse(text()) as T,
    };
  }
}

export const toHexString = (b: Uint8Array) => hex.encode(b);
