import type { HttpResponse, RequestSpec, Route, Transport } from "../src/net/transport.ts";
import { type ChainId, MAINNET } from "../src/core/profiles.ts";

export interface FakeTx {
  vout: { value: number; scriptpubkey: string }[];
  height?: number; // undefined = unconfirmed
}

export interface FakeChain {
  tip: number;
  hashes: Map<number, string>;
  txs: Map<string, FakeTx>;
  /** "txid:vout" -> spending txid + height (undefined height = unconfirmed). */
  spends: Map<string, { txid: string; height?: number }>;
  /** address -> list of outpoints "txid:vout" ever received. */
  history: Map<string, string[]>;
  requests: string[];
  status429?: boolean;
}

export function fakeChain(chain: ChainId, tip = 974_500): FakeChain {
  const hashes = new Map<number, string>();
  for (const cp of MAINNET.chains[chain].checkpoints) hashes.set(cp.height, cp.hash);
  // BTC also needs a hash at 974,017-style heights for other tests; fill any other heights lazily.
  return { tip, hashes, txs: new Map(), spends: new Map(), history: new Map(), requests: [] };
}

function response(status: number, body: string): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: new Map(),
    body: bytes,
    text: () => body,
    json: <T>() => JSON.parse(body) as T,
  };
}

/** A Transport that serves an Esplora API from an in-memory chain model. */
export class FakeEsploraTransport implements Transport {
  readonly route: Route;
  constructor(readonly chain: FakeChain, route?: Route) {
    this.route = route ?? {
      via: "socks",
      socks: { host: "127.0.0.1", port: 9050 },
      tor: true,
      hostClass: "onion",
      reason: "fake",
    };
  }

  request(spec: RequestSpec): Promise<HttpResponse> {
    const url = new URL(spec.url);
    const path = url.pathname.replace(/^\/api/u, "");
    this.chain.requests.push(path);
    if (this.chain.status429) return Promise.resolve(response(429, "slow down"));
    const c = this.chain;
    let m: RegExpExecArray | null;
    if (path === "/blocks/tip/height") return Promise.resolve(response(200, String(c.tip)));
    if ((m = /^\/block-height\/(\d+)$/u.exec(path))) {
      const h = Number(m[1]);
      if (h > c.tip) return Promise.resolve(response(404, "Block not found"));
      const hash = c.hashes.get(h) ?? h.toString(16).padStart(64, "0");
      return Promise.resolve(response(200, hash));
    }
    if ((m = /^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/u.exec(path))) {
      // Mimic the real Esplora trap: unknown txids answer spent:false.
      const spend = c.spends.get(`${m[1]}:${m[2]}`);
      if (!spend) return Promise.resolve(response(200, JSON.stringify({ spent: false })));
      return Promise.resolve(response(
        200,
        JSON.stringify({
          spent: true,
          txid: spend.txid,
          vin: 0,
          status: spend.height === undefined
            ? { confirmed: false }
            : { confirmed: true, block_height: spend.height },
        }),
      ));
    }
    if ((m = /^\/tx\/([0-9a-f]{64})$/u.exec(path))) {
      const tx = c.txs.get(m[1]);
      if (!tx) return Promise.resolve(response(404, "Transaction not found"));
      return Promise.resolve(response(
        200,
        JSON.stringify({
          txid: m[1],
          vout: tx.vout,
          status: tx.height === undefined
            ? { confirmed: false }
            : { confirmed: true, block_height: tx.height },
        }),
      ));
    }
    if ((m = /^\/address\/([^/]+)\/utxo$/u.exec(path))) {
      const outpoints = c.history.get(decodeURIComponent(m[1])) ?? [];
      const utxos = outpoints.filter((op) => !c.spends.has(op)).map((op) => {
        const [txid, vout] = op.split(":");
        const tx = c.txs.get(txid)!;
        return {
          txid,
          vout: Number(vout),
          value: tx.vout[Number(vout)].value,
          status: tx.height === undefined
            ? { confirmed: false }
            : { confirmed: true, block_height: tx.height },
        };
      });
      return Promise.resolve(response(200, JSON.stringify(utxos)));
    }
    if ((m = /^\/address\/([^/]+)$/u.exec(path))) {
      const outpoints = c.history.get(decodeURIComponent(m[1])) ?? [];
      const spends = outpoints.filter((op) => c.spends.has(op)).length;
      return Promise.resolve(response(
        200,
        JSON.stringify({
          address: m[1],
          chain_stats: { tx_count: outpoints.length + spends },
          mempool_stats: { tx_count: 0 },
        }),
      ));
    }
    return Promise.resolve(response(404, "not found"));
  }
}

export const txid = (n: number) => n.toString(16).padStart(64, "a");

/** Put an output on a chain at an address. */
export function addOutput(
  c: FakeChain,
  id: string,
  vout: number,
  value: number,
  address: string,
  scriptpubkey: string,
  height?: number,
) {
  const tx = c.txs.get(id) ?? { vout: [], height };
  while (tx.vout.length <= vout) tx.vout.push({ value: 0, scriptpubkey: "51" });
  tx.vout[vout] = { value, scriptpubkey };
  c.txs.set(id, tx);
  const list = c.history.get(address) ?? [];
  list.push(`${id}:${vout}`);
  c.history.set(address, list);
}
