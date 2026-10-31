import type { BackendConfig } from "../core/config.ts";
import type { ChainId } from "../core/profiles.ts";
import type { Route } from "../net/transport.ts";

/** What one chain says about one outpoint. "unknown" is never treated as safe. */
export type OutputObservation =
  | {
    state: "unspent";
    value: number;
    /** Height of the creating transaction; undefined while unconfirmed. */
    createdHeight?: number;
  }
  | {
    state: "spent";
    value?: number;
    spendTxid?: string;
    /** Height of the spending transaction; undefined while unconfirmed or not reported. */
    spendHeight?: number;
    /** False when the backend can tell it is spent but cannot report by what or how deep. */
    spendDetailKnown: boolean;
  }
  | { state: "absent" }
  /** Spent or never existed; the backend cannot tell which (node RPC without txindex). */
  | { state: "gone" }
  | { state: "unknown"; error: string };

/**
 * What a chain says about one transaction. "absent" means the backend knows the transaction is
 * neither confirmed nor in its mempool; "unknown" means it cannot tell (node RPC without txindex
 * cannot distinguish "never existed" from "confirmed long ago").
 */
export type TxStatus =
  | { state: "confirmed"; height: number; blockHash: string }
  | { state: "mempool" }
  | { state: "absent" }
  | { state: "unknown" };

export interface FoundUtxo {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
  height?: number;
}

export interface ChainBackend {
  readonly chain: ChainId;
  readonly config: BackendConfig;
  readonly route: Route;
  /** True when requests leave the machine/LAN, so pacing/jitter applies. */
  readonly remote: boolean;
  tipHeight(): Promise<number>;
  blockHash(height: number): Promise<string>;
  /** Extra identity problems specific to this backend type (empty = fine). */
  identityProblems(): Promise<string[]>;
  observeOutput(txid: string, vout: number): Promise<OutputObservation>;
  /** Where a transaction is right now: in the active chain (and which block), mempool, or neither. */
  txStatus?(txid: string): Promise<TxStatus>;
  /** Raw transaction hex, verified to hash to `txid` before it is returned. */
  rawTransaction(txid: string): Promise<string>;
  /** Fee rate estimate in sat/vB, or undefined when the backend has none. */
  feeRate?(targetBlocks: number): Promise<number | undefined>;
  close?(): Promise<void>;
  /** Sends a raw transaction to THIS chain over its own isolated circuit. Returns the txid. */
  broadcast(hex: string, isolation: string): Promise<string>;
  /** Node RPC only: would this node accept the transaction? Never broadcasts. */
  testMempoolAccept?(hex: string): Promise<{ allowed: boolean; reason?: string }>;
  /** Address-based discovery (Esplora/Electrum). */
  addressTxCount?(address: string, scriptPubKey: string): Promise<number>;
  addressUtxos?(address: string, scriptPubKey: string): Promise<FoundUtxo[]>;
  /** Descriptor-based discovery (node RPC scantxoutset); runs entirely on the node. */
  scanDescriptors?(descriptors: { desc: string; range?: [number, number] }[]): Promise<FoundUtxo[]>;
}

export class BackendError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = "BackendError";
  }
}

export const HEX64 = /^[0-9a-f]{64}$/u;

export function assertTxid(txid: string): void {
  if (!HEX64.test(txid)) throw new BackendError(`Invalid txid: ${txid}`);
}
