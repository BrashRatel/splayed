/**
 * Electrum protocol backend (Fulcrum, electrs, ElectrumX).
 *
 * Block identity: Electrum serves raw headers. The XBT v2 header is 164 bytes and its block hash
 * is a BLAKE2b pipeline, but it keeps Bitcoin's 80-byte prefix (version, previous block hash, ...).
 * So the hash of block h is read from the previous-hash field of header h+1, which works for both
 * header families. For 80-byte headers we additionally require sha256d(header h) to match.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { BackendConfig } from "../core/config.ts";
import { fromHex, reverseBytes, toHex } from "../core/bytes.ts";
import type { ChainId } from "../core/profiles.ts";
import { electrumScripthash, parseTx, txid as computeTxid } from "../core/tx.ts";
import { openStream, type Route, TimeoutError, urlTarget } from "../net/transport.ts";
import {
  assertTxid,
  BackendError,
  type ChainBackend,
  type FoundUtxo,
  HEX64,
  type OutputObservation,
  type TxStatus,
} from "./types.ts";

const MAX_LINE = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export class ElectrumConnection {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private readonly reader: Promise<void>;

  constructor(private readonly conn: Deno.Conn, private readonly label: string) {
    this.reader = this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    const buf = new Uint8Array(64 * 1024);
    try {
      while (true) {
        const n = await this.conn.read(buf);
        if (n === null) break;
        this.buffer += decoder.decode(buf.subarray(0, n), { stream: true });
        if (this.buffer.length > MAX_LINE) throw new BackendError("Electrum response too large");
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line) this.dispatch(line);
        }
      }
      this.failAll(new BackendError(`Electrum server ${this.label} closed the connection`));
    } catch (error) {
      this.failAll(error instanceof Error ? error : new BackendError(String(error)));
    }
  }

  private dispatch(line: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string; code?: number } | string;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // notification
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      const message = typeof msg.error === "string" ? msg.error : msg.error.message ?? "error";
      // Status -1 marks an explicit server-side error (vs. a network failure).
      entry.reject(new BackendError(`Electrum: ${message}`, -1));
    } else entry.resolve(msg.result);
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  request<T>(method: string, params: unknown[] = [], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new BackendError("Electrum connection is closed"));
    const id = this.nextId++;
    const payload = new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`${this.label} ${method}`, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      (async () => {
        let offset = 0;
        while (offset < payload.length) offset += await this.conn.write(payload.subarray(offset));
      })().catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      try {
        this.conn.close();
      } catch { /* closed */ }
    }
    await this.reader.catch(() => {});
  }
}

