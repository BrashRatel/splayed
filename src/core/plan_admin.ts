/**
 * Archiving and deleting plans.
 *
 * Archiving only drops a marker file into the plan's folder: the folder stays where it is,
 * because other code reads it — the donor rules count transactions this tool verified and sent
 * (`protectedTxids` in donors.ts), and a fee bump's `track` reads the plan it replaced.
 *
 * Deleting removes the folder for good. It is refused while any transaction of the plan has been
 * sent and isn't yet confirmed to the chain's required depth, since the plan is the only record
 * of what was sent and how to follow it up.
 */
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { ChainBackend } from "../backends/types.ts";
import {
  acknowledgeAlerts,
  confirmationDepth,
  type DepthResult,
  loadProgress,
  type Progress,
  type ReplacementLink,
  saveProgress,
  type TxProgress,
} from "./execute.ts";
import { type Plan, type PlannedTx, PLANS_DIR } from "./planner.ts";
import type { ChainId } from "./profiles.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export const ARCHIVE_MARKER = "archived.json";

export class PlanAdminError extends Error {}

/** Plan ids as written by the planner and by fee bumps: no paths, no dots. */
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/u;

/** Resolves a plan id to its folder under the data directory. Never accepts a path. */
export async function planFolder(
  dataDir: string,
  id: string,
): Promise<{ dir: string; plan: Plan }> {
  if (!PLAN_ID.test(id)) {
    throw new PlanAdminError(`"${id}" isn't a plan id. See \`splayed plans\`.`);
  }
  const dir = join(dataDir, PLANS_DIR, id);
  const plan = await readJson<Plan>(join(dir, "plan.json")).catch(() => undefined);
  if (!plan) throw new PlanAdminError(`No plan "${id}". See \`splayed plans\`.`);
  return { dir, plan };
}

export async function archivedAt(dir: string): Promise<string | undefined> {
  const marker = await readJson<{ at?: string }>(join(dir, ARCHIVE_MARKER)).catch(() => undefined);
  return marker ? (marker.at ?? "unknown") : undefined;
}

/**
 * Archives a plan. Its open alerts are acknowledged (recorded in progress.json, shown muted, no
 * longer making `track` exit 1): archiving says you are done with it. Returns how many.
 */
export async function archivePlan(dataDir: string, id: string, now = new Date()): Promise<number> {
  const { dir } = await planFolder(dataDir, id);
  if (await archivedAt(dir)) throw new PlanAdminError(`Plan ${id} is already archived.`);
  const progress = await loadProgress(dir);
  let acknowledged = 0;
  for (const p of Object.values(progress.txs)) {
    acknowledged += acknowledgeAlerts(p, now.toISOString());
  }
  if (acknowledged) await saveProgress(dir, progress);
  await writeJsonAtomic(join(dir, ARCHIVE_MARKER), { at: now.toISOString() });
  return acknowledged;
}

export async function unarchivePlan(dataDir: string, id: string): Promise<void> {
  const { dir } = await planFolder(dataDir, id);
  if (!(await archivedAt(dir))) throw new PlanAdminError(`Plan ${id} isn't archived.`);
  await Deno.remove(join(dir, ARCHIVE_MARKER));
}

/**
 * Transactions that were sent (or may have been) and aren't confirmed deep enough yet. A
 * transaction that was replaced by a fee bump never confirms itself, so a plan with one stays
 * here: archive it instead.
 */
export async function unsettledTransactions(
  config: Config,
  dir: string,
  plan: Plan,
): Promise<string[]> {
  const progress = await loadProgress(dir);
  const out: string[] = [];
  for (const t of plan.transactions) {
    const p = progress.txs[t.file];
    if (!p?.broadcast) continue;
    const required = config.chains[t.chain as ChainId].confirmations;
    if (!isUnsettled(p, required)) continue;
    const depth = p.confirmations?.depth ?? 0;
    out.push(
      `${t.chain.toUpperCase()} ${t.file}: ${p.broadcast.status}` +
        (p.replacedBy ? ` (replaced by plan ${p.replacedBy.plan})` : "") +
        `, ${depth} of ${required} confirmations`,
    );
  }
  return out;
}

/**
 * Whether a sent transaction still needs following. Settled: confirmed `required` deep with
 * nothing since (a record from an older version with a stale depth doesn't count while its
 * status says the send is unclear or in conflict, or `track` saw it leave its block); refused by
 * every backend and never seen; or superseded by another plan whose transaction is deep.
 */
