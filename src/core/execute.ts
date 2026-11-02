/**
 * verify / broadcast / track for a written plan.
 *
 * Everything that matters for safety is re-derived from the plan directory the tool wrote itself
 * (plan.json + the unsigned PSBTs); the signer's output only contributes signatures.
 */
import { join } from "node:path";
import { base64 } from "@scure/base";
import type { ChainBackend } from "../backends/types.ts";
import { fromHex, shortBlockHash, toHex } from "./bytes.ts";
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
    /**
     * "replaced": a fee-bump plan has since been broadcast for this transaction. "superseded":
     * another of this tool's plans spent the same coin first (see `supersededBy`).
     */
    status:
      | "sending"
      | "accepted"
      | "unknown"
      | "rejected"
      | "conflict"
      | "replaced"
      | "superseded";
    at: string;
    backend: string;
    attempts: number;
    detail?: string;
  };
  /**
   * What `track` saw last time, once the transaction has been in a block at least once. Depth 0
   * (with `state`) when it is no longer in one; `previous` then keeps the last block it was in, so
   * a later `track` can still tell the user what changed. The block hash is how a reorg is noticed.
   */
  confirmations?: Confirmations;
  /**
   * What `track` saw of a split that has never been in a block: in a mempool, or on neither the
   * chain nor the mempool (dropped, or never arrived), and when a mempool last had it. Cleared
   * once it is in a block (`confirmations` takes over) and when it is sent again.
   */
  unmined?: Unmined;
  /** Everything `track` has had to warn about, oldest first. */
  reorgs?: ReorgRecord[];
  /** Set on the original when a fee-bump plan replaced it. */
  replacedBy?: ReplacementLink;
  /**
   * Set when another of this tool's plans (not a fee bump of this one) spent this transaction's
   * coin first, e.g. a coin that was planned twice. Not an alarm; `depth` is how deep `track`
   * last saw that transaction (it is settled once that is deep enough).
   */
  supersededBy?: { plan: string; file: string; txid: string; depth?: number; at?: string };
}

/**
 * A fee bump that replaced a transaction: its plan and file, and (since 0.1.0-pre-alpha.2) its
 * txid and first input, so it can still be followed on the chain if its plan can't be read.
 */
export interface ReplacementLink {
  plan: string;
  file: string;
  txid?: string;
  input?: { txid: string; vout: number };
}

/** Records on an original that `link` replaced it. */
export function applyReplaced(entry: TxProgress, link: ReplacementLink): void {
  entry.replacedBy = link;
  delete entry.supersededBy;
  if (entry.broadcast) {
    entry.broadcast = { ...entry.broadcast, status: "replaced", detail: `by plan ${link.plan}` };
  }
}

/** The words a CONFLICT detail uses when the backend couldn't name the spender. */
export const UNNAMED_SPENDER = "this backend can't say which";

/**
 * Drops open CONFLICT records that blamed `txid`, once it turned out to be one of this tool's
 * own transactions (a fee bump, or another plan): they were never true. Records that couldn't
 * name the spender (node RPC) were about the same spend and go too.
 */
export function retractConflicts(entry: TxProgress, txid: string): boolean {
  const before = entry.reorgs?.length ?? 0;
  entry.reorgs = entry.reorgs?.filter((r) =>
    r.resolved || r.kind !== "conflict" ||
    !(r.detail.includes(txid) || r.detail.includes(UNNAMED_SPENDER))
  );
  if (entry.reorgs && !entry.reorgs.length) delete entry.reorgs;
  return (entry.reorgs?.length ?? 0) !== before;
}

/**
 * moved / unconfirmed / dropped: a split that was in a block left it (a reorg). conflict: its
 * inputs were spent by another transaction. evicted: a split that was sent but never in a block
 * is no longer in the mempool either (dropped from it, or the send never arrived).
 */
export type ReorgKind = "moved" | "unconfirmed" | "dropped" | "conflict" | "evicted";

export interface Unmined {
  state: "mempool" | "absent";
  /** When `track` saw that. */
  at: string;
  /** The last time `track` saw it in the mempool, if it ever did. */
  lastInMempool?: string;
}

export interface SeenInBlock {
  depth: number;
  at: string;
  height?: number;
  blockHash?: string;
}

