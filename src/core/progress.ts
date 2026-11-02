/**
 * Progress reports from long-running commands (Tor start-up, backend identity checks, scans),
 * so the web UI can show what is happening instead of looking hung. The terminal ignores them:
 * the CLI's normal log lines already cover the same steps.
 */
import type { ChainId } from "./profiles.ts";

export type ProgressPhase = "tor" | "identity" | "discovery" | "crosscheck";

export interface Progress {
  phase: ProgressPhase;
  chain?: ChainId;
  /** Steps finished so far (addresses checked, lookups done, Tor bootstrap percent). */
  done?: number;
  /** Total steps when known in advance. Discovery leaves it unset (the gap limit decides). */
  total?: number;
  /** Short human-readable description of the current step. */
  detail?: string;
}

export type ProgressSink = (p: Progress) => void;

/**
 * Wraps a sink so it passes at most one report per `intervalMs`, except that a report with a new
 * phase or chain, or a final one (`done === total`), always goes through. `flush()` sends the
 * last report that was held back.
 */
export function throttleProgress(
  sink: ProgressSink,
  intervalMs = 250,
  now: () => number = Date.now,
): ProgressSink & { flush: () => void } {
  let lastAt = -Infinity;
  let lastKey = "";
  let pending: Progress | undefined;
  const send = (p: Progress) => {
    lastAt = now();
    lastKey = `${p.phase}|${p.chain ?? ""}`;
    pending = undefined;
    sink(p);
  };
  const throttled = ((p: Progress) => {
    const key = `${p.phase}|${p.chain ?? ""}`;
    const final = p.total !== undefined && p.done === p.total;
    if (key !== lastKey || final || now() - lastAt >= intervalMs) send(p);
    else pending = p;
  }) as ProgressSink & { flush: () => void };
  throttled.flush = () => {
    if (pending) send(pending);
  };
  return throttled;
}

/** One line of text for a progress report, e.g. "ECX: checking server 1 of 2 · 12s". */
export function describeProgress(p: Progress): string {
  const chain = p.chain ? `${p.chain.toUpperCase()}: ` : "";
  const counts = p.done === undefined
    ? ""
    : p.phase === "tor"
    ? ` ${p.done}%`
    : p.total !== undefined
    ? ` (${p.done} of ${p.total})`
    : ` (${p.done})`;
  const label = {
    tor: "Tor",
    identity: "checking server",
    discovery: "addresses checked",
    crosscheck: "cross-checking coins",
  }[p.phase];
  return `${chain}${p.detail ?? label}${counts}`;
}