export function isUnsettled(p: TxProgress, required: number): boolean {
  const b = p.broadcast;
  if (!b) return false;
  if (b.status === "rejected" && !p.confirmations) return false;
  if (b.status === "superseded") return (p.supersededBy?.depth ?? 0) < required;
  if (b.status === "unknown" || b.status === "sending" || b.status === "conflict") return true;
  if (p.confirmations?.state) return true;
  return (p.confirmations?.depth ?? 0) < required;
}

/** One plan (not archived) that spends a coin. */
export interface PlannedSpend {
  plan: string;
  /** A transaction of this plan spending the coin was sent (or may have been). */
  sent: boolean;
  /** Each of this plan's transactions that spends the coin, and how far it has got. */
  txs: CoinTxState[];
}

/**
 * How far one planned transaction has got, from the plan's own records (no chain lookups):
 * unsigned → signed (a signed file was uploaded) → verified → sent → confirmed, or one of the
 * ways a send ends otherwise (the broadcast statuses).
 */
export type CoinTxStage =
  | "unsigned"
  | "signed"
  | "verified"
  | "sending"
  | "sent"
  | "confirmed"
  | "unknown"
  | "rejected"
  | "conflict"
  | "replaced"
  | "superseded";

export interface CoinTxState {
  chain: PlannedTx["chain"];
  order: number;
  file: string;
  stage: CoinTxStage;
  /** For "confirmed": how deep `track` last saw it. */
  depth?: number;
  /** A short note: what replaced or superseded it, or that a sent one is no longer on the network. */
  detail?: string;
}

/** The stage of one transaction from its progress record; `uploaded`: a signed file came in. */
export function txStage(p: TxProgress | undefined, uploaded: boolean): Omit<
  CoinTxState,
  "chain" | "order" | "file"
> {
  const b = p?.broadcast;
  if (b) {
    if (b.status === "replaced" || p!.replacedBy) {
      return {
        stage: "replaced",
        detail: p!.replacedBy ? `by fee bump ${p!.replacedBy.plan}` : b.detail,
      };
    }
    if (b.status === "superseded" || p!.supersededBy) {
      return {
        stage: "superseded",
        detail: p!.supersededBy ? `by plan ${p!.supersededBy.plan}` : b.detail,
      };
    }
    const c = p!.confirmations;
    if (c && c.depth > 0) return { stage: "confirmed", depth: c.depth };
    if (c?.state === "conflict") return { stage: "conflict" };
    if (b.status === "accepted") {
      const gone = c?.state === "absent" || p!.unmined?.state === "absent";
      return gone ? { stage: "sent", detail: "not on the network now" } : { stage: "sent" };
    }
    return { stage: b.status };
  }
  if (p?.verified) return { stage: "verified" };
  return { stage: uploaded ? "signed" : "unsigned" };
}

/** Whether the web UI received a signed file for this transaction (uploads/<stem>.signed.*). */
async function hasUpload(dir: string, file: string): Promise<boolean> {
  const stem = file.replace("/", "-").replace(/\.psbt$/u, "");
  for (const kind of ["psbt", "hex"]) {
    try {
      await Deno.stat(join(dir, "uploads", `${stem}.signed.${kind}`));
      return true;
    } catch { /* not uploaded */ }
  }
  return false;
}

/**
 * Which plans already spend each outpoint ("txid:vout"), newest plan first. Archived plans and
 * unreadable plan folders don't count. "Sent" follows unsettledTransactions: a broadcast refused
 * by every backend (rejected, or conflicting with another spend) and never seen confirmed is not
 * out there.
 */
