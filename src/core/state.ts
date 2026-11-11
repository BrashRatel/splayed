import type { OutputObservation } from "../backends/types.ts";
import type { ChainSpecific } from "./chain_specific.ts";
import { CHAIN_IDS, type ChainId } from "./profiles.ts";

export interface CoinRecord {
  txid: string;
  vout: number;
  value: number;
  address?: string;
  scriptPubKey: string;
  descriptorIndex?: number;
  branch?: number;
  derivationIndex?: number;
  observations: Record<ChainId, OutputObservation>;
  /**
   * Set by the scan when the coin's creating transaction can't be valid on any other chain
   * (chain_specific.ts): the coin exists there only, now and later, whatever the other chains'
   * backends answer. Absent when not proven, or in scans written before this field existed.
   */
  onlyOn?: ChainSpecific;
}

export type SeparationStatus =
  /** Unspent on two or more chains: a spend on one may replay onto the others. */
  | "shared"
  /** Unspent on exactly one chain, and every other copy is deeply spent or absent. */
  | "separated"
  /** Looks separated but a spend is unconfirmed, shallow, or its depth can't be checked. */
  | "pending"
  /** At least one chain couldn't be asked. Never shown as safe. */
  | "unverified"
  /** Not unspent anywhere. */
  | "spent";

export interface Classification {
  status: SeparationStatus;
  unspentOn: ChainId[];
  reasons: string[];
  /** Guided route (forks-first + 0x21): what to do next, in order. */
  nextSteps: string[];
  /** The coin was proven to exist on one chain only (see CoinRecord.onlyOn). */
  chainSpecific?: ChainSpecific;
}

/**
 * Whether a coin's single-chain proof holds against what the chains say now: unspent on its own
 * chain, and no other chain reporting it unspent or spent (either would mean it does exist there,
 * and the proof is wrong, so it is ignored and the observations decide).
 */
export function provenChainSpecific(coin: CoinRecord): ChainSpecific | undefined {
  const p = coin.onlyOn;
  if (!p || coin.observations[p.chain]?.state !== "unspent") return undefined;
  for (const chain of CHAIN_IDS) {
    if (chain === p.chain) continue;
    const s = coin.observations[chain]?.state;
    if (s === "unspent" || s === "spent") return undefined;
  }
  return p;
}

export interface ClassifyContext {
  tips: Partial<Record<ChainId, number>>;
  confirmations: Record<ChainId, number>;
}

function depth(tip: number | undefined, height: number | undefined): number | undefined {
  if (tip === undefined || height === undefined) return undefined;
  return tip - height + 1;
}

const LABEL: Record<ChainId, string> = { btc: "BTC", xbt: "XBT", ecx: "ECX" };

/** Steps for the guided route, given which chains still hold the coin unspent. */
export function guidedNextSteps(unspentOn: ChainId[]): string[] {
  const has = (c: ChainId) => unspentOn.includes(c);
  if (unspentOn.length < 2) return [];
  const steps: string[] = [];
  if (has("ecx")) {
    steps.push("Split on ECX: nLockTime 499,999,998 + non-final nSequence (any signer)");
  }
  if (has("xbt")) {
    steps.push(
      has("btc") || has("ecx")
        ? "Split on XBT: SIGHASH_ALL|UNIFIED (0x21) signature (needs a 0x21-capable signer)"
        : "Spend on XBT",
    );
  }
  if (has("btc")) steps.push("Then BTC is free to spend once the fork splits are deeply confirmed");
  return steps;
}

export function classify(coin: CoinRecord, ctx: ClassifyContext): Classification {
  const proven = provenChainSpecific(coin);
  if (proven) {
    // Its creating transaction can't be valid elsewhere: an unreachable backend or a "spent or
    // never existed" answer on another chain can only mean "never existed".
    return {
      status: "separated",
      unspentOn: [proven.chain],
      reasons: [`${LABEL[proven.chain]} only: created by ${proven.via}`],
      nextSteps: [],
      chainSpecific: proven,
    };
  }
  const reasons: string[] = [];
  const unspentOn: ChainId[] = [];
  let unknown = false;
  let pending = false;

  for (const chain of CHAIN_IDS) {
    const obs = coin.observations[chain];
    switch (obs.state) {
      case "unspent":
        unspentOn.push(chain);
        if (obs.createdHeight === undefined) {
          reasons.push(`${LABEL[chain]}: creating transaction is unconfirmed`);
        }
        break;
      case "unknown":
        unknown = true;
        reasons.push(`${LABEL[chain]}: couldn't check (${obs.error})`);
        break;
      case "absent":
        break;
      case "gone":
        pending = true;
        reasons.push(
          `${LABEL[chain]}: spent or never existed; this backend can't say which or how deep ` +
            "(enable txindex or add an Esplora backend)",
        );
        break;
      case "spent": {
        const d = depth(ctx.tips[chain], obs.spendHeight);
        if (!obs.spendDetailKnown) {
          pending = true;
          reasons.push(`${LABEL[chain]}: spent, but this backend can't report the spend's depth`);
        } else if (d === undefined) {
          pending = true;
          reasons.push(`${LABEL[chain]}: spend is unconfirmed`);
        } else if (d < ctx.confirmations[chain]) {
          pending = true;
          reasons.push(
            `${LABEL[chain]}: spend has ${d} of ${ctx.confirmations[chain]} required confirmations`,
          );
        }
        break;
      }
    }
  }

  let status: SeparationStatus;
  // Known-shared wins over unknown (it is definitely shared); unknown blocks every "safe" answer.
  if (unspentOn.length >= 2) status = "shared";
  else if (unknown) status = "unverified";
  else if (unspentOn.length === 0) status = "spent";
  else status = pending ? "pending" : "separated";

  return {
    status,
    unspentOn,
    reasons,
    nextSteps: status === "shared" ? guidedNextSteps(unspentOn) : [],
  };
}
