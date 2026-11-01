/**
 * verify / broadcast / track for a written plan.
 *
 * Everything that matters for safety is re-derived from the plan directory the tool wrote itself
 * (plan.json + the unsigned PSBTs); the signer's output only contributes signatures.
 */
import { join } from "node:path";
import { base64 } from "@scure/base";
import type { ChainBackend } from "../backends/types.ts";
import { fromHex, toHex } from "./bytes.ts";
import type { ChainId } from "./profiles.ts";
import { ECX_MAINNET_REPLAY_LOCKTIME } from "./profiles.ts";
import type { Plan, PlannedTx } from "./planner.ts";
import { decodePsbt, type Psbt, PSBT_MAGIC } from "./psbt.ts";
import {
  extractSignatures,
  finalize,
  inputContexts,
  sameUnsigned,
  SigCheckError,
  verifyInputs,
} from "./sigcheck.ts";
import { readJson, writeJsonAtomic } from "./store.ts";
import { parseTx, serializeTx, type Tx, txid as computeTxid } from "./tx.ts";

export class ExecuteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecuteError";
  }
}

export interface TxProgress {
  verified?: {
    at: string;
    txid: string;
    finalHex: string;
    checks: string[];
    mempool?: Record<string, string>;
  };
  broadcast?: {
    /** "replaced": a fee-bump plan has since been broadcast for this transaction. */
    status: "sending" | "accepted" | "unknown" | "rejected" | "conflict" | "replaced";
    at: string;
    backend: string;
    attempts: number;
    detail?: string;
  };
  /** Last confirmation `track` saw; the block hash is how a later reorg is noticed. */
  confirmations?: { depth: number; at: string; height?: number; blockHash?: string };
  /** Everything `track` has had to warn about, oldest first. */
  reorgs?: { at: string; kind: ReorgKind; detail: string }[];
  /** Set on the original when a fee-bump plan replaced it. */
  replacedBy?: { plan: string; file: string };
}

export type ReorgKind = "moved" | "unconfirmed" | "dropped" | "conflict";

export interface Progress {
  version: 1;
  txs: Record<string, TxProgress>;
}

export async function loadPlanDir(
  dataDir: string,
  idOrPath: string,
): Promise<{ dir: string; plan: Plan }> {
  const candidates = [idOrPath, join(dataDir, "plans", idOrPath)];
  for (const dir of candidates) {
    const plan = await readJson<Plan>(join(dir, "plan.json")).catch(() => undefined);
    if (plan) return { dir, plan };
  }
  throw new ExecuteError(`No plan "${idOrPath}". See \`forksplit plans\`.`);
}

export async function loadProgress(dir: string): Promise<Progress> {
  return (await readJson<Progress>(join(dir, "progress.json"))) ?? { version: 1, txs: {} };
}

export async function saveProgress(dir: string, progress: Progress): Promise<void> {
  await writeJsonAtomic(join(dir, "progress.json"), progress);
}

export async function ownPsbt(dir: string, tx: PlannedTx): Promise<Psbt> {
  const own = decodePsbt((await Deno.readTextFile(join(dir, tx.file))).trim());
  // The file on disk must still be the plan's own PSBT.
  if (computeTxid(own.tx) !== tx.unsignedTxid) {
    throw new ExecuteError(`${tx.file} no longer matches plan.json; don't edit plan files`);
  }
  return own;
}

/** Reads a signer's output: PSBT (binary, base64 or hex) or a raw transaction (hex). */
export function readSignedArtifact(bytes: Uint8Array): { psbt?: Psbt; tx?: Tx } {
  if (bytes.length >= 5 && toHex(bytes.subarray(0, 5)) === toHex(PSBT_MAGIC)) {
    return { psbt: decodePsbt(bytes) };
  }
  const text = new TextDecoder().decode(bytes).trim();
  if (text.startsWith("cHNidP")) return { psbt: decodePsbt(text) };
  if (/^[0-9a-fA-F]+$/u.test(text) && text.length % 2 === 0) {
    const raw = fromHex(text.toLowerCase());
    if (toHex(raw.subarray(0, 5)) === toHex(PSBT_MAGIC)) return { psbt: decodePsbt(raw) };
    return { tx: parseTx(raw) };
  }
  try {
    return { psbt: decodePsbt(base64.decode(text)) };
  } catch {
    throw new ExecuteError("Not a PSBT or a raw transaction");
  }
}

export interface VerifiedTx {
  final: Tx;
  finalHex: string;
  txid: string;
  checks: string[];
}

/**
 * Offline verification of one signed transaction against its plan entry. Throws on any problem.
 */
