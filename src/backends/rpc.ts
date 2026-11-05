import type { BackendConfig } from "../core/config.ts";
import type { ChainId } from "../core/profiles.ts";
import type { Route, Transport } from "../net/transport.ts";
import { parseTx, txid as computeTxid } from "../core/tx.ts";
import {
  assertTxid,
  BackendError,
  type ChainBackend,
  type FoundUtxo,
  HEX64,
  type OutputObservation,
  type TxStatus,
} from "./types.ts";

/** Bitcoin Core / Knots / eCash node JSON-RPC. Works without any address index. */
export class RpcBackend implements ChainBackend {
  readonly remote: boolean;
  private nextId = 1;
  private txindex: boolean | undefined;

  constructor(
    readonly chain: ChainId,
    readonly config: BackendConfig,
    private readonly transport: Transport,
    private readonly authorization: string,
    private readonly requiredDeployment?: string,
  ) {
    this.remote = transport.route.via === "socks";
  }

  get route(): Route {
    return this.transport.route;
  }

  async broadcast(hex: string, isolation: string): Promise<string> {
    const txid = await this.call<string>("sendrawtransaction", [hex], undefined, isolation);
    if (typeof txid !== "string" || !HEX64.test(txid)) {
      throw new BackendError("Unexpected sendrawtransaction result");
    }
    return txid;
  }

  async testMempoolAccept(hex: string): Promise<{ allowed: boolean; reason?: string }> {
    const [r] = await this.call<{ allowed: boolean; "reject-reason"?: string }[]>(
      "testmempoolaccept",
      [[hex]],
    );
    if (typeof r?.allowed !== "boolean") {
      throw new BackendError("Unexpected testmempoolaccept result");
    }
    return { allowed: r.allowed, reason: r["reject-reason"] };
  }

