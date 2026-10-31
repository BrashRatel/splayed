// Response validation patterns adapted from smolcars/ecashjr-wallet src/core/esplora.ts (MIT).
import type { BackendConfig } from "../core/config.ts";
import type { ChainId } from "../core/profiles.ts";
import type { Route, Transport } from "../net/transport.ts";
import {
  assertTxid,
  BackendError,
  type ChainBackend,
  type FoundUtxo,
  HEX64,
  type OutputObservation,
} from "./types.ts";

interface EsploraStatus {
  confirmed: boolean;
  block_height?: number;
}

interface EsploraTx {
  txid: string;
  vout: { value: number; scriptpubkey: string }[];
  status: EsploraStatus;
}

interface EsploraOutspend {
  spent: boolean;
  txid?: string | null;
  status?: EsploraStatus;
}

function validStatus(value: unknown): value is EsploraStatus {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  if (typeof s.confirmed !== "boolean") return false;
  if (s.confirmed && !(Number.isSafeInteger(s.block_height) && (s.block_height as number) >= 0)) {
    return false;
  }
  return true;
}

export class EsploraBackend implements ChainBackend {
  readonly remote: boolean;
  private readonly isolation: string;

  constructor(
    readonly chain: ChainId,
    readonly config: BackendConfig,
    private readonly transport: Transport,
  ) {
    this.remote = transport.route.via === "socks" ||
      (transport.route.hostClass !== "loopback" && transport.route.hostClass !== "lan");
    this.isolation = `${chain}:read`;
  }

  get route(): Route {
    return this.transport.route;
  }

  private async get(path: string): Promise<{ status: number; text: string }> {
    const response = await this.transport.request({
      url: `${this.config.url}${path}`,
      isolation: this.isolation,
    });
    const text = response.text();
    if (response.status === 429) {
      throw new BackendError(`Rate limited by ${this.config.url} (HTTP 429)`, 429, true);
    }
    return { status: response.status, text };
  }

  private async getOk(path: string): Promise<string> {
    const { status, text } = await this.get(path);
    if (status < 200 || status >= 300) {
      throw new BackendError(`GET ${path} returned HTTP ${status}: ${text.slice(0, 120)}`, status);
    }
    return text;
  }

  private async getJson<T>(path: string): Promise<T> {
    const text = await this.getOk(path);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BackendError(`GET ${path} returned invalid JSON`);
    }
  }

  async tipHeight(): Promise<number> {
    const text = (await this.getOk("/blocks/tip/height")).trim();
    const height = Number(text);
    if (!/^\d+$/u.test(text) || !Number.isSafeInteger(height)) {
      throw new BackendError(`Unexpected tip height response: ${text.slice(0, 40)}`);
    }
    return height;
  }

  async blockHash(height: number): Promise<string> {
    const text = (await this.getOk(`/block-height/${height}`)).trim().toLowerCase();
    if (!HEX64.test(text)) throw new BackendError(`Unexpected block hash response at ${height}`);
    return text;
  }

  identityProblems(): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * Existence first, then spentness. `/tx/{txid}/outspend/{n}` answers `{"spent":false}` even for
   * transactions that don't exist (the "Esplora trap" documented by the eCash mobile wallet), so
   * it must never be asked on its own.
   */
  async observeOutput(txid: string, vout: number): Promise<OutputObservation> {
    assertTxid(txid);
    const { status, text } = await this.get(`/tx/${txid}`);
    if (status === 404) return { state: "absent" };
    if (status < 200 || status >= 300) {
      throw new BackendError(`GET /tx/${txid} returned HTTP ${status}`, status);
    }
    let tx: EsploraTx;
    try {
      tx = JSON.parse(text) as EsploraTx;
    } catch {
      throw new BackendError(`GET /tx/${txid} returned invalid JSON`);
    }
    if (tx.txid !== txid || !Array.isArray(tx.vout) || !validStatus(tx.status)) {
      throw new BackendError(`GET /tx/${txid} returned an unexpected transaction`);
    }
    const output = tx.vout[vout];
    if (!output || !Number.isSafeInteger(output.value)) {
      throw new BackendError(`Transaction ${txid} has no output ${vout} on this chain`);
    }
    const outspend = await this.getJson<EsploraOutspend>(`/tx/${txid}/outspend/${vout}`);
    if (typeof outspend.spent !== "boolean") {
      throw new BackendError(`Unexpected outspend response for ${txid}:${vout}`);
    }
    if (!outspend.spent) {
      return {
        state: "unspent",
        value: output.value,
        createdHeight: tx.status.confirmed ? tx.status.block_height : undefined,
      };
    }
    const spendStatus = validStatus(outspend.status) ? outspend.status : undefined;
    return {
      state: "spent",
      value: output.value,
      spendTxid: typeof outspend.txid === "string" ? outspend.txid : undefined,
      spendHeight: spendStatus?.confirmed ? spendStatus.block_height : undefined,
      spendDetailKnown: spendStatus !== undefined,
    };
  }

  async addressTxCount(address: string): Promise<number> {
    const info = await this.getJson<{
      chain_stats?: { tx_count?: number };
      mempool_stats?: { tx_count?: number };
    }>(`/address/${encodeURIComponent(address)}`);
    const chain = info.chain_stats?.tx_count;
    const mempool = info.mempool_stats?.tx_count ?? 0;
    if (!Number.isSafeInteger(chain) || !Number.isSafeInteger(mempool)) {
      throw new BackendError(`Unexpected address stats for ${address}`);
    }
    return (chain as number) + mempool;
  }

  async addressUtxos(address: string, scriptPubKey: string): Promise<FoundUtxo[]> {
    const list = await this.getJson<unknown[]>(`/address/${encodeURIComponent(address)}/utxo`);
    if (!Array.isArray(list)) throw new BackendError(`Unexpected UTXO list for ${address}`);
    return list.map((raw) => {
      const u = raw as { txid?: string; vout?: number; value?: number; status?: unknown };
      if (
        typeof u.txid !== "string" || !HEX64.test(u.txid) || !Number.isSafeInteger(u.vout) ||
        !Number.isSafeInteger(u.value) || !validStatus(u.status)
      ) {
        throw new BackendError(`Malformed UTXO entry for ${address}`);
      }
      return {
        txid: u.txid,
        vout: u.vout as number,
        value: u.value as number,
        scriptPubKey,
        height: u.status.confirmed ? u.status.block_height : undefined,
      };
    });
  }
}
