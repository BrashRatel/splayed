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
  /** Mimic the real eCash Esplora bug: /tx/{txid}/status answers confirmed:false (not 404) for
   *  a txid that was never broadcast. */
  statusTrap?: boolean;
  /** GET paths matching this answer HTTP 500 (a flaky or overloaded server). */
  fail?: RegExp;
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
    if (spec.method !== "POST" && this.chain.fail?.test(path)) {
      return Promise.resolve(response(500, "Internal Server Error"));
    }
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
      if (!tx) {
        return Promise.resolve(
          c.statusTrap
            ? response(200, JSON.stringify({ confirmed: false }))
            : response(404, "Transaction not found"),
        );
      }
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

import {
  electrumScripthash,
  parseTx,
  serializeStripped,
  txid as computeTxid,
} from "../src/core/tx.ts";
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

// ---- node RPC and Electrum fakes over the same FakeChain, for end-to-end tests ----

/** Block hash at a height, as every fake serves it. */
export const fakeHash = (c: FakeChain, h: number) =>
  c.hashes.get(h) ?? h.toString(16).padStart(64, "0");

/**
 * A node's answer to a send: the txid, or a reject reason. Inputs must exist and be unspent (in a
 * block or the mempool); a transaction it already has is "already known", as real nodes say.
 */
export function fakeSend(
  c: FakeChain,
  hex: string,
  isolation: string,
): { txid?: string; reason?: string } {
  const tx = parseTx(hex);
  const id = computeTxid(tx);
  if (c.txs.has(id) && tx.inputs.every((i) => c.spends.get(`${i.txid}:${i.vout}`)?.txid === id)) {
    return {
      reason: c.txs.get(id)!.height === undefined
        ? "txn-already-in-mempool"
        : "transaction already in block chain",
    };
  }
  for (const i of tx.inputs) {
    if (!c.txs.has(i.txid) || c.spends.has(`${i.txid}:${i.vout}`)) {
      return { reason: "bad-txns-inputs-missingorspent" };
    }
  }
  const reason = c.accept?.(tx, hex);
  if (reason) return { reason };
  for (const i of tx.inputs) c.spends.set(`${i.txid}:${i.vout}`, { txid: id });
  c.txs.set(id, {
    vout: tx.outputs.map((o) => ({ value: Number(o.value), scriptpubkey: toHex(o.script) })),
    raw: hex,
  });
  (c.broadcasts ??= []).push({ txid: id, isolation, hex });
  return { txid: id };
}

/**
 * A Bitcoin Core / Knots / eCash node over JSON-RPC, answering from a FakeChain the way a real
 * node does: `gettxout` sees the mempool (an output spent there is gone, an unconfirmed one is
 * there with 0 confirmations); `getrawtransaction` finds mempool transactions, and confirmed ones
 * only with `txindex`; nothing ever names the transaction that spent an output.
 */
export class FakeNodeRpcTransport implements Transport {
  readonly route: Route = { via: "direct", hostClass: "loopback", reason: "fake" };
  calls: string[] = [];
  constructor(
    readonly chain: FakeChain,
    readonly opts: {
      txindex: boolean;
      /** testmempoolaccept: a reject reason, or undefined to accept. */
      accept?: (tx: import("../src/core/tx.ts").Tx) => string | undefined;
    },
  ) {}

  request(spec: RequestSpec): Promise<HttpResponse> {
    const { id, method, params } = JSON.parse(spec.body as string);
    this.calls.push(method);
    this.chain.requests.push(`rpc:${method}`);
    const c = this.chain;
    const ok = (result: unknown) =>
      Promise.resolve(response(200, JSON.stringify({ id, result, error: null })));
    const fail = (code: number, message: string) =>
      Promise.resolve(
        response(500, JSON.stringify({ id, result: null, error: { code, message } })),
      );
    if (c.fail?.test(`rpc:${method}`)) return fail(-1, "fake failure");
    switch (method) {
      case "getblockcount":
        return ok(c.tip);
      case "getblockhash":
        return params[0] > c.tip
          ? fail(-8, "Block height out of range")
          : ok(fakeHash(c, params[0]));
      case "getdeploymentinfo":
        return ok({ deployments: {}, blake2b: { height: 110, active: true } });
      case "getindexinfo":
        return ok(this.opts.txindex ? { txindex: { synced: true, best_block_height: c.tip } } : {});
      case "gettxout": {
        const [txid, vout] = params as [string, number];
        const tx = c.txs.get(txid);
        if (!tx?.vout[vout] || c.spends.has(`${txid}:${vout}`)) return ok(null);
        return ok({
          confirmations: tx.height === undefined ? 0 : c.tip - tx.height + 1,
          value: tx.vout[vout].value / 1e8,
        });
      }
      case "getrawtransaction": {
        const [txid, verbose] = params as [string, unknown];
        const tx = c.txs.get(txid);
        if (!tx || (tx.height !== undefined && !this.opts.txindex)) {
          return fail(
            -5,
            "No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries.",
          );
        }
        if (!verbose) {
          return tx.raw ? ok(tx.raw) : fail(-5, "No such mempool or blockchain transaction");
        }
        return ok({
          txid,
          vout: tx.vout.map((o) => ({ value: o.value / 1e8 })),
          ...(tx.height === undefined ? {} : {
            blockhash: tx.blockHash ?? fakeHash(c, tx.height),
            confirmations: c.tip - tx.height + 1,
          }),
        });
      }
      case "sendrawtransaction": {
        const r = fakeSend(c, params[0], spec.isolation);
        return r.txid ? ok(r.txid) : fail(-26, r.reason!);
      }
      case "testmempoolaccept": {
        const reason = this.opts.accept?.(parseTx(params[0][0]));
        return ok([{ allowed: !reason, "reject-reason": reason }]);
      }
      case "estimatesmartfee":
        return ok({ feerate: 0.00002 });
      default:
        return fail(-32601, `fake rpc: ${method}`);
    }
  }
}