function sha256d(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

function isNotFound(error: unknown): boolean {
  return /no such|not found|unknown transaction|missing transaction|invalid tx hash/i.test(
    (error as Error)?.message ?? "",
  );
}

export class ElectrumBackend implements ChainBackend {
  readonly remote: boolean;
  private connection?: Promise<ElectrumConnection>;
  private readonly rawCache = new Map<string, string>();

  constructor(
    readonly chain: ChainId,
    readonly config: BackendConfig,
    readonly route: Route,
    private readonly caCerts?: string[],
    private readonly connector?: () => Promise<Deno.Conn>,
  ) {
    this.remote = route.via === "socks" ||
      (route.hostClass !== "loopback" && route.hostClass !== "lan");
  }

  private async open(isolation: string): Promise<ElectrumConnection> {
    const target = urlTarget(this.config.url);
    const conn = this.connector
      ? await this.connector()
      : await openStream(this.route, { ...target, caCerts: this.caCerts, isolation });
    const c = new ElectrumConnection(conn, this.config.url);
    await c.request("server.version", ["", "1.4"]);
    return c;
  }

  /** Broadcasts on a separate connection (separate Tor circuit) from the one used for reads. */
  async broadcast(hex: string, isolation: string): Promise<string> {
    const c = await this.open(isolation);
    try {
      const txid = await c.request<string>("blockchain.transaction.broadcast", [hex]);
      if (typeof txid !== "string" || !HEX64.test(txid)) {
        throw new BackendError(`Unexpected broadcast response: ${String(txid).slice(0, 120)}`);
      }
      return txid;
    } finally {
      await c.close();
    }
  }

  private connect(): Promise<ElectrumConnection> {
    if (!this.connection) {
      this.connection = this.open(`${this.chain}:read`);
      this.connection.catch(() => (this.connection = undefined));
    }
    return this.connection;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    return await (await this.connect()).request<T>(method, params);
  }

  async close(): Promise<void> {
    const c = this.connection;
    this.connection = undefined;
    if (c) await (await c.catch(() => undefined))?.close();
  }

  async tipHeight(): Promise<number> {
    const tip = await this.call<{ height: number }>("blockchain.headers.subscribe");
    if (!Number.isSafeInteger(tip?.height)) throw new BackendError("Unexpected headers.subscribe");
    return tip.height;
  }

  private async header(height: number): Promise<Uint8Array> {
    const hex = await this.call<string>("blockchain.block.header", [height]);
    if (typeof hex !== "string" || !/^[0-9a-f]+$/iu.test(hex)) {
      throw new BackendError(`Unexpected header at ${height}`);
    }
    const bytes = fromHex(hex.toLowerCase());
    if (bytes.length !== 80 && bytes.length !== 164) {
      throw new BackendError(`Header at ${height} has unexpected length ${bytes.length}`);
    }
    return bytes;
  }

  async blockHash(height: number): Promise<string> {
    const next = await this.header(height + 1);
    const viaNext = toHex(reverseBytes(next.subarray(4, 36)));
    const own = await this.header(height);
    if (own.length === 80) {
      const direct = toHex(reverseBytes(sha256d(own)));
      if (direct !== viaNext) {
        throw new BackendError(`Headers at ${height} and ${height + 1} don't link`);
      }
    }
    return viaNext;
  }

  identityProblems(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async rawTransaction(txid: string): Promise<string> {
    assertTxid(txid);
    const cached = this.rawCache.get(txid);
    if (cached) return cached;
    const hex = await this.call<string>("blockchain.transaction.get", [txid]);
    if (typeof hex !== "string" || !/^[0-9a-f]+$/iu.test(hex)) {
      throw new BackendError(`Unexpected transaction response for ${txid}`);
    }
    if (computeTxid(parseTx(hex.toLowerCase())) !== txid) {
      throw new BackendError(`Server returned a transaction that doesn't hash to ${txid}`);
    }
    this.rawCache.set(txid, hex.toLowerCase());
    return hex.toLowerCase();
  }

  private async history(script: string): Promise<{ tx_hash: string; height: number }[]> {
    const list = await this.call<{ tx_hash: string; height: number }[]>(
      "blockchain.scripthash.get_history",
      [electrumScripthash(fromHex(script))],
    );
    if (!Array.isArray(list)) throw new BackendError("Unexpected get_history response");
    return list.filter((h) => typeof h.tx_hash === "string" && HEX64.test(h.tx_hash));
  }

  private async unspent(
    script: string,
  ): Promise<{ tx_hash: string; tx_pos: number; height: number; value: number }[]> {
    const list = await this.call<
      { tx_hash: string; tx_pos: number; height: number; value: number }[]
    >(
      "blockchain.scripthash.listunspent",
      [electrumScripthash(fromHex(script))],
    );
    if (!Array.isArray(list)) throw new BackendError("Unexpected listunspent response");
    return list;
  }

  async observeOutput(txid: string, vout: number): Promise<OutputObservation> {
    let raw: string;
    try {
      raw = await this.rawTransaction(txid);
    } catch (error) {
      if (isNotFound(error)) return { state: "absent" };
      throw error;
    }
    const output = parseTx(raw).outputs[vout];
    if (!output) throw new BackendError(`Transaction ${txid} has no output ${vout} on this chain`);
    const script = toHex(output.script);
    const value = Number(output.value);
    const utxo = (await this.unspent(script)).find((u) => u.tx_hash === txid && u.tx_pos === vout);
    if (utxo) {
      return { state: "unspent", value, createdHeight: utxo.height > 0 ? utxo.height : undefined };
    }
    for (const entry of await this.history(script)) {
      if (entry.tx_hash === txid) continue;
      const spender = parseTx(await this.rawTransaction(entry.tx_hash));
      if (spender.inputs.some((i) => i.txid === txid && i.vout === vout)) {
        return {
          state: "spent",
          value,
          spendTxid: entry.tx_hash,
          spendHeight: entry.height > 0 ? entry.height : undefined,
          spendDetailKnown: true,
        };
      }
    }
    // Exists, isn't unspent, but no spender in the script's history: inconsistent server.
    throw new BackendError(
      `Server says ${txid}:${vout} is spent but shows no spending transaction`,
    );
  }

  /**
   * Electrum has no "where is this txid" call, so ask for the history of its first output's script:
   * the server lists the transaction there with its height (0 or -1 while unconfirmed), or not at
   * all once it was dropped or replaced.
   */
  async txStatus(txid: string): Promise<TxStatus> {
    assertTxid(txid);
    let raw: string;
    try {
      raw = await this.rawTransaction(txid);
    } catch (error) {
      if (isNotFound(error)) return { state: "absent" };
      throw error;
    }
    const [first] = parseTx(raw).outputs;
    if (!first) throw new BackendError(`Transaction ${txid} has no outputs`);
    const entry = (await this.history(toHex(first.script))).find((h) => h.tx_hash === txid);
    if (!entry) return { state: "absent" };
    if (!Number.isSafeInteger(entry.height)) throw new BackendError("Malformed history entry");
    if (entry.height <= 0) return { state: "mempool" };
    return { state: "confirmed", height: entry.height, blockHash: await this.hashAt(entry.height) };
  }

  /** Block hash at a height: hashed directly for 80-byte headers, else via the next header. */
  private async hashAt(height: number): Promise<string> {
    const own = await this.header(height);
    if (own.length === 80) return toHex(reverseBytes(sha256d(own)));
    return await this.blockHash(height);
  }

  async addressTxCount(_address: string, scriptPubKey: string): Promise<number> {
    return (await this.history(scriptPubKey)).length;
  }

  async addressUtxos(_address: string, scriptPubKey: string): Promise<FoundUtxo[]> {
    return (await this.unspent(scriptPubKey)).map((u) => {
      if (
        !HEX64.test(u.tx_hash) || !Number.isSafeInteger(u.tx_pos) || !Number.isSafeInteger(u.value)
      ) {
        throw new BackendError("Malformed listunspent entry");
      }
      return {
        txid: u.tx_hash,
        vout: u.tx_pos,
        value: u.value,
        scriptPubKey,
        height: u.height > 0 ? u.height : undefined,
      };
    });
  }

  async feeRate(targetBlocks: number): Promise<number | undefined> {
    const btcPerKb = await this.call<number>("blockchain.estimatefee", [targetBlocks]);
    if (typeof btcPerKb !== "number" || btcPerKb <= 0) return undefined;
    return btcPerKb * 100_000; // BTC/kB -> sat/vB
  }
}