export function verifySigned(
  planTx: PlannedTx,
  own: Psbt,
  signed: { psbt?: Psbt; tx?: Tx },
): VerifiedTx {
  const checks: string[] = [];
  const candidate = signed.tx ?? signed.psbt!.tx;
  if (!sameUnsigned(candidate, own.tx)) {
    throw new SigCheckError(
      "The signed transaction differs from the planned one (inputs, outputs, locktime or sequence)",
    );
  }
  checks.push("transaction matches the plan");
  if (planTx.chain === "ecx") {
    if (
      own.tx.lockTime !== ECX_MAINNET_REPLAY_LOCKTIME ||
      planTx.lockTime !== ECX_MAINNET_REPLAY_LOCKTIME
    ) {
      throw new SigCheckError("ECX transaction is missing nLockTime 499999998");
    }
    if (!own.tx.inputs.some((i) => i.sequence < 0xffff_ffff)) {
      throw new SigCheckError(
        "ECX transaction needs a non-final input sequence for the marker to bite",
      );
    }
    checks.push("ECX replay marker: nLockTime 499999998 with non-final sequences");
  }
  if (planTx.donor) {
    const d = planTx.donor;
    if (planTx.chain !== "xbt") throw new SigCheckError("Only XBT transactions use a donor");
    if (!own.tx.inputs.some((i) => i.txid === d.txid && i.vout === d.vout)) {
      throw new SigCheckError(
        `The donor input ${d.txid}:${d.vout} is missing from the transaction`,
      );
    }
    checks.push(
      `donor input ${d.txid.slice(0, 8)}:${d.vout} (${d.provenance}) is part of the transaction`,
    );
  }
  const unifiedMode = planTx.chain === "xbt" && !planTx.donor;
  const ctxs = inputContexts(own, planTx.inputs.map((i) => i.kind));
  const verdicts = verifyInputs(
    own.tx,
    ctxs,
    extractSignatures(ctxs, signed),
    unifiedMode ? "unified" : "standard",
  );
  checks.push(
    planTx.donor
      ? "every signature is plain SIGHASH_ALL and verifies; each commits to the XBT-only donor input"
      : planTx.chain === "xbt"
      ? "every XBT signature is SIGHASH_ALL|UNIFIED (0x21) and verifies under the unified digest"
      : "every signature is SIGHASH_ALL/DEFAULT and verifies",
  );
  const inValue = ctxs.reduce((s, c) => s + c.spent.value, 0n);
  const outValue = own.tx.outputs.reduce((s, o) => s + o.value, 0n);
  if (Number(inValue - outValue) !== planTx.fee) {
    throw new SigCheckError("Fee differs from the plan");
  }
  checks.push(`fee ${planTx.fee} sats as planned`);
  const final = finalize(own.tx, ctxs, verdicts);
  const finalTxid = computeTxid(final);
  // The txid only survives signing when no input has a scriptSig. P2SH-wrapped segwit inputs put
  // the redeem script in their scriptSig, so their final txid differs from the unsigned one.
  const txidIsStable = planTx.inputs.every((i) =>
    i.kind === "wpkh" || i.kind === "wsh-ms" || i.kind === "tr"
  );
  if (txidIsStable && finalTxid !== planTx.unsignedTxid) {
    throw new SigCheckError("Final txid differs from the plan");
  }
  return { final, finalHex: toHex(serializeTx(final)), txid: finalTxid, checks };
}

/** Matches signer output files to planned transactions by content. */
export async function matchArtifacts(
  dir: string,
  plan: Plan,
  files: string[],
): Promise<
  { matched: Map<string, { file: string; signed: { psbt?: Psbt; tx?: Tx } }>; unmatched: string[] }
> {
  const owns = await Promise.all(
    plan.transactions.map(async (t) => ({ t, own: await ownPsbt(dir, t) })),
  );
  const matched = new Map<string, { file: string; signed: { psbt?: Psbt; tx?: Tx } }>();
  const unmatched: string[] = [];
  for (const file of files) {
    let signed: { psbt?: Psbt; tx?: Tx };
    try {
      signed = readSignedArtifact(await Deno.readFile(file));
    } catch {
      unmatched.push(file);
      continue;
    }
    const candidate = signed.tx ?? signed.psbt!.tx;
    const hit = owns.find(({ own }) => sameUnsigned(candidate, own.tx));
    if (hit) matched.set(hit.t.file, { file, signed });
    else unmatched.push(file);
  }
  return { matched, unmatched };
}

