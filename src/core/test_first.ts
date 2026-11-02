/**
 * The TEST FIRST rule, as a soft gate: on each chain `broadcast` sends the TEST FIRST (smallest)
 * transaction alone first, proving the signer, the destination and the route work before more
 * coins move. On later runs it says where the TEST FIRST transaction is now and asks before
 * sending the rest of that chain (`--yes` answers yes, `--all` skips the TEST FIRST step), so no
 * state can leave the rest stuck. This module only describes the TEST FIRST transaction.
 */
import type { ChainBackend } from "../backends/types.ts";
import { confirmationDepth, type DepthResult, type Progress } from "./execute.ts";
import { followReplacement } from "./plan_admin.ts";
import type { Plan, PlannedTx } from "./planner.ts";
import type { ChainId } from "./profiles.ts";

export interface TestFirstStatus {
  test: PlannedTx;
  /** It (or the fee bump that replaced it, through any number of bumps) is in a block. */
  confirmed: boolean;
  /** "the TEST FIRST transaction (ecx/001-…) is confirmed (3 deep)", for the question. */
  text: string;
}

function where(d: DepthResult): string {
  switch (d.state) {
    case "confirmed":
      return `confirmed (${d.depth} deep)`;
    case "mempool":
      return "in the mempool, not confirmed yet";
    case "absent":
      return "not on the network (dropped from the mempool, or never arrived)";
    case "conflict":
      return `in conflict: its input was spent by ${d.by ?? "another transaction"}`;
    default:
      return "unknown: this backend can't tell where it is";
  }
}

/**
 * Where the chain's TEST FIRST transaction is now, or undefined when the chain has none. Asks the
 * chain; a lookup that fails is described as such, never guessed.
 */
export async function describeTestFirst(o: {
  dataDir: string;
  plan: Plan;
  progress: Progress;
  chain: ChainId;
  backend: ChainBackend;
}): Promise<TestFirstStatus | undefined> {
  const test = o.plan.transactions.find((t) => t.chain === o.chain && t.testFirst);
  if (!test) return undefined;
  const p = o.progress.txs[test.file];
  const name = `the TEST FIRST transaction (${test.file})`;
  const say = (confirmed: boolean, text: string) => ({ test, confirmed, text: `${name} ${text}` });
  if (!p?.verified) return say(false, "isn't verified yet (sign and verify it first)");
  if (!p.broadcast) return say(false, "hasn't been sent yet");
  if (p.supersededBy) {
    return say(false, `was superseded by plan ${p.supersededBy.plan}, which spent its coin first`);
  }
  try {
    const tip = await o.backend.tipHeight();
    const own = await confirmationDepth(o.backend, test, p.verified.txid, tip);
    if (own.state === "confirmed") return say(true, `is ${where(own)}`);
    if (p.replacedBy) {
      const r = await followReplacement(o.dataDir, p.replacedBy, o.chain, o.backend, tip);
      const by = `plan ${r.link.plan}${
        r.plans.length > 1 ? ` (via ${r.plans.slice(0, -1).join(", ")})` : ""
      }`;
      if (!r.depth) return say(false, `was replaced by ${by}, which can't be read`);
      return say(
        r.depth.state === "confirmed",
        `was replaced by ${by}, which is ${where(r.depth)}`,
      );
    }
    const st = p.broadcast.status;
    if (st === "rejected") {
      return say(
        false,
        `was rejected by the server${p.broadcast.detail ? ` (${p.broadcast.detail})` : ""}`,
      );
    }
    return say(false, `is ${where(own)}`);
  } catch (error) {
    return say(false, `couldn't be checked (${(error as Error).message})`);
  }
}
