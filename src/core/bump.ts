/**
 * RBF fee bump: a new plan revision that spends the same inputs as an earlier plan's transaction at
 * a higher fee. Every planned transaction signals RBF (nSequence 0xfffffffd), so a node that holds
 * the original will replace it with this one if it follows BIP125:
 *
 *   - the replacement pays at least the absolute fee of what it replaces, and
 *   - at least the incremental relay feerate more, for its own size.
 *
 * Nothing but an output value changes: inputs, sequences, locktime (the ECX marker) and the
 * 0x21 sighash request are copied from the original's own unsigned PSBT, so the replacement is
 * replay-protected exactly as the original was and is verified the same way. A split has one
 * output, which pays the higher fee. A donor fan-out has several: the extra fee comes out of its
 * LAST output (the change when it has one, otherwise the new donor that already took the rounding),
 * so every other new donor keeps its value. BTC transactions (the BTC-first route) are replaced the
 * same way: their BTC donor input stays, so the replacement is as replay-protected as the original.
 */
import { parseTx, txid as computeTxid } from "./tx.ts";
import {
  type Candidate,
  dustLimit,
  estimateVsize,
  inputMap,
  outputMap,
  type Plan,
  type PlannedTx,
  RBF_SEQUENCE,
} from "./planner.ts";
import { encodePsbtBase64, type Psbt } from "./psbt.ts";
import { inputContexts } from "./sigcheck.ts";
import { fromHex, toHex } from "./bytes.ts";
import type { DerivedOutput } from "./descriptors.ts";
import { ECX_MAINNET_REPLAY_LOCKTIME } from "./profiles.ts";

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
  /**
   * Inputs ("txid:vout") to leave out of the replacement. The coins are not spent by it and stay
   * available for a later plan. At least one input must stay (that is what makes it a
   * replacement), and the donor of a donor transaction can't be dropped: it is the protection.
   */
  drop?: string[];
}

export function buildReplacement(o: ReplacementOptions): PlannedTx {
  let { old, own } = o;
  if (o.drop?.length) {
    const keys = old.inputs.map((i) => `${i.txid}:${i.vout}`);
    for (const d of o.drop) {
      if (!keys.includes(d)) throw new BumpError(`${old.file}: ${d} is not an input of it`);
    }
    if (new Set(o.drop).size !== o.drop.length) throw new BumpError("An input was named twice");
    if (old.donor && o.drop.includes(`${old.donor.txid}:${old.donor.vout}`)) {
      throw new BumpError(
        `${old.file}: the donor input protects it from replay and can't be dropped`,
      );
    }
    if (o.drop.length >= keys.length) {
      throw new BumpError(`${old.file}: keep at least one input, or it would not replace anything`);
    }
    const keep = keys.map((k) => !o.drop!.includes(k));
    const tx = { ...own.tx, inputs: own.tx.inputs.filter((_, i) => keep[i]) };
    const kept = old.inputs.filter((_, i) => keep[i]);
    own = { ...own, tx, inputs: own.inputs.filter((_, i) => keep[i]) };
    // Size the smaller transaction exactly: multisig shapes come from the PSBT's scripts.
    const ctxs = inputContexts(own, kept.map((i) => i.kind));
    const vsize = estimateVsize(
      kept.map((i, n) => ({
        kind: i.kind,
        multisig: ctxs[n].pubkeys.length > 1 || ctxs[n].threshold > 1
          ? { m: ctxs[n].threshold, n: ctxs[n].pubkeys.length }
          : undefined,
      })),
      own.tx.outputs[0].script.length,
      old.chain === "xbt" && old.sighashType !== undefined,
    );
    old = { ...old, inputs: kept, vsize: Math.min(vsize, old.vsize) };
    // Fee comparison below is against the ORIGINAL's absolute fee, which this keeps in `fee`.
  }
  const fee = Math.ceil(old.vsize * o.feeRate);
  const minimum = minimumReplacementFee(o.old.fee, old.vsize);
  if (fee < minimum) {
    throw new BumpError(
      `${old.chain.toUpperCase()} ${old.file}: ${o.feeRate} sat/vB is too low to replace it. ` +
        `A replacement must pay at least ${minimum} sats (the old fee ${old.fee} plus ` +
        `${INCREMENTAL_RELAY_FEE_RATE} sat/vB for its own ${old.vsize} vB), which is ` +
        `${ceilRate(minimum / old.vsize)} sat/vB.`,
    );
  }
  const inputValue = old.inputs.reduce((s, i) => s + i.value, 0);
  if (o.drop?.length && fee <= o.old.fee) {
    throw new BumpError(
      `${old.file}: with ${o.drop.length} input(s) dropped the new fee ${fee} sats must still ` +
        `exceed the old fee ${o.old.fee}`,
    );
  }
  const outs = own.tx.outputs;
  const fanout = outs.length > 1;
  if (fanout && old.outputs?.length !== outs.length) {
    throw new BumpError(`${old.file}: its outputs don't match the plan; can't replace it`);
  }
  if (!outs.length) throw new BumpError(`${old.file}: it has no outputs`);
  // Every output but the last keeps its value; the last pays for the rest.
  const kept = outs.slice(0, -1).reduce((s, x) => s + Number(x.value), 0);
  const last = outs[outs.length - 1];
  const value = inputValue - fee - kept;
  if (value < dustLimit(last.script)) {
    throw new BumpError(
      `${old.file}: the new fee ${fee} sats would leave ${
        fanout ? "its last output" : "the output"
      } as dust`,
    );
  }
  const limit = inputValue * (o.maxFeeFraction ?? 0.1);
  if (fee > limit) {
    throw new BumpError(
      `${old.file}: the new fee ${fee} sats is over ${(o.maxFeeFraction ?? 0.1) * 100}% of the ` +
        `${inputValue} sats being moved`,
    );
  }
  const tx = {
    ...own.tx,
    outputs: [...outs.slice(0, -1), { ...last, value: BigInt(value) }],
  };
  const unsignedTxid = computeTxid(tx);
  const outputs = old.outputs?.map((x, i, all) => i === all.length - 1 ? { ...x, value } : x);
  return {
    ...old,
    donor: old.donor,
    order: o.order,
    testFirst: false,
    file: `${old.chain}/${String(o.order).padStart(3, "0")}-${unsignedTxid.slice(0, 8)}.psbt`,
    unsignedTxid,
    output: fanout ? outputs![0] : { ...old.output, value },
    ...(outputs ? { outputs } : {}),
    fee,
    feeRate: o.feeRate,
    psbt: encodePsbtBase64({ ...own, tx }),
    replaces: {
      plan: o.oldPlanId,
      file: old.file,
      txid: o.oldTxid,
      fee: o.old.fee,
      feeRate: o.old.feeRate,
    },
  };
}