  async call<T>(
    method: string,
    params: unknown[] = [],
    timeoutMs?: number,
    isolation = `${this.chain}:rpc`,
  ): Promise<T> {
    const id = this.nextId++;
    const response = await this.transport.request({
      url: this.config.url,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.authorization },
      // "2.0": Bitcoin Core (28+) and the pruned-node alternatives accept it, and bitcoinpr
      // rejects anything else. A 2.0 reply may omit "error" on success and answers errors with
      // HTTP 200, so callers go by the payload's error code, never the HTTP status.
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      isolation,
      timeoutMs,
    });
    if (response.status === 401 || response.status === 403) {
      throw new BackendError(`RPC authentication failed for ${this.config.url}`, response.status);
    }
    let payload: { result?: T; error?: { code: number; message: string } | null };
    try {
      payload = response.json();
    } catch {
      throw new BackendError(`RPC ${method} returned HTTP ${response.status} with invalid JSON`);
    }
    if (payload.error) {
      const error = new BackendError(`RPC ${method}: ${payload.error.message}`, response.status);
      (error as BackendError & { rpcCode?: number }).rpcCode = payload.error.code;
      throw error;
    }
    return payload.result as T;
  }

  async tipHeight(): Promise<number> {
    const height = await this.call<number>("getblockcount");
    if (!Number.isSafeInteger(height)) throw new BackendError("Unexpected getblockcount result");
    return height;
  }

  async blockHash(height: number): Promise<string> {
    const hash = await this.call<string>("getblockhash", [height]);
    if (typeof hash !== "string" || !HEX64.test(hash)) {
      throw new BackendError(`Unexpected getblockhash result at ${height}`);
    }
    return hash;
  }

  async identityProblems(): Promise<string[]> {
    const problems: string[] = [];
    if (this.requiredDeployment) {
      try {
        // Knots reports the BLAKE2b fork at the top level of the result ({height, active}), not
        // under "deployments" with the soft forks (src/rpc/blockchain.cpp, getdeploymentinfo).
        const info = await this.call<Record<string, { active?: boolean } | undefined>>(
          "getdeploymentinfo",
        );
        if (info[this.requiredDeployment]?.active !== true) {
          problems.push(`getdeploymentinfo does not report "${this.requiredDeployment}" active`);
        }
      } catch (error) {
        problems.push(`getdeploymentinfo failed: ${(error as Error).message}`);
      }
    }
    return problems;
  }

  private async hasTxindex(): Promise<boolean> {
    if (this.txindex === undefined) {
      try {
        const info = await this.call<Record<string, { synced?: boolean }>>("getindexinfo");
        this.txindex = info?.txindex?.synced === true;
      } catch {
        this.txindex = false;
      }
    }
    return this.txindex;
  }

  async observeOutput(txid: string, vout: number): Promise<OutputObservation> {
    assertTxid(txid);
    const out = await this.call<
      { confirmations: number; value: number } | null
    >("gettxout", [txid, vout, true]);
    if (out) {
      const tip = await this.tipHeight();
      return {
        state: "unspent",
        value: btcToSats(out.value),
        createdHeight: out.confirmations > 0 ? tip - out.confirmations + 1 : undefined,
      };
    }
    // Not in the UTXO set: spent, or never existed. Only a transaction index can tell.
    if (!(await this.hasTxindex())) return { state: "gone" };
    try {
      const tx = await this.call<{ vout?: { value: number }[] }>("getrawtransaction", [txid, 1]);
      const output = tx.vout?.[vout];
      if (!output) return { state: "absent" };
      return { state: "spent", value: btcToSats(output.value), spendDetailKnown: false };
    } catch (error) {
      if ((error as { rpcCode?: number }).rpcCode === -5) return { state: "absent" };
      throw error;
    }
  }

  async txStatus(txid: string): Promise<TxStatus> {
    assertTxid(txid);
    try {
      const tx = await this.call<{ blockhash?: string; confirmations?: number }>(
        "getrawtransaction",
        [txid, 1],
      );
      if (!tx.blockhash) return { state: "mempool" };
      // A transaction in a block that is no longer on the active chain reports no confirmations
      // (and returns to the mempool if the node still holds it, which is answered above).
      if (!(typeof tx.confirmations === "number" && tx.confirmations > 0)) {
        return { state: "absent" };
      }
      const tip = await this.tipHeight();
      return {
        state: "confirmed",
        height: tip - tx.confirmations + 1,
        blockHash: tx.blockhash,
      };
    } catch (error) {
      if ((error as { rpcCode?: number }).rpcCode !== -5) throw error;
      // Not in the mempool. Only a transaction index can say whether it was ever confirmed.
      return (await this.hasTxindex()) ? { state: "absent" } : { state: "unknown" };
    }
  }

  async rawTransaction(txid: string): Promise<string> {
    assertTxid(txid);
    let hex: string;
    try {
      hex = await this.call<string>("getrawtransaction", [txid, 0]);
    } catch (error) {
      throw new BackendError(
        `${(error as Error).message}. (Node RPC needs txindex=1 to fetch confirmed transactions.)`,
      );
    }
    if (typeof hex !== "string" || computeTxid(parseTx(hex)) !== txid) {
      throw new BackendError(`Node returned a transaction that doesn't hash to ${txid}`);
    }
    return hex.toLowerCase();
  }

  async feeRate(targetBlocks: number): Promise<number | undefined> {
    const r = await this.call<{ feerate?: number }>("estimatesmartfee", [targetBlocks]);
    return typeof r?.feerate === "number" && r.feerate > 0 ? r.feerate * 100_000 : undefined;
  }

  async scanDescriptors(
    descriptors: { desc: string; range?: [number, number] }[],
  ): Promise<FoundUtxo[]> {
    const result = await this.call<
      {
        success: boolean;
        unspents: {
          txid: string;
          vout: number;
          scriptPubKey: string;
          amount: number;
          height: number;
        }[];
      }
    >(
      "scantxoutset",
      ["start", descriptors.map((d) => (d.range ? { desc: d.desc, range: d.range } : d.desc))],
      30 * 60_000,
    );
    if (!result?.success) throw new BackendError("scantxoutset did not complete");
    return result.unspents.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: btcToSats(u.amount),
      scriptPubKey: u.scriptPubKey,
      height: u.height > 0 ? u.height : undefined,
    }));
  }
}

/** JSON-RPC amounts are decimal BTC; convert without float drift. */
export function btcToSats(amount: number): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new BackendError(`Invalid amount ${amount}`);
  }
  const [whole, frac = ""] = amount.toFixed(8).split(".");
  const sats = Number(whole) * 100_000_000 + Number(frac.padEnd(8, "0"));
  if (!Number.isSafeInteger(sats)) throw new BackendError(`Amount out of range: ${amount}`);
  return sats;
}

export async function rpcAuthorization(
  auth: BackendConfig["auth"],
  env: Record<string, string | undefined>,
): Promise<string> {
  if (auth?.cookieFile) {
    const path = auth.cookieFile.replace(/^~(?=\/|$)/u, env.HOME ?? "~");
    let cookie: string;
    try {
      cookie = (await Deno.readTextFile(path)).trim();
    } catch (error) {
      throw new BackendError(`Cannot read RPC cookie file ${path}: ${(error as Error).message}`);
    }
    return `Basic ${btoa(cookie)}`;
  }
  if (auth?.user) {
    const password = auth.passwordEnv ? env[auth.passwordEnv] : undefined;
    if (!password) {
      throw new BackendError(
        `RPC user "${auth.user}" needs a password in the environment variable ` +
          `${auth.passwordEnv ?? "(set password_env)"}`,
      );
    }
    return `Basic ${btoa(`${auth.user}:${password}`)}`;
  }
  throw new BackendError("RPC backends need cookie_file, or user + password_env");
}