export interface Confirmations extends SeenInBlock {
  /** Set when depth is 0: where it is instead. */
  state?: "mempool" | "absent" | "conflict";
  /** Set when depth is 0: the last block `track` saw it in. */
  previous?: SeenInBlock;
}

export interface ReorgRecord {
  at: string;
  kind: ReorgKind;
  detail: string;
  /** When `track` next saw the split (or the fee bump that replaced it) confirmed deep enough. */
  resolved?: string;
  /**
   * When the user acknowledged it (`track --ack`, or archiving the plan): still on record and
   * shown, muted, but no longer counted as open (it doesn't make `track` exit 1).
   */
  acknowledged?: string;
}

/** An alert that still counts: neither resolved nor acknowledged. */
export const isOpenAlert = (r: ReorgRecord) => !r.resolved && !r.acknowledged;

/** Acknowledges every open alert of a transaction; returns how many. */
export function acknowledgeAlerts(p: TxProgress, at: string): number {
  let n = 0;
  for (const r of p.reorgs ?? []) {
    if (!isOpenAlert(r)) continue;
    r.acknowledged = at; // in place: callers hold these records
    n++;
  }
  return n;
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
  throw new ExecuteError(`No plan "${idOrPath}". See \`splayed plans\`.`);
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
    if (planTx.chain !== "xbt" && planTx.chain !== "btc") {
      throw new SigCheckError("Only XBT and BTC transactions use a donor");
    }
    if (!own.tx.inputs.some((i) => i.txid === d.txid && i.vout === d.vout)) {
      throw new SigCheckError(
        `The donor input ${d.txid}:${d.vout} is missing from the transaction`,
      );
    }
    checks.push(
      `donor input ${d.txid.slice(0, 8)}:${d.vout} (${d.provenance}) is part of the transaction`,
    );
  }
  if (planTx.gate) {
    if (planTx.chain !== "xbt" || planTx.donor) {
      throw new SigCheckError("Only a plain XBT transaction can be gated");
    }
    checks.push(
      "gated: no replay protection of its own; broadcast waits until its coins are spent and deep " +
        `on ${planTx.gate.chains.map((c) => c.toUpperCase()).join(" and ")}`,
    );
  }
  // A CPFP child spends an output that exists on its own chain only, so it needs no 0x21.
  const unifiedMode = planTx.chain === "xbt" && !planTx.donor && !planTx.gate && !planTx.cpfp;
  const ctxs = inputContexts(own, planTx.inputs.map((i) => i.kind));
  const verdicts = verifyInputs(
    own.tx,
    ctxs,
    extractSignatures(ctxs, signed),
    unifiedMode ? "unified" : "standard",
  );
  checks.push(
    planTx.donor
      ? `every signature is plain SIGHASH_ALL and verifies; each commits to the ${planTx.chain.toUpperCase()}-only donor input`
      : planTx.gate || planTx.cpfp
      ? "every signature is plain SIGHASH_ALL and verifies"
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
  for (const sub of ["btc", "ecx", "xbt", "uploads", "."]) {
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
  /** Treat another chain accepting a gated transaction as fatal too (true right before sending). */
  enforceGate = false,
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  for (const { chain, backend } of nodes) {
    if (!backend.testMempoolAccept) continue;
    const r = await backend.testMempoolAccept(hex);
    if (chain === planTx.chain) {
      results[chain] = r.allowed ? "accepted by your node" : `rejected by your node: ${r.reason}`;
      if (!r.allowed && !/missing|spent|conflict|already|insufficient fee/i.test(r.reason ?? "")) {
        throw new SigCheckError(`Your ${chain.toUpperCase()} node rejects it: ${r.reason}`);
      }
    } else {
      if (r.allowed && planTx.gate && !enforceGate) {
        results[chain] =
          "accepts it for now (expected: its coin is not spent there yet); broadcast re-checks " +
          "after BTC and ECX are deep";
        continue;
      }
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
   * confirmed: in the active chain. mempool: seen but unconfirmed. absent: neither, and every one
   * of its inputs was seen unspent (never inferred from a failed or ambiguous lookup: those throw
   * or give unknown). conflict: its inputs were spent by something else. unknown: this backend
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
 * backend with txStatus); falls back to judging by what spent its first input, and when that
 * can't tell either, to its own first output: an output in the chain's UTXO set (node RPC's
 * `gettxout` sees the mempool too) proves the transaction is in a block or the mempool, even on a
 * node without txindex.
 */
export async function confirmationDepth(
  backend: ChainBackend,
  planTx: PlannedTx,
  txid: string,
  tip: number,
): Promise<DepthResult> {
  const d = await depthByStatusAndInputs(backend, planTx, txid, tip);
  if (d.state !== "unknown") return d;
  const own = await backend.observeOutput(txid, 0).catch(() => undefined);
  if (own?.state !== "unspent") return d;
  if (own.createdHeight === undefined) return { state: "mempool" };
  return {
    state: "confirmed",
    depth: tip - own.createdHeight + 1,
    height: own.createdHeight,
    blockHash: await backend.blockHash(own.createdHeight),
  };
}

async function depthByStatusAndInputs(
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
  if (obs.state === "unspent") {
    // It can't be in a block or a mempool while its first input is unspent. "absent" also
    // promises the other inputs are unspent: one spent elsewhere is a conflict, and one the
    // backend can't place leaves the answer open.
    for (const input of planTx.inputs.slice(1)) {
      const o = await backend.observeOutput(input.txid, input.vout);
      if (o.state === "unspent") continue;
      if (o.state === "spent") return { state: "conflict", by: o.spendTxid };
      return { state: "unknown" };
    }
    return { state: "absent" };
  }
  if (obs.state === "spent" && status?.state === "absent" && obs.spendTxid !== txid) {
    // Not on the chain and not in the mempool, yet the input is gone: someone else spent it.
    // (Spent by this very transaction: it reached the mempool or a block between the two
    // lookups, or the server answering is behind; the spend itself says where it is, below.)
    return { state: "conflict", by: obs.spendTxid };
  }
  // The input's own transaction can't be found, or the backend can't tell spent from missing:
  // nothing can be said about this transaction.
  if (obs.state !== "spent") return { state: "unknown" };
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

/** "block 974512 (…9c3e1a0b)": the height, and the part of the hash that differs. */
const blockRef = (height?: number, hash?: string) =>
  `${height ?? "?"}${hash ? ` (${shortBlockHash(hash)})` : ""}`;

/** The headline `track` and the web UI put in front of an alert's detail. */
export const alertTitle = (kind: ReorgKind) =>
  kind === "conflict" ? "CONFLICT" : kind === "evicted" ? "DROPPED" : "REORG";

/**
 * How long after a send a split that no mempool shows is given before `track` calls it dropped:
 * the server `track` asks may not have it yet. Once `track` has seen it in a mempool, a later
 * absence counts at once.
 */
export const DROP_GRACE_MS = 10 * 60_000;

/** "2026-11-02 14:03 UTC" */
const utcText = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * For a split that was never in a block: what `track` knows about its sends. Only passed for one
 * that was sent (accepted) or may have been (sending / unknown), and not replaced by a fee bump.
 */
export interface SentContext {
  status: "accepted" | "sending" | "unknown";
  /** When it was (last) sent. */
  sentAt?: string;
  lastInMempool?: string;
  /** Now, in ms (Date.now()). */
  nowMs: number;
}

/** True while a split that no mempool shows was sent too recently to call it dropped. */
export function withinDropGrace(sent: SentContext): boolean {
  if (sent.lastInMempool || !sent.sentAt) return false;
  const t = Date.parse(sent.sentAt);
  return Number.isFinite(t) && sent.nowMs - t < DROP_GRACE_MS;
}

function droppedFromMempool(sent: SentContext): ReorgAlert {
  const head = sent.lastInMempool
    ? `This split was in the mempool (last seen ${utcText(sent.lastInMempool)}) but never ` +
      "confirmed, and it is no longer in the mempool or on the chain."
    : sent.status === "accepted"
    ? `This split was accepted by the server${
      sent.sentAt ? ` (sent ${utcText(sent.sentAt)})` : ""
    } but never confirmed, and it is no longer in the mempool or on the chain.`
    : `The last send of this split${
      sent.sentAt ? ` (${utcText(sent.sentAt)})` : ""
    } ended without a clear answer, and it is not in the mempool or on the chain: it never ` +
      "arrived, or it was dropped.";
  return {
    kind: "evicted",
    detail: `${head} Nodes drop a transaction whose fee rate falls below their mempool minimum ` +
      "(a busy mempool) or that waited too long (mempool expiry, two weeks by default). Its " +
      "inputs are unspent, so the coin is still shared with BTC: do NOT spend the BTC copy. " +
      "Send it again with `splayed broadcast` (Broadcast verified), or, if the fee was too low, " +
      "replace it with `splayed bump` (Fee bump…).",
  };
}

/** The last block a transaction was seen in, if `track` has ever seen it in one. */
export function lastSeenInBlock(prev?: Confirmations): SeenInBlock | undefined {
  return prev && prev.depth > 0 ? prev : prev?.previous;
}

/**
 * Compares what `track` saw last time with what it sees now. Only a transaction that was once
 * seen confirmed can be "reorged"; a conflict is always worth shouting about. While a reorged
 * split is out of a block the alert repeats on every `track`, so it can't be missed.
 */
export function assessReorg(
  chain: ChainId,
  prev: Confirmations | undefined,
  now: DepthResult,
  /** For a split never seen in a block: set when it was sent, so its absence is worth a word. */
  sent?: SentContext,
): ReorgAlert | undefined {
  const label = chain.toUpperCase();
  const seen = lastSeenInBlock(prev);
  switch (now.state) {
    case "conflict":
      return {
        kind: "conflict",
        detail:
          (now.by
            ? `This split's input was spent by transaction ${now.by}, which is not one of this ` +
              "tool's plans or fee bumps."
            : `This split's input was spent by another transaction; ${UNNAMED_SPENDER} ` +
              "(node RPC without txindex can't name a spender: an Esplora or Electrum backend " +
              "can).") +
          ` Likely causes, most likely first: the coin was spent with another wallet or tool (a ` +
          `${label} wallet, say); an ordinary BTC spend of it was replayed onto ${label}; only if ` +
          "neither applies, the key may be compromised. This split can't confirm now.",
      };
    case "confirmed":
      // Straight from one block to another. One that left the chain and came back was reported
      // when it left; being confirmed again is the recovery.
      if (
        prev && prev.depth > 0 && prev.blockHash && now.blockHash &&
        prev.blockHash !== now.blockHash
      ) {
        return {
          kind: "moved",
          detail: `This split was in block ${blockRef(prev.height, prev.blockHash)} and is now ` +
            `in block ${blockRef(now.height, now.blockHash)}. It is still confirmed, but in a ` +
            "different block: wait for it to be deep again.",
        };
      }
      return undefined;
    case "mempool":
      return seen
        ? {
          kind: "unconfirmed",
          detail:
            `This split was confirmed ${seen.depth} deep in block ${
              blockRef(seen.height, seen.blockHash)
            } and is back in the mempool. It should confirm again; do not spend the BTC copy ` +
            "until it does.",
        }
        : undefined;
    case "absent":
      return seen
        ? {
          kind: "dropped",
          detail:
            `This split was confirmed ${seen.depth} deep in block ${
              blockRef(seen.height, seen.blockHash)
            } and has left the chain; it is not in the mempool and its input is unspent again, ` +
            `so the coin is back on ${label} and still shared with BTC. Do NOT spend the BTC ` +
            "copy. Run `splayed broadcast` to send it again, or `splayed bump` to replace it.",
        }
        : sent && !withinDropGrace(sent)
        ? droppedFromMempool(sent)
        : undefined;
    case "unknown":
      return undefined;
  }
}

/**
 * What `track` records after looking: the depth now, truthfully. A transaction that left its
 * block gets depth 0 and keeps the block it was last seen in. "unknown" (a backend that can't
 * tell) keeps the last record. Nothing is recorded for one that was never in a block.
 */
export function nextConfirmations(
  prev: Confirmations | undefined,
  now: DepthResult,
  at: string,
): Confirmations | undefined {
  switch (now.state) {
    case "confirmed":
      return { depth: now.depth!, at, height: now.height, blockHash: now.blockHash };
    case "unknown":
      return prev;
    default: {
      if (!prev) return undefined;
      const seen = lastSeenInBlock(prev);
      return {
        depth: 0,
        at,
        state: now.state,
        previous: seen &&
          { depth: seen.depth, at: seen.at, height: seen.height, blockHash: seen.blockHash },
      };
    }
  }
}

/**
 * What `track` records about a split that was never in a block. A failed or ambiguous lookup
 * ("unknown") and a conflict keep the last record; once it is in a block there is none.
 */
export function nextUnmined(
  prev: Unmined | undefined,
  now: DepthResult,
  at: string,
): Unmined | undefined {
  switch (now.state) {
    case "confirmed":
      return undefined;
    case "mempool":
      return { state: "mempool", at, lastInMempool: at };
    case "absent":
      return { state: "absent", at, lastInMempool: prev?.lastInMempool };
    default:
      return prev;
  }
}

/** Marks every open reorg record resolved: the split is confirmed deep enough again. */
export function resolveReorgs(p: TxProgress, at: string): void {
  if (!p.reorgs?.some((r) => !r.resolved)) return;
  p.reorgs = p.reorgs.map((r) => (r.resolved ? r : { ...r, resolved: at }));
}

/**
 * Adds an alert to the history unless it repeats the one still unresolved at the end (an open
 * DROPPED alert is repeated by its kind alone: how the split came to be off the network can be
 * worded differently on a later look). Once acknowledged, only the same words repeat it: a new
 * drop (seen in the mempool again since) is a new, loud record. Returns the record.
 */
export function recordReorg(p: TxProgress, alert: ReorgAlert, at: string): ReorgRecord {
  const last = p.reorgs?.[p.reorgs.length - 1];
  if (
    last && !last.resolved && last.kind === alert.kind &&
    (last.detail === alert.detail || (alert.kind === "evicted" && !last.acknowledged))
  ) return last;
  const rec: ReorgRecord = { at, kind: alert.kind, detail: alert.detail };
  p.reorgs = [...(p.reorgs ?? []), rec];
  return rec;
}

export interface GateCheck {
  /** Inputs of the gated transaction, and what each gate chain's backend says about them. */
  planTx: PlannedTx;
  planDir: string;
  plan: Plan;
  progress: Progress;
  /** Backends for the gate chains, with the confirmations each needs. */
  chains: Partial<Record<"btc" | "ecx", { backend: ChainBackend; confirmations: number }>>;
}

/**
 * BTC-first route: an XBT transaction with no replay protection may be sent only once every one of
 * its inputs is spent, and deep, on BTC and on ECX. Returns the reasons it may not be sent yet.
 * Depth comes from this plan's own BTC/ECX transaction when there is one (node RPC can say whether a
 * known transaction is confirmed), otherwise from the backend's spend details (Esplora, Electrum).
 */
export async function gateProblems(g: GateCheck): Promise<string[]> {
  const problems: string[] = [];
  for (const chain of g.planTx.gate?.chains ?? []) {
    const ours = g.chains[chain];
    if (!ours) {
      problems.push(`${chain.toUpperCase()}: no backend to check that the coin was spent there`);
      continue;
    }
    const tip = await ours.backend.tipHeight();
    for (const input of g.planTx.inputs) {
      const label = `${chain.toUpperCase()} ${input.txid.slice(0, 8)}:${input.vout}`;
      const obs = await ours.backend.observeOutput(input.txid, input.vout);
      if (obs.state !== "spent") {
        problems.push(`${label}: not spent on ${chain.toUpperCase()} yet (${obs.state})`);
        continue;
      }
      // Prefer this plan's own transaction on that chain.
      const sibling = g.plan.transactions.find((t) =>
        t.chain === chain && t.inputs.some((i) => i.txid === input.txid && i.vout === input.vout)
      );
      const siblingTxid = sibling && g.progress.txs[sibling.file]?.verified?.txid;
      let depth: number | undefined;
      if (sibling && siblingTxid) {
        const d = await confirmationDepth(ours.backend, sibling, siblingTxid, tip);
        if (d.state === "confirmed") depth = d.depth;
        else if (d.state === "conflict") {
          problems.push(`${label}: spent by another transaction (${d.by ?? "unknown"})`);
          continue;
        }
      } else if (obs.spendDetailKnown && obs.spendHeight !== undefined) {
        depth = tip - obs.spendHeight + 1;
      }
      if (depth === undefined) {
        problems.push(
          `${label}: spent, but ${chain.toUpperCase()} can't show it is confirmed (not yet, or this ` +
            "backend can't tell)",
        );
      } else if (depth < ours.confirmations) {
        problems.push(`${label}: only ${depth} of ${ours.confirmations} confirmations`);
      }
    }
  }
  return problems;
}
