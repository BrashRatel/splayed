import type { HttpResponse, RequestSpec, Route, Transport } from "../src/net/transport.ts";
import { type ChainId, MAINNET } from "../src/core/profiles.ts";

export interface FakeTx {
  vout: { value: number; scriptpubkey: string }[];
  height?: number; // undefined = unconfirmed
  /** Hash of the confirming block, for reorg tests (defaults to the chain's hash at `height`). */
  blockHash?: string;
  raw?: string;
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
  feeEstimates?: Record<string, number>;
  broadcasts?: { txid: string; isolation: string; hex: string }[];
  /** Optional consensus stand-in: return a reject reason, or undefined to accept. */
  accept?: (tx: import("../src/core/tx.ts").Tx, hex: string) => string | undefined;
  /** Raw headers by height (Electrum). */
  headers?: Map<number, string>;
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
    if (spec.method === "POST" && path === "/tx") {
      const hex = typeof spec.body === "string" ? spec.body : new TextDecoder().decode(spec.body);
      const tx = parseTx(hex);
      const id = computeTxid(tx);
      for (const i of tx.inputs) {
        if (!c.txs.has(i.txid) || c.spends.has(`${i.txid}:${i.vout}`)) {
          return Promise.resolve(
            response(400, "sendrawtransaction RPC error: bad-txns-inputs-missingorspent"),
          );
        }
      }
      const reason = c.accept?.(tx, hex);
      if (reason) return Promise.resolve(response(400, `sendrawtransaction RPC error: ${reason}`));
      for (const i of tx.inputs) c.spends.set(`${i.txid}:${i.vout}`, { txid: id });
      c.txs.set(id, {
        vout: tx.outputs.map((o) => ({ value: Number(o.value), scriptpubkey: toHex(o.script) })),
        raw: hex,
      });
      (c.broadcasts ??= []).push({ txid: id, isolation: spec.isolation, hex });
      return Promise.resolve(response(200, id));
    }
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
    if (path === "/fee-estimates") {
      return Promise.resolve(response(200, JSON.stringify(c.feeEstimates ?? { "1": 5, "6": 2.5 })));
    }
    if ((m = /^\/tx\/([0-9a-f]{64})\/hex$/u.exec(path))) {
      const tx = c.txs.get(m[1]);
      return Promise.resolve(
        tx?.raw ? response(200, tx.raw) : response(404, "Transaction not found"),
      );
    }
    if ((m = /^\/tx\/([0-9a-f]{64})\/status$/u.exec(path))) {
      const tx = c.txs.get(m[1]);
      if (!tx) return Promise.resolve(response(404, "Transaction not found"));
      return Promise.resolve(response(
        200,
        JSON.stringify(
          tx.height === undefined ? { confirmed: false } : {
            confirmed: true,
            block_height: tx.height,
            block_hash: tx.blockHash ?? c.hashes.get(tx.height) ??
              tx.height.toString(16).padStart(64, "0"),
          },
        ),
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

import { parseTx, serializeStripped, txid as computeTxid } from "../src/core/tx.ts";
import { toHex } from "../src/core/bytes.ts";

/** Create a real, hashable transaction paying the given outputs and register it on chains. */
export function fund(
  chains: FakeChain[],
  outputs: { address: string; scriptPubKey: string; value: number }[],
  height: number | undefined,
  salt: number,
): string {
  const tx = {
    version: 2,
    inputs: [{
      txid: txid(10_000 + salt),
      vout: 0,
      scriptSig: new Uint8Array(),
      sequence: 0xffffffff,
      witness: [],
    }],
    outputs: outputs.map((o) => ({
      value: BigInt(o.value),
      script: Uint8Array.from(o.scriptPubKey.match(/../g)!.map((h) => parseInt(h, 16))),
    })),
    lockTime: 0,
  };
  const raw = toHex(serializeStripped(tx));
  const id = computeTxid(parseTx(raw));
  for (const c of chains) {
    c.txs.set(id, {
      vout: outputs.map((o) => ({ value: o.value, scriptpubkey: o.scriptPubKey })),
      height,
      raw,
    });
    outputs.forEach((o, i) => {
      const list = c.history.get(o.address) ?? [];
      list.push(`${id}:${i}`);
      c.history.set(o.address, list);
    });
  }
  return id;
}

/** Spend an outpoint on one chain with a real transaction (so Electrum servers can serve it). */
export function spendReal(
  c: FakeChain,
  prevTxid: string,
  vout: number,
  height: number | undefined,
  salt: number,
): string {
  const tx = {
    version: 2,
    inputs: [{
      txid: prevTxid,
      vout,
      scriptSig: new Uint8Array(),
      sequence: 0xfffffffd,
      witness: [],
    }],
    outputs: [{ value: 1000n + BigInt(salt), script: Uint8Array.of(0x51) }],
    lockTime: 0,
  };
  const raw = toHex(serializeStripped(tx));
  const id = computeTxid(parseTx(raw));
  c.txs.set(id, { vout: [{ value: 1000 + salt, scriptpubkey: "51" }], height, raw });
  c.spends.set(`${prevTxid}:${vout}`, { txid: id, height });
  return id;
}
