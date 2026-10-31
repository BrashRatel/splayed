import type { OutputObservation } from "../backends/types.ts";
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
