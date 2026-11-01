import { assert, assertEquals } from "./assert.ts";
import {
  assessDonor,
  COINBASE_MATURITY,
  type DonorContext,
  isCoinbase,
} from "../src/core/donors.ts";
import type { CoinRecord } from "../src/core/state.ts";
import type { OutputObservation } from "../src/backends/types.ts";

const ctx: DonorContext = { tips: { xbt: 1000 }, xbtConfirmations: 6 };

function coin(over: Partial<Record<"btc" | "xbt" | "ecx", OutputObservation>> = {}): CoinRecord {
  return {
    txid: "aa".repeat(32),
    vout: 0,
    value: 5000,
    scriptPubKey: "0014" + "11".repeat(20),
    observations: {
      btc: { state: "absent" },
      ecx: { state: "absent" },
      xbt: { state: "unspent", value: 5000, createdHeight: 800 },
      ...over,
    },
  };
}

Deno.test("donor: an XBT-only, deep coinbase output is eligible", () => {
  assertEquals(assessDonor(coin(), ctx, "coinbase"), { eligible: true, reasons: [] });
  assertEquals(assessDonor(coin(), ctx, "protected-spend").eligible, true);
});

Deno.test("donor: a coin that exists on BTC or ECX is not a donor", () => {
  for (const chain of ["btc", "ecx"] as const) {
    for (
      const state of [
        { state: "unspent", value: 5000, createdHeight: 10 },
        { state: "gone" },
        { state: "spent", value: 5000, spendDetailKnown: true, spendTxid: "bb".repeat(32) },
      ] as OutputObservation[]
    ) {
      const r = assessDonor(coin({ [chain]: state }), ctx, "coinbase");
      assertEquals(r.eligible, false, `${chain} ${state.state}`);
      assert(r.reasons[0].includes(`exists on ${chain.toUpperCase()}`), r.reasons[0]);
    }
  }
});

Deno.test("donor: an unanswered BTC or ECX check is never treated as absent", () => {
  const r = assessDonor(coin({ ecx: { state: "unknown", error: "timeout" } }), ctx, "coinbase");
  assertEquals(r.eligible, false);
  assert(r.reasons[0].includes("couldn't check ECX"));
});

Deno.test("donor: unproven origin is refused, with the reason", () => {
  const r = assessDonor(coin(), ctx, "unproven");
  assertEquals(r.eligible, false);
  assert(r.reasons.some((x) => x.includes("unproven origin")));
});

Deno.test("donor: shallow, unconfirmed and immature coins are refused", () => {
  assertEquals(
    assessDonor(
      coin({ xbt: { state: "unspent", value: 1, createdHeight: 998 } }),
      ctx,
      "protected-spend",
    )
      .eligible,
    false,
  );
  assertEquals(
    assessDonor(coin({ xbt: { state: "unspent", value: 1 } }), ctx, "protected-spend").eligible,
    false,
  );
  const young = coin({
    xbt: { state: "unspent", value: 1, createdHeight: 1000 - COINBASE_MATURITY + 5 },
  });
  const r = assessDonor(young, ctx, "coinbase");
  assertEquals(r.eligible, false);
  assert(r.reasons.some((x) => x.includes("immature")));
  // The same depth is fine for an ordinary protected spend.
  assertEquals(assessDonor(young, ctx, "protected-spend").eligible, true);
});

Deno.test("donor: coinbase detection", () => {
  const coinbase = "01000000" + "01" + "00".repeat(32) + "ffffffff" + "01" + "ff" + "ffffffff" +
    "01" + "0000000000000000" + "00" + "00000000";
  assert(isCoinbase(coinbase));
  const ordinary = "01000000" + "01" + "11".repeat(32) + "00000000" + "00" + "ffffffff" + "01" +
    "0000000000000000" + "00" + "00000000";
  assertEquals(isCoinbase(ordinary), false);
});
