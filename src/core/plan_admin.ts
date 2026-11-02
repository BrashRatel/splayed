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
import { loadProgress, type Progress } from "./execute.ts";
import { type Plan, PLANS_DIR } from "./planner.ts";
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

export async function archivePlan(dataDir: string, id: string, now = new Date()): Promise<void> {
  const { dir } = await planFolder(dataDir, id);
  if (await archivedAt(dir)) throw new PlanAdminError(`Plan ${id} is already archived.`);
  await writeJsonAtomic(join(dir, ARCHIVE_MARKER), { at: now.toISOString() });
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
    // Refused by every backend and never seen since: nothing is out there to follow up.
    if (p.broadcast.status === "rejected" && !p.confirmations) continue;
    const required = config.chains[t.chain as ChainId].confirmations;
    const depth = p.confirmations?.depth ?? 0;
    if (depth >= required) continue;
    out.push(
      `${t.chain.toUpperCase()} ${t.file}: ${p.broadcast.status}` +
        (p.replacedBy ? ` (replaced by plan ${p.replacedBy.plan})` : "") +
        `, ${depth} of ${required} confirmations`,
    );
  }
  return out;
}

/** One plan (not archived) that spends a coin. */
export interface PlannedSpend {
  plan: string;
  /** A transaction of this plan spending the coin was sent (or may have been). */
  sent: boolean;
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
    const spends = new Map<string, boolean>();
    for (const t of plan.transactions) {
      const p = progress.txs[t.file];
      const sent = !!p?.broadcast &&
        (!["rejected", "conflict"].includes(p.broadcast.status) || !!p.confirmations);
      for (const i of t.inputs ?? []) {
        const key = `${i.txid}:${i.vout}`;
        spends.set(key, (spends.get(key) ?? false) || sent);
      }
    }
    for (const [key, sent] of spends) {
      out.set(key, [...(out.get(key) ?? []), { plan: plan.id ?? id, sent }]);
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
  await Deno.remove(dir, { recursive: true });
}
