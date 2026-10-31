/**
 * RBF fee bump: a new plan revision that spends the same inputs as an earlier plan's transaction at
 * a higher fee. Every planned transaction signals RBF (nSequence 0xfffffffd), so a node that holds
 * the original will replace it with this one if it follows BIP125:
 *
 *   - the replacement pays at least the absolute fee of what it replaces, and
 *   - at least the incremental relay feerate more, for its own size.
 *
 * Nothing but the output value changes: inputs, sequences, locktime (the ECX marker) and the
 * 0x21 sighash request are copied from the original's own unsigned PSBT, so the replacement is
 * replay-protected exactly as the original was and is verified the same way.
 */
import { txid as computeTxid } from "./tx.ts";
import { dustLimit, type Plan, type PlannedTx } from "./planner.ts";
import { encodePsbtBase64, type Psbt } from "./psbt.ts";

/** Bitcoin Core, Knots and eCash default -incrementalrelayfee (1000 sat/kvB). */
export const INCREMENTAL_RELAY_FEE_RATE = 1;

export class BumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BumpError";
  }
}

/** The least absolute fee a BIP125 replacement of `oldFee` can pay for a `vsize` transaction. */
export function minimumReplacementFee(oldFee: number, vsize: number): number {
  return oldFee + Math.ceil(vsize * INCREMENTAL_RELAY_FEE_RATE);
}

/** Rounds up to 0.01 sat/vB so a displayed rate is never below the fee actually paid. */
const ceilRate = (rate: number) => Math.ceil(rate * 100) / 100;

/**
 * Rate used when the user gives none: the backend's estimate if any, at least 1.5x the old rate,
 * and never below what BIP125 needs.
 */
export function defaultBumpRate(old: PlannedTx, estimate?: number): number {
  const floor = minimumReplacementFee(old.fee, old.vsize) / old.vsize;
  return ceilRate(Math.max(estimate ?? 0, old.feeRate * 1.5, floor));
}

export interface ReplacementOptions {
  /** Plan the original belongs to. */
  oldPlanId: string;
  old: PlannedTx;
  /** The txid the original actually has on the network (not always its unsigned txid). */
  oldTxid: string;
  /** The original's own unsigned PSBT, as written by `plan`. */
  own: Psbt;
  feeRate: number;
  order: number;
  maxFeeFraction?: number;
}

export function buildReplacement(o: ReplacementOptions): PlannedTx {
  const { old, own } = o;
  const fee = Math.ceil(old.vsize * o.feeRate);
  const minimum = minimumReplacementFee(old.fee, old.vsize);
  if (fee < minimum) {
    throw new BumpError(
      `${old.chain.toUpperCase()} ${old.file}: ${o.feeRate} sat/vB is too low to replace it. ` +
        `A replacement must pay at least ${minimum} sats (the old fee ${old.fee} plus ` +
        `${INCREMENTAL_RELAY_FEE_RATE} sat/vB for its own ${old.vsize} vB), which is ` +
        `${ceilRate(minimum / old.vsize)} sat/vB.`,
    );
  }
  const inputValue = old.inputs.reduce((s, i) => s + i.value, 0);
  const value = inputValue - fee;
  const [output] = own.tx.outputs;
  if (own.tx.outputs.length !== 1) throw new BumpError("Expected a single-output plan transaction");
  if (value < dustLimit(output.script)) {
    throw new BumpError(`${old.file}: the new fee ${fee} sats would leave the output as dust`);
  }
  const limit = inputValue * (o.maxFeeFraction ?? 0.1);
  if (fee > limit) {
    throw new BumpError(
      `${old.file}: the new fee ${fee} sats is over ${(o.maxFeeFraction ?? 0.1) * 100}% of the ` +
        `${inputValue} sats being moved`,
    );
  }
  const tx = { ...own.tx, outputs: [{ ...output, value: BigInt(value) }] };
  const unsignedTxid = computeTxid(tx);
  return {
    ...old,
    order: o.order,
    testFirst: false,
    file: `${old.chain}/${String(o.order).padStart(3, "0")}-${unsignedTxid.slice(0, 8)}.psbt`,
    unsignedTxid,
    output: { ...old.output, value },
    fee,
    feeRate: o.feeRate,
    psbt: encodePsbtBase64({ ...own, tx }),
    replaces: {
      plan: o.oldPlanId,
      file: old.file,
      txid: o.oldTxid,
      fee: old.fee,
      feeRate: old.feeRate,
    },
  };
}

/** Wraps replacements in a plan revision that otherwise mirrors the original plan. */
export function bumpPlan(original: Plan, id: string, transactions: PlannedTx[], now: Date): Plan {
  return {
    ...original,
    id,
    createdAt: now.toISOString(),
    transactions,
    warnings: [],
    // The destination addresses were reserved by the original plan and are reused as they are.
    reserved: {},
  };
}
