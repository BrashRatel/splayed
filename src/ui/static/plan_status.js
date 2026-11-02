// What the Plans tab says about a sent transaction: depth, reorg alerts, whether a fee bump is
// offered. Plain functions over the /api/plans data, no DOM, so tests can import them.

/** "2026-11-02 14:03:09 UTC" from an ISO time (the page shows times in UTC). */
export function utc(iso) {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : "";
}

/**
 * A split can be replaced while it is sent, in no block, not replaced, not in conflict, and has no
 * fee bump written and waiting to be sent. The CLI makes the final call.
 */
export function bumpable(pr) {
  if (!pr.broadcast || pr.broadcast.status === "replaced" || pr.replacedBy) return false;
  if (pr.broadcast.status === "superseded" || pr.supersededBy) return false;
  if (pr.broadcast.status === "conflict" || pr.confirmations?.state === "conflict") return false;
  if (pr.pendingBump) return false;
  // Out of its block (track said so), or a send whose result is unclear: not settled in a block,
  // whatever depth an older record still carries.
  if (pr.confirmations?.state) return true;
  if (pr.broadcast.status === "unknown" || pr.broadcast.status === "sending") return true;
  return !(pr.confirmations && pr.confirmations.depth > 0);
}

/**
 * The depth line under a transaction's status. Before it was ever in a block: only when track
 * found it on neither the chain nor the mempool, otherwise null.
 */
export function depthText(pr) {
  const c = pr.confirmations;
  if (!c) {
    if (pr.unmined?.state !== "absent") return null;
    return pr.unmined.lastInMempool
      ? `dropped from the mempool (last seen ${utc(pr.unmined.lastInMempool)})`
      : "not on the network";
  }
  if (c.depth > 0) return `${c.depth} conf`;
  const was = c.previous ? ` (was ${c.previous.depth} conf)` : "";
  if (c.state === "mempool") return `back in the mempool${was}`;
  if (c.state === "absent") return `not on the chain${was}`;
  if (c.state === "conflict") return `conflict${was}`;
  return `0 conf${was}`;
}

/** The headline of an alert, as `track` prints it (alertTitle in src/core/execute.ts). */
export function alertTitle(kind) {
  return kind === "conflict" ? "CONFLICT" : kind === "evicted" ? "DROPPED" : "REORG";
}

/** Old progress files put "ECX: REORG. " (or "ECX: ") in front of the detail; the title says it. */
function detailOnly(detail) {
  return detail.replace(/^[A-Z]{3}: (REORG\. )?/u, "");
}

/**
 * One alert per transaction that has reorg records: the newest one, with how many there were.
 * `active` is false once track saw the split (or its replacement) confirmed deep enough again.
 */
export function reorgAlerts(transactions) {
  const out = [];
  for (const t of transactions) {
    const all = t.progress?.reorgs ?? [];
    if (!all.length) continue;
    const r = all[all.length - 1];
    const title = alertTitle(r.kind);
    const count = all.length > 1 ? ` · ${all.length} alerts` : "";
    const head = `${title} ${t.chain.toUpperCase()} #${t.order} (${r.kind}, ${utc(r.at)}${count})`;
    // A dropped split sent again: say so, rather than only "send it again".
    const now = r.kind === "evicted" && !r.resolved && t.progress?.unmined?.state !== "absent" &&
        t.progress?.broadcast?.status === "accepted"
      ? " Now: sent again, waiting to confirm."
      : "";
    out.push({
      active: !r.resolved,
      text: r.resolved
        ? `Resolved ${utc(r.resolved)}: ${head}: confirmed deep enough${
          r.kind === "evicted" ? "" : " again"
        }. Was: ${detailOnly(r.detail)}`
        : `${head}: ${detailOnly(r.detail)}${now}`,
    });
  }
  return out;
}

/** The least sat/vB a BIP125 replacement can pay: the old fee plus 1 sat/vB of its own size. */
export function minimumBumpRate(t) {
  if (!t.vsize) return undefined;
  return Math.ceil(((t.fee + t.vsize) / t.vsize) * 100) / 100;
}

/** The question the Fee bump prompt asks, with each transaction's current and minimum rate. */
export function bumpQuestion(txs) {
  const lines = txs.map((t) => {
    const min = minimumBumpRate(t);
    return `${t.chain.toUpperCase()} #${t.order}: now ${t.feeRate} sat/vB` +
      (min === undefined ? "" : `, a replacement needs at least ${min}`);
  });
  return [
    "New fee rate in sat/vB for the replacement.",
    ...lines,
    "Empty = the tool's suggestion (the backend's estimate, at least 1.5x the current rate).",
  ].join("\n");
}