export async function plannedOutpoints(dataDir: string): Promise<Map<string, PlannedSpend[]>> {
  const out = new Map<string, PlannedSpend[]>();
  const root = join(dataDir, PLANS_DIR);
  const ids: string[] = [];
  try {
    for await (const e of Deno.readDir(root)) if (e.isDirectory) ids.push(e.name);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  ids.sort().reverse();
  for (const id of ids) {
    const dir = join(root, id);
    const plan = await readJson<Plan>(join(dir, "plan.json")).catch(() => undefined);
    if (!plan?.transactions || await archivedAt(dir)) continue;
    const progress: Progress = await loadProgress(dir).catch(() => ({ version: 1, txs: {} }));
    const spends = new Map<string, { sent: boolean; txs: CoinTxState[] }>();
    for (const t of plan.transactions) {
      const p = progress.txs[t.file];
      // A transaction superseded by another plan's spend of the coin isn't out there either; the
      // other plan is listed for the coin itself.
      const sent = !!p?.broadcast &&
        (!["rejected", "conflict", "superseded"].includes(p.broadcast.status) ||
          !!p.confirmations);
      const state: CoinTxState = {
        chain: t.chain,
        order: t.order,
        file: t.file,
        ...txStage(p, !p?.verified && !p?.broadcast && await hasUpload(dir, t.file)),
      };
      for (const i of t.inputs ?? []) {
        const key = `${i.txid}:${i.vout}`;
        const entry = spends.get(key) ?? { sent: false, txs: [] };
        entry.sent ||= sent;
        entry.txs.push(state);
        spends.set(key, entry);
      }
    }
    for (const [key, { sent, txs }] of spends) {
      out.set(key, [...(out.get(key) ?? []), { plan: plan.id ?? id, sent, txs }]);
    }
  }
  return out;
}

/** What deleting would lose, for the confirmation question. */
export async function deletionNotes(dir: string, plan: Plan): Promise<string[]> {
  const progress = await loadProgress(dir);
  const sent = plan.transactions.filter((t) => progress.txs[t.file]?.broadcast).length;
  const notes: string[] = [];
  if (sent) {
    notes.push(
      `${sent} transaction(s) of this plan were sent. The plan is the record that their outputs ` +
        "are chain-specific; coins you later use as donors may stop qualifying without it.",
    );
  }
  if (plan.transactions.some((t) => t.replaces)) {
    notes.push("This plan is a fee bump; the plan it replaced keeps a link to it.");
  }
  const signed = plan.transactions.filter((t) => progress.txs[t.file]?.verified).length;
  if (signed && !sent) {
    notes.push(
      `${signed} verified (signed) transaction(s) will be lost; you'd have to sign again.`,
    );
  }
  return notes;
}

export async function deletePlan(config: Config, id: string): Promise<void> {
  const { dir, plan } = await planFolder(config.dataDir, id);
  const unsettled = await unsettledTransactions(config, dir, plan);
  if (unsettled.length) {
    throw new PlanAdminError(
      `Plan ${id} has transactions that were sent and aren't confirmed yet:\n  ` +
        unsettled.join("\n  ") +
        "\nIt can't be deleted until they are. You can archive it instead.",
    );
  }
  const referrers = await replacedByReferences(config.dataDir, id);
  if (referrers.length) {
    throw new PlanAdminError(
      `Plan ${id} is a fee bump that ${referrers.join(", ")} points to as its replacement; ` +
        "`track` and `broadcast` follow it there. Archive that plan first if you're done with " +
        "it, or archive this one instead.",
    );
  }
  await Deno.remove(dir, { recursive: true });
}

async function planIds(dataDir: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    for await (const e of Deno.readDir(join(dataDir, PLANS_DIR))) {
      if (e.isDirectory) ids.push(e.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return ids.sort();
}

/**
 * Transactions of plans that aren't archived whose `replacedBy` names plan `id`, as
 * "plan P (file)".
 */
export async function replacedByReferences(dataDir: string, id: string): Promise<string[]> {
  const out: string[] = [];
  for (const other of await planIds(dataDir)) {
    if (other === id) continue;
    const dir = join(dataDir, PLANS_DIR, other);
    if (await archivedAt(dir)) continue;
    const progress = await loadProgress(dir).catch(() => undefined);
    for (const [file, p] of Object.entries(progress?.txs ?? {})) {
      if (p.replacedBy?.plan === id) out.push(`plan ${other} (${file})`);
    }
  }
  return out;
}

/** A transaction of one of this tool's plans that was verified, archived plans included. */
export interface OwnTx {
  plan: string;
  file: string;
  chain: string;
  txid: string;
  /** Set on a fee bump: what it replaces (with the original's txid). */
  replaces?: { plan: string; file: string; txid: string };
  input?: { txid: string; vout: number };
  /** Every coin it spends. */
  inputs?: { txid: string; vout: number }[];
}

/** Every verified transaction of every plan (archived ones included), by txid. */
export async function ownTransactions(dataDir: string): Promise<Map<string, OwnTx>> {
  const out = new Map<string, OwnTx>();
  for (const id of await planIds(dataDir)) {
    const dir = join(dataDir, PLANS_DIR, id);
    const plan = await readJson<Plan>(join(dir, "plan.json")).catch(() => undefined);
    if (!plan?.transactions) continue;
    const progress = await loadProgress(dir).catch(() => undefined);
    for (const t of plan.transactions) {
      const txid = progress?.txs[t.file]?.verified?.txid;
      if (!txid) continue;
      out.set(txid, {
        plan: plan.id ?? id,
        file: t.file,
        chain: t.chain,
        txid,
        replaces: t.replaces,
        input: t.inputs?.[0] && { txid: t.inputs[0].txid, vout: t.inputs[0].vout },
        inputs: t.inputs?.map((i) => ({ txid: i.txid, vout: i.vout })),
      });
    }
  }
  return out;
}

/** Who spent a split's input instead of it, as far as this tool's own plans can tell. */
export type Spender =
  /** A fee bump of the split (perhaps a bump of a bump): `link` is the split's direct one. */
  | { kind: "replacement"; link: ReplacementLink; spender: OwnTx }
  /** Another plan's transaction spent the coin first. */
  | { kind: "own"; spender: OwnTx }
  /** The split itself: its own input spent by its own transaction is no conflict. */
  | { kind: "self"; spender: OwnTx }
  | { kind: "unknown" };

/** The longest chain of fee bumps followed (a bump of a bump of …). */
export const MAX_BUMP_HOPS = 16;

/**
 * Looks the spender `by` of a split's input up among every plan's verified transactions. A spend
 * whose `replaces` chain leads back to the split is its own fee bump; any other is another plan's.
 */
export async function classifySpender(
  dataDir: string,
  split: { plan: string; file: string; chain: string },
  by: string | undefined,
  index?: Map<string, OwnTx>,
): Promise<Spender> {
  if (!by) return { kind: "unknown" };
  const all = index ?? await ownTransactions(dataDir);
  const own = all.get(by);
  if (!own || own.chain !== split.chain) return { kind: "unknown" };
  let cur: OwnTx | undefined = own;
  for (let hop = 0; cur?.replaces && hop < MAX_BUMP_HOPS; hop++) {
    if (cur.replaces.plan === split.plan && cur.replaces.file === split.file) {
      return {
        kind: "replacement",
        link: { plan: cur.plan, file: cur.file, txid: cur.txid, input: cur.input },
        spender: own,
      };
    }
    cur = all.get(cur.replaces.txid);
  }
  if (own.plan === split.plan && own.file === split.file) return { kind: "self", spender: own };
  return { kind: "own", spender: own };
}

/**
 * Who spent a split's input, when the backend may not be able to say. With a spender named
 * (Esplora, Electrum), as classifySpender. Without one (node RPC never names a spender), each of
 * this tool's own transactions that spends one of the same coins is looked up on the chain by its
 * txid: one that is confirmed or in the mempool is the spender. Lookups that fail are skipped; if
 * none is found the spender stays unknown.
 */
export async function identifySpender(
  dataDir: string,
  split: { plan: string; file: string; chain: string; inputs: { txid: string; vout: number }[] },
  by: string | undefined,
  backend: ChainBackend,
  tip: number,
  index?: Map<string, OwnTx>,
): Promise<Spender> {
  const all = index ?? await ownTransactions(dataDir);
  if (by) return await classifySpender(dataDir, split, by, all);
  // The backend can't name the spender. Only credit one of our own transactions if it spends
  // EVERY input of this split that is gone: a stranger who spent one input (a replayed BTC spend,
  // a compromised key) must not be explained away by an own plan that shares another input.
  const key = (i: { txid: string; vout: number }) => `${i.txid}:${i.vout}`;
  const gone: string[] = [];
  for (const i of split.inputs) {
    let state: string;
    try {
      state = (await backend.observeOutput(i.txid, i.vout)).state;
    } catch {
      state = "unknown"; // can't tell: treat as gone, so it must be explained too
    }
    if (state !== "unspent") gone.push(key(i));
  }
  if (!gone.length) return { kind: "unknown" };
  for (const own of all.values()) {
    if (own.chain !== split.chain) continue;
    if (own.plan === split.plan && own.file === split.file) continue;
    const inputs = own.inputs ?? (own.input ? [own.input] : []);
    const spends = new Set(inputs.map(key));
    if (!gone.every((k) => spends.has(k))) continue;
    try {
      const d = await confirmationDepth(
        backend,
        { inputs } as unknown as PlannedTx,
        own.txid,
        tip,
      );
      if (d.state === "confirmed" || d.state === "mempool") {
        return await classifySpender(dataDir, split, own.txid, all);
      }
    } catch { /* this candidate can't be checked now; try the others */ }
  }
  return { kind: "unknown" };
}

export interface FollowedReplacement {
  /** The last replacement reached: the one whose state is reported. */
  link: ReplacementLink;
  /** The bump plans followed, in order. */
  plans: string[];
  /** Where that replacement is; undefined when it can't be read or the chain is too long. */
  depth?: DepthResult;
  /** Its progress record, when its plan can be read. */
  progress?: TxProgress;
}

/**
 * Follows a replaced transaction to the replacement that is on the network: through each bump's
 * own `replacedBy`, or, when a bump's send result was lost, through whichever of this tool's
 * bumps spent its input. Asks the chain by txid, so a replacement whose plan is gone can still
 * be followed when its link carries the txid.
 */
export async function followReplacement(
  dataDir: string,
  start: ReplacementLink,
  chain: string,
  backend: ChainBackend,
  tip: number,
): Promise<FollowedReplacement> {
  let link = start;
  const plans: string[] = [];
  let index: Map<string, OwnTx> | undefined;
  for (let hop = 0; hop < MAX_BUMP_HOPS; hop++) {
    plans.push(link.plan);
    const loaded = await planFolder(dataDir, link.plan).catch(() => undefined);
    const rt = loaded?.plan.transactions.find((x) => x.file === link.file);
    const progress = loaded
      ? (await loadProgress(loaded.dir).catch(() => undefined))?.txs[link.file]
      : undefined;
    const txid = link.txid ?? progress?.verified?.txid;
    const probe = rt ??
      (link.input ? ({ inputs: [link.input] } as unknown as PlannedTx) : undefined);
    if (!txid || !probe) return { link, plans, progress };
    const depth = await confirmationDepth(backend, probe, txid, tip);
    if (depth.state === "confirmed" || depth.state === "mempool") {
      return { link, plans, depth, progress };
    }
    let next = progress?.replacedBy;
    if (!next && depth.state === "conflict" && depth.by) {
      index ??= await ownTransactions(dataDir);
      const s = await classifySpender(dataDir, { ...link, chain }, depth.by, index);
      if (s.kind === "replacement") next = s.link;
    }
    if (!next) return { link, plans, depth, progress };
    link = next;
  }
  return { link, plans };
}

/** A fee bump written for a transaction and not sent (or not known to be sent) yet. */
export interface UnsentReplacement {
  /** The bump plan's id and the replacement's file in it. */
  plan: string;
  file: string;
  /** Its broadcast status, if a send was attempted ("sending" or "unknown"). */
  status?: string;
}

/**
 * Fee bumps of `planId`'s transactions that are written but not sent yet, keyed by the original's
 * file. Rejected or conflicting replacements don't count (they never made it out); a sent one marks
 * the original `replacedBy` instead. Archived bump plans are set aside and don't count either.
 */
export async function unsentReplacements(
  dataDir: string,
  planId: string,
): Promise<Map<string, UnsentReplacement[]>> {
  return (await unsentReplacementsByPlan(dataDir)).get(planId) ?? new Map();
}

/** unsentReplacements() for every plan at once: original plan id -> original file -> bumps. */
export async function unsentReplacementsByPlan(
  dataDir: string,
): Promise<Map<string, Map<string, UnsentReplacement[]>>> {
  const out = new Map<string, Map<string, UnsentReplacement[]>>();
  const root = join(dataDir, PLANS_DIR);
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(root)) if (e.isDirectory) names.push(e.name);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  for (const name of names.sort()) {
    const dir = join(root, name);
    const plan = await readJson<Plan>(join(dir, "plan.json")).catch(() => undefined);
    if (!plan?.transactions?.some((t) => t.replaces)) continue;
    if (await archivedAt(dir)) continue;
    const progress = await loadProgress(dir).catch(() => undefined);
    for (const t of plan.transactions) {
      if (!t.replaces) continue;
      const status = progress?.txs[t.file]?.broadcast?.status;
      if (status && status !== "sending" && status !== "unknown") continue;
      const files = out.get(t.replaces.plan) ?? new Map<string, UnsentReplacement[]>();
      files.set(t.replaces.file, [
        ...(files.get(t.replaces.file) ?? []),
        { plan: name, file: t.file, status },
      ]);
      out.set(t.replaces.plan, files);
    }
  }
  return out;
}
