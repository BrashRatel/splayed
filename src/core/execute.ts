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
    status: "sending" | "accepted" | "unknown" | "rejected" | "conflict";
    at: string;
    backend: string;
    attempts: number;
    detail?: string;
  };
  confirmations?: { depth: number; at: string };
}

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
  const ctxs = inputContexts(own, planTx.inputs.map((i) => i.kind));
  const verdicts = verifyInputs(
    own.tx,
    ctxs,
    extractSignatures(ctxs, signed),
    planTx.chain === "xbt" ? "unified" : "standard",
  );
  checks.push(
    planTx.chain === "xbt"
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
  const allSegwit = planTx.inputs.every((i) => i.kind !== "pkh" && i.kind !== "sh-ms");
  if (allSegwit && finalTxid !== planTx.unsignedTxid) {
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
  for (const sub of ["ecx", "xbt", "."]) {
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

/** Depth of the plan transaction on its chain, judged by what spent its first input. */
export async function confirmationDepth(
  backend: ChainBackend,
  planTx: PlannedTx,
  txid: string,
  tip: number,
): Promise<
  { state: "confirmed" | "mempool" | "absent" | "conflict"; depth?: number; by?: string }
> {
  const first = planTx.inputs[0];
  const obs = await backend.observeOutput(first.txid, first.vout);
  if (obs.state === "unspent") return { state: "absent" };
  if (obs.state !== "spent") return { state: "absent" };
  if (obs.spendTxid && obs.spendTxid !== txid) return { state: "conflict", by: obs.spendTxid };
  if (obs.spendHeight === undefined) return { state: "mempool" };
  return { state: "confirmed", depth: tip - obs.spendHeight + 1 };
}