/** Signed files the user saved inside the plan directory. */
export async function findSignedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ["ecx", "xbt", "uploads", "."]) {
    try {
      for await (const e of Deno.readDir(join(dir, sub))) {
        if (!e.isFile) continue;
        const name = e.name.toLowerCase();
        if (name.includes("signed") || /\.(hex|txn)$/u.test(name)) out.push(join(dir, sub, e.name));
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return out.sort();
}

export interface MempoolNode {
  chain: ChainId;
  backend: ChainBackend;
}

/**
 * Asks the user's OWN nodes (RPC) whether they'd accept the transaction. Never broadcasts.
 * The target chain should accept it; any other chain accepting it means it would replay.
 */
export async function mempoolChecks(
  planTx: PlannedTx,
  hex: string,
  nodes: MempoolNode[],
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  for (const { chain, backend } of nodes) {
    if (!backend.testMempoolAccept) continue;
    const r = await backend.testMempoolAccept(hex);
    if (chain === planTx.chain) {
      results[chain] = r.allowed ? "accepted by your node" : `rejected by your node: ${r.reason}`;
      if (!r.allowed && !/missing|spent|conflict|already/i.test(r.reason ?? "")) {
        throw new SigCheckError(`Your ${chain.toUpperCase()} node rejects it: ${r.reason}`);
      }
    } else {
      if (r.allowed) {
        throw new SigCheckError(
          `Your ${chain.toUpperCase()} node would ACCEPT this ${planTx.chain.toUpperCase()} transaction: ` +
            "it is NOT replay-protected. Do not broadcast it.",
        );
      }
      results[chain] = `rejected (good): ${r.reason}`;
    }
  }
  return results;
}

export interface DepthResult {
  /**
   * confirmed: in the active chain. mempool: seen but unconfirmed. absent: neither, and its inputs
   * are still unspent. conflict: its inputs were spent by something else. unknown: this backend
   * can't say (node RPC without txindex can't report a confirmed spend's details).
   */
  state: "confirmed" | "mempool" | "absent" | "conflict" | "unknown";
  depth?: number;
  height?: number;
  blockHash?: string;
  /** The transaction that spent the inputs instead, when the backend knows it. */
  by?: string;
}

/**
 * Where the plan transaction is on its chain. Asks about the transaction itself first (needs a
 * backend with txStatus); falls back to judging by what spent its first input.
 */
export async function confirmationDepth(
  backend: ChainBackend,
  planTx: PlannedTx,
  txid: string,
  tip: number,
): Promise<DepthResult> {
  const status = await backend.txStatus?.(txid);
  if (status?.state === "confirmed") {
    return {
      state: "confirmed",
      depth: tip - status.height + 1,
      height: status.height,
      blockHash: status.blockHash,
    };
  }
  if (status?.state === "mempool") return { state: "mempool" };

  const first = planTx.inputs[0];
  const obs = await backend.observeOutput(first.txid, first.vout);
  if (obs.state === "unspent") return { state: "absent" };
  if (status?.state === "absent") {
    // Not on the chain and not in the mempool, yet the input is gone: someone else spent it.
    return {
      state: "conflict",
      by: obs.state === "spent" ? obs.spendTxid : undefined,
    };
  }
  if (obs.state !== "spent") return { state: obs.state === "absent" ? "absent" : "unknown" };
  if (obs.spendTxid && obs.spendTxid !== txid) return { state: "conflict", by: obs.spendTxid };
  if (!obs.spendDetailKnown) return { state: "unknown" };
  if (obs.spendHeight === undefined) return { state: "mempool" };
  return {
    state: "confirmed",
    depth: tip - obs.spendHeight + 1,
    height: obs.spendHeight,
    blockHash: await backend.blockHash(obs.spendHeight),
  };
}

export interface ReorgAlert {
  kind: ReorgKind;
  detail: string;
}

const short = (hash?: string) => (hash ? `${hash.slice(0, 12)}…` : "unknown block");

/**
 * Compares what `track` saw last time with what it sees now. Only a transaction that was once
 * seen confirmed can be "reorged"; a conflict is always worth shouting about.
 */
export function assessReorg(
  chain: ChainId,
  prev: TxProgress["confirmations"] | undefined,
  now: DepthResult,
): ReorgAlert | undefined {
  const label = chain.toUpperCase();
  switch (now.state) {
    case "conflict":
      return {
        kind: "conflict",
        detail:
          `${label}: this split's input was spent by ${
            now.by ? `transaction ${now.by}` : "another transaction"
          }, not by this split. If you did not make that spend, treat the key as compromised; if ` +
          `you spent the BTC copy ordinarily, it was replayed onto ${label}.`,
      };
    case "confirmed":
      if (prev?.blockHash && now.blockHash && prev.blockHash !== now.blockHash) {
        return {
          kind: "moved",
          detail:
            `${label}: REORG. This split was in block ${short(prev.blockHash)} (height ${
              prev.height ?? "?"
            }) and is now in block ${short(now.blockHash)} (height ${now.height}). ` +
            "It is still confirmed, but in a different block: wait for it to be deep again.",
        };
      }
      return undefined;
    case "mempool":
      return prev
        ? {
          kind: "unconfirmed",
          detail: `${label}: REORG. This split was confirmed (${prev.depth} deep) and is back in ` +
            "the mempool. It should confirm again; do not spend the BTC copy until it does.",
        }
        : undefined;
    case "absent":
      return prev
        ? {
          kind: "dropped",
          detail: `${label}: REORG. This split was confirmed (${prev.depth} deep) and has left ` +
            `the chain; it is not in the mempool and its input is unspent again, so the coin is ` +
            `back on ${label} and still shared with BTC. Do NOT spend the BTC copy. Run ` +
            "`forksplit broadcast` to send it again, or `forksplit bump` to replace it.",
        }
        : undefined;
    case "unknown":
      return undefined;
  }
}
