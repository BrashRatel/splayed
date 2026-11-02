import { assertEquals } from "./assert.ts";
import type { OutputObservation } from "../src/backends/types.ts";
import type { ChainId } from "../src/core/profiles.ts";
import { newSharedCoins, type ScanResult } from "../src/core/scan.ts";
import type { CoinRecord } from "../src/core/state.ts";
import { txid } from "./fakes.ts";

const CONF: Record<ChainId, number> = { btc: 6, xbt: 6, ecx: 6 };
const unspent: OutputObservation = { state: "unspent", value: 1000, createdHeight: 100 };
const absent: OutputObservation = { state: "absent" };
const deepSpend: OutputObservation = {
  state: "spent",
  spendTxid: "dd".repeat(32),
  spendHeight: 150,
  spendDetailKnown: true,
};
const unknown: OutputObservation = { state: "unknown", error: "timeout" };

const coin = (
  n: number,
  obs: Partial<Record<ChainId, OutputObservation>>,
): CoinRecord => ({
  txid: txid(n),
  vout: 0,
  value: 1000 * n,
  address: `bc1q-fake-${n}`,
  scriptPubKey: "",
  observations: { btc: unspent, xbt: absent, ecx: absent, ...obs },
});
const shared = (n: number) => coin(n, { xbt: unspent, ecx: unspent });
const split = (n: number) => coin(n, { xbt: deepSpend, ecx: deepSpend });

const scan = (at: string, coins: CoinRecord[], extra: Partial<ScanResult> = {}): ScanResult => ({
  version: 1,
  scannedAt: at,
  profile: "mainnet",
  tips: { btc: 200, xbt: 200, ecx: 200 },
  backends: {},
  addressesRevealed: {},
  warnings: [],
  coins,
  ...extra,
});

Deno.test("new shared: the first scan flags nothing; an unchanged rescan flags nothing", () => {
  assertEquals(newSharedCoins(undefined, scan("t1", [shared(1)]), CONF), []);
  assertEquals(newSharedCoins(scan("t1", [shared(1)]), scan("t2", [shared(1)]), CONF), []);
  // Coins that aren't shared never show up, new or not.
  assertEquals(
    newSharedCoins(scan("t1", [split(1)]), scan("t2", [split(1), coin(2, {})]), CONF),
    [],
  );
});

Deno.test("new shared: a coin missing from the previous scan is listed with when it was seen", () => {
  const prev = scan("t1", [split(1)]);
  const next = scan("t2", [split(1), coin(2, { ecx: unspent })]);
  assertEquals(newSharedCoins(prev, next, CONF), [{
    txid: txid(2),
    vout: 0,
    value: 2000,
    address: "bc1q-fake-2",
    unspentOn: ["btc", "ecx"],
    previously: "absent",
    firstSeen: "t2",
  }]);
});

Deno.test("new shared: a coin that was separated, spent or unverified and is shared now is listed", () => {
  const prev = scan("t1", [
    split(1),
    coin(2, { btc: deepSpend, xbt: deepSpend, ecx: deepSpend }),
    coin(3, { xbt: unknown }),
  ]);
  const next = scan("t2", [shared(1), shared(2), shared(3)]);
  const found = newSharedCoins(prev, next, CONF);
  assertEquals(found.map((c) => [c.txid, c.previously]), [
    [txid(1), "separated"],
    [txid(2), "spent"],
    [txid(3), "unverified"],
  ]);
  // A coin that was already shared (even with an unknown third chain) is not new.
  const already = scan("t1", [coin(4, { xbt: unspent, ecx: unknown })]);
  assertEquals(newSharedCoins(already, scan("t2", [shared(4)]), CONF), []);
});

Deno.test("new shared: a flagged coin stays listed until it is split, keeping its first sighting", () => {
  const t2 = scan("t2", [split(1), shared(2)]);
  t2.newShared = newSharedCoins(scan("t1", [split(1)]), t2, CONF);
  assertEquals(t2.newShared.length, 1);
  // Rescan without splitting: still listed, still first seen at t2, still "absent" before.
  const t3 = scan("t3", [split(1), shared(2)]);
  t3.newShared = newSharedCoins(t2, t3, CONF);
  assertEquals(t3.newShared.map((c) => [c.txid, c.firstSeen, c.previously]), [
    [txid(2), "t2", "absent"],
  ]);
  // A chain that couldn't be asked doesn't clear it.
  const t4 = scan("t4", [split(1), coin(2, { xbt: unknown, ecx: unknown })]);
  t4.newShared = newSharedCoins(t3, t4, CONF);
  assertEquals(t4.newShared.map((c) => [c.txid, c.firstSeen, c.unspentOn]), [
    [txid(2), "t2", ["btc"]],
  ]);
  // Split shows on the chains: it drops off.
  const t5 = scan("t5", [split(1), split(2)]);
  assertEquals(newSharedCoins(t4, t5, CONF), []);
  // A shallow split (pending) also drops it; the plan's own tracking takes over from there.
  const shallow: OutputObservation = { ...deepSpend, spendHeight: 199 };
  const t5b = scan("t5", [split(1), coin(2, { xbt: shallow, ecx: shallow })]);
  assertEquals(newSharedCoins(t4, t5b, CONF), []);
});

Deno.test("new shared: a split that left the chain (reorg) is flagged again", () => {
  const prev = scan("t1", [coin(1, { xbt: deepSpend, ecx: deepSpend })]);
  const next = scan("t2", [coin(1, { xbt: deepSpend, ecx: unspent })]);
  const found = newSharedCoins(prev, next, CONF);
  assertEquals(found.map((c) => [c.unspentOn, c.previously]), [[["btc", "ecx"], "separated"]]);
});
