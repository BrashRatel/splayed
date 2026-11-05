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
const XPRV = 0x0488ade4;
const TPRV = 0x04358394;
const b58 = base58check(sha256);

/** Re-encode a mainnet xpub with the testnet/regtest version bytes. */
export function xpubToTpub(xpub: string): string {
  const raw = b58.decode(xpub);
  if (new DataView(raw.buffer, raw.byteOffset).getUint32(0) !== XPUB) return xpub;
  const out = Uint8Array.from(raw);
  new DataView(out.buffer).setUint32(0, TPUB);
  return b58.encode(out);
}

/** The same for a private extended key (regtest nodes want tprv). */
export function xprvToTprv(xprv: string): string {
  const raw = b58.decode(xprv);
  if (new DataView(raw.buffer, raw.byteOffset).getUint32(0) !== XPRV) return xprv;
  const out = Uint8Array.from(raw);
  new DataView(out.buffer).setUint32(0, TPRV);
  return b58.encode(out);
}

/**
 * Ways to make a regtest node behave like the nodes people really run. One object is shared by
 * every transport a CLI creates, so a scenario can change it between commands.
 */
export interface RegtestTransportOptions {
  /**
   * false: act like a node started without `-txindex`. `getindexinfo` lists no index and
   * `getrawtransaction` only finds mempool transactions, with Core's own error for the rest.
   * (The regtest nodes do run `-txindex`; this hides what it would show.)
   */
  txindex?: boolean;
  /**
   * Pass the next `remaining` requests for `method` on `chain` to the node, then fail them as if
   * the reply never came back: a send that got through whose answer was lost.
   */
  loseReply?: { chain: string; method: string; remaining: number };
  /** Raw transactions handed to `sendrawtransaction`, per chain. */
  sent?: { chain: string; hex: string }[];
}

const NO_TXINDEX_MESSAGE =
  "No such mempool transaction. Use -txindex or provide a block hash to enable blockchain " +
  "transaction queries. Use gettransaction for wallet transactions.";

/**
 * Transport to a regtest node. Regtest nodes reject mainnet xpubs, so scantxoutset descriptors are
 * rewritten to tpubs (with a fresh checksum from the node's own getdescriptorinfo). Every other
 * request is passed through untouched, so the application still talks to real node RPC, unless
 * `options` ask for a node without `-txindex` or for a reply to be lost.
 */
export class RegtestRpcTransport implements Transport {
  readonly route: Route = { via: "direct", hostClass: "loopback", reason: "regtest" };
  readonly methods: string[] = [];
  constructor(
    readonly rpc: Rpc,
    readonly options: RegtestTransportOptions = {},
    readonly chain = "",
  ) {}

  private reply(status: number, payload: unknown): HttpResponse {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const text = () => new TextDecoder().decode(bytes);
    return {
      status,
      headers: new Map(),
      body: bytes,
      text,
      json: <T>() => JSON.parse(text()) as T,
    };
  }

  async request(spec: RequestSpec): Promise<HttpResponse> {
    const body = JSON.parse(spec.body as string);
    this.methods.push(body.method);
    if (this.options.txindex === false) {
      if (body.method === "getindexinfo") {
        return this.reply(200, { result: {}, error: null, id: body.id });
      }
      if (body.method === "getrawtransaction") {
        const pool = await this.rpc.call<string[]>("getrawmempool");
        if (!pool.includes(body.params?.[0])) {
          return this.reply(500, {
            result: null,
            error: { code: -5, message: NO_TXINDEX_MESSAGE },
            id: body.id,
          });
        }
      }
    }
    if (body.method === "sendrawtransaction") {
      this.options.sent?.push({ chain: this.chain, hex: body.params?.[0] });
    }
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
    const lose = this.options.loseReply;
    if (lose && lose.remaining > 0 && lose.chain === this.chain && lose.method === body.method) {
      lose.remaining--;
      throw new Error(`regtest: the reply to ${body.method} was lost (the node got the request)`);
    }
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