/** A 164-byte header (XBT's v2 length, which skips the sha256d check) linking to `prevHash`. */
function fakeHeader(prevHash: string, height: number): string {
  const h = new Uint8Array(164).fill(height & 0xff);
  new DataView(h.buffer).setUint32(0, 0x2000_0000, true);
  h.set(Uint8Array.from(prevHash.match(/../g)!.map((x) => parseInt(x, 16))).reverse(), 4);
  return toHex(h);
}

/**
 * An Electrum server (Fulcrum, electrs) answering from a FakeChain over an in-memory connection.
 * It names the transaction that spent an output (from the script's history), like real servers.
 * Headers are served as 164-byte headers whose previous-hash field gives each block's hash.
 */
export class FakeElectrumConn {
  #out: Uint8Array[] = [];
  #wake?: () => void;
  #closed = false;
  #buf = "";
  constructor(readonly chain: FakeChain) {}

  write(p: Uint8Array): Promise<number> {
    this.#buf += new TextDecoder().decode(p);
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      const { id, method, params } = JSON.parse(line);
      let msg: unknown;
      try {
        msg = { jsonrpc: "2.0", id, result: this.answer(method, params) };
      } catch (error) {
        msg = { jsonrpc: "2.0", id, error: { code: 2, message: (error as Error).message } };
      }
      this.#out.push(new TextEncoder().encode(JSON.stringify(msg) + "\n"));
    }
    this.#wake?.();
    return Promise.resolve(p.length);
  }

  async read(p: Uint8Array): Promise<number | null> {
    while (!this.#out.length) {
      if (this.#closed) return null;
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
    const chunk = this.#out[0];
    const n = Math.min(chunk.length, p.length);
    p.set(chunk.subarray(0, n));
    if (n < chunk.length) this.#out[0] = chunk.subarray(n);
    else this.#out.shift();
    return n;
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  private byScripthash(sh: string) {
    const out: { txid: string; vout: number }[] = [];
    for (const [id, tx] of this.chain.txs) {
      tx.vout.forEach((o, vout) => {
        if (electrumScripthash(fromHexBytes(o.scriptpubkey)) === sh) out.push({ txid: id, vout });
      });
    }
    return out;
  }

  private answer(method: string, params: unknown[]): unknown {
    const c = this.chain;
    c.requests.push(`electrum:${method}`);
    if (c.fail?.test(`electrum:${method}`)) throw new Error("fake failure");
    switch (method) {
      case "server.version":
        return ["FakeElectrum", "1.4"];
      case "blockchain.headers.subscribe":
        return { height: c.tip, hex: fakeHeader(fakeHash(c, c.tip - 1), c.tip) };
      case "blockchain.block.header": {
        const h = params[0] as number;
        // Height tip+1 too: the backend reads a block's hash from the next header.
        if (h > c.tip + 1 || h < 1) throw new Error("height out of range");
        return fakeHeader(fakeHash(c, h - 1), h);
      }
      case "blockchain.transaction.get": {
        const tx = c.txs.get(params[0] as string);
        if (!tx?.raw) throw new Error("No such mempool or blockchain transaction");
        return tx.raw;
      }
      case "blockchain.scripthash.listunspent":
        return this.byScripthash(params[0] as string)
          .filter((o) => !c.spends.has(`${o.txid}:${o.vout}`))
          .map((o) => ({
            tx_hash: o.txid,
            tx_pos: o.vout,
            height: c.txs.get(o.txid)!.height ?? 0,
            value: c.txs.get(o.txid)!.vout[o.vout].value,
          }));
      case "blockchain.scripthash.get_history": {
        const hist: { tx_hash: string; height: number }[] = [];
        for (const o of this.byScripthash(params[0] as string)) {
          hist.push({ tx_hash: o.txid, height: c.txs.get(o.txid)!.height ?? 0 });
          const sp = c.spends.get(`${o.txid}:${o.vout}`);
          if (sp) hist.push({ tx_hash: sp.txid, height: sp.height ?? 0 });
        }
        return hist;
      }
      case "blockchain.transaction.broadcast": {
        const r = fakeSend(c, params[0] as string, "electrum");
        if (!r.txid) throw new Error(r.reason);
        return r.txid;
      }
      case "blockchain.estimatefee":
        return 0.00002;
      default:
        throw new Error(`unknown method ${method}`);
    }
  }
}

const fromHexBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
