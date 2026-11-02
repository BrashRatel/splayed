import { assert, assertEquals } from "./assert.ts";
import {
  bumpable,
  bumpQuestion,
  depthText,
  minimumBumpRate,
  reorgAlerts,
  utc,
} from "../src/ui/static/plan_status.js";

const sent = { status: "accepted", at: "2026-11-02T10:00:00.000Z", backend: "b", attempts: 1 };

Deno.test("Plans tab: a split that left its block can be fee-bumped again", () => {
  assertEquals(bumpable({ broadcast: sent }), true);
  assertEquals(bumpable({ broadcast: sent, confirmations: { depth: 2, at: "x" } }), false);
  // After a reorg track records depth 0; the stale depth used to hide the button.
  for (const state of ["mempool", "absent"]) {
    assertEquals(
      bumpable({
        broadcast: { ...sent, status: state === "absent" ? "unknown" : "accepted" },
        confirmations: { depth: 0, at: "y", state, previous: { depth: 2, at: "x" } },
      }),
      true,
      state,
    );
  }
  assertEquals(
    bumpable({ broadcast: { ...sent, status: "conflict" }, confirmations: undefined }),
    false,
  );
  assertEquals(bumpable({ broadcast: { ...sent, status: "replaced" } }), false);
  assertEquals(bumpable({}), false);
});

Deno.test("Plans tab: no second bump while one is written and not sent", () => {
  assertEquals(bumpable({ broadcast: sent, pendingBump: { plan: "p-bump1", file: "f" } }), false);
});

Deno.test("Plans tab: depth text follows the split out of its block", () => {
  assertEquals(depthText({}), null);
  assertEquals(depthText({ confirmations: { depth: 3, at: "x" } }), "3 conf");
  assertEquals(
    depthText({ confirmations: { depth: 0, at: "y", state: "mempool", previous: { depth: 2 } } }),
    "back in the mempool (was 2 conf)",
  );
  assertEquals(
    depthText({ confirmations: { depth: 0, at: "y", state: "absent", previous: { depth: 2 } } }),
    "not on the chain (was 2 conf)",
  );
});

Deno.test("Plans tab: reorg alerts are titled by kind, counted, timed in UTC, muted once resolved", () => {
  const t = (reorgs: unknown[]) => ({ chain: "ecx", order: 1, progress: { reorgs } });
  const [one] = reorgAlerts([
    t([
      { at: "2026-11-02T10:00:00.000Z", kind: "unconfirmed", detail: "ECX: REORG. Old text." },
      { at: "2026-11-02T11:30:05.123Z", kind: "dropped", detail: "This split has left." },
    ]),
  ]);
  assertEquals(one.active, true);
  assertEquals(
    one.text,
    "REORG ECX #1 (dropped, 2026-11-02 11:30:05 UTC · 2 alerts): This split has left.",
  );
  const [conflict] = reorgAlerts([
    t([{ at: "2026-11-02T10:00:00.000Z", kind: "conflict", detail: "ECX: input spent." }]),
  ]);
  assert(conflict.text.startsWith("CONFLICT ECX #1 (conflict,"), conflict.text);
  assert(conflict.text.endsWith(": input spent."), conflict.text); // old "ECX: " prefix dropped
  const [done] = reorgAlerts([
    t([{
      at: "2026-11-02T10:00:00.000Z",
      kind: "moved",
      detail: "Moved.",
      resolved: "2026-11-02T12:00:00.000Z",
    }]),
  ]);
  assertEquals(done.active, false);
  assert(done.text.startsWith("Resolved 2026-11-02 12:00:00 UTC: REORG ECX #1"), done.text);
  assertEquals(reorgAlerts([t([])]), []);
  assertEquals(utc(undefined), "");
});

Deno.test("Plans tab: the bump prompt shows the current rate and the BIP125 minimum", () => {
  const tx = { chain: "ecx", order: 2, fee: 220, feeRate: 2, vsize: 110 };
  assertEquals(minimumBumpRate(tx), 3);
  const q = bumpQuestion([tx]);
  assert(q.includes("ECX #2: now 2 sat/vB, a replacement needs at least 3"), q);
});