export interface CpfpOptions {
  chain: "xbt" | "ecx";
  parentPlanId: string;
  parent: PlannedTx;
  /** The parent as it was verified and sent. */
  parentTxid: string;
  parentHex: string;
  /** Derived destination output that received the parent's output 0, and its descriptor. */
  received: Candidate;
  /** Fresh address for the child's single output. */
  to: DerivedOutput;
  toIndex: number;
  /** Fee rate the parent and child together should pay. */
  packageRate: number;
  maxFeeFraction?: number;
}

/**
 * A child that spends the parent's output so the pair pays `packageRate`. The child is valid only
 * on the parent's chain (its input exists nowhere else), so it needs no replay protection of its
 * own: an XBT child is plainly signed. ECX children keep the marker anyway, for one rule.
 */
export function buildCpfp(o: CpfpOptions): PlannedTx {
  const { parent, received } = o;
  const parentTx = parseTx(o.parentHex);
  const out = parentTx.outputs[0];
  if (
    !out || toHex(out.script) !== received.coin.scriptPubKey ||
    Number(out.value) !== received.coin.value ||
    received.coin.txid !== o.parentTxid || received.coin.vout !== 0
  ) {
    throw new BumpError("The parent's first output isn't the split's destination output");
  }
  const toScript = fromHex(o.to.scriptPubKey);
  const childVsize = estimateVsize([received.derived], toScript.length, false);
  const wanted = Math.ceil(o.packageRate * (parent.vsize + childVsize)) - parent.fee;
  const fee = Math.max(wanted, Math.ceil(childVsize * INCREMENTAL_RELAY_FEE_RATE));
  if (wanted <= 0) {
    throw new BumpError(
      `The parent already pays ${
        ceilRate(parent.fee / parent.vsize)
      } sat/vB, which is at or above ` +
        `${o.packageRate} sat/vB: nothing to add`,
    );
  }
  const value = received.coin.value - fee;
  if (value < dustLimit(toScript)) {
    throw new BumpError(`A child paying ${fee} sats would leave its output as dust`);
  }
  if (fee > received.coin.value * (o.maxFeeFraction ?? 0.5)) {
    throw new BumpError(
      `A child paying ${fee} sats would eat over ${(o.maxFeeFraction ?? 0.5) * 100}% of the ` +
        `${received.coin.value} sats it spends`,
    );
  }
  const lockTime = o.chain === "ecx" ? ECX_MAINNET_REPLAY_LOCKTIME : 0;
  const tx = {
    version: 2,
    inputs: [{
      txid: o.parentTxid,
      vout: 0,
      scriptSig: new Uint8Array(),
      sequence: RBF_SEQUENCE,
      witness: [],
    }],
    outputs: [{ value: BigInt(value), script: toScript }],
    lockTime,
  };
  const unsignedTxid = computeTxid(tx);
  const psbt = encodePsbtBase64({
    tx,
    global: [],
    inputs: [inputMap(received, false)],
    outputs: [outputMap(o.to)],
  });
  return {
    chain: o.chain,
    order: 1,
    testFirst: false,
    file: `${o.chain}/001-${unsignedTxid.slice(0, 8)}.psbt`,
    unsignedTxid,
    inputs: [{
      txid: o.parentTxid,
      vout: 0,
      value: received.coin.value,
      address: received.coin.address,
      kind: received.derived.kind,
    }],
    output: { address: o.to.address, value, destinationIndex: o.toIndex },
    fee,
    feeRate: ceilRate(fee / childVsize),
    vsize: childVsize,
    lockTime,
    sequence: RBF_SEQUENCE,
    psbt,
    cpfp: {
      parent: {
        plan: o.parentPlanId,
        file: parent.file,
        txid: o.parentTxid,
        fee: parent.fee,
        vsize: parent.vsize,
      },
      packageRate: o.packageRate,
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
