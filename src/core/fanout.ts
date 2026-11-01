/**
 * Donor fan-out: split one big XBT-only donor into several smaller ones, paid back to the donor
 * wallet. The transaction spends nothing but the donor, so it can't exist on BTC or ECX, and a plain
 * SIGHASH_ALL signature from the donor wallet is enough. Its outputs are XBT-only too, which is why a
 * verified and broadcast fan-out makes its outputs "protected-spend" donors (see donors.ts).
 */
import type { ChainBackend } from "../backends/types.ts";
import { fromHex, toHex } from "./bytes.ts";
import type { Config } from "./config.ts";
import { networkForProfile, type ParsedDescriptor, parseDescriptor } from "./descriptors.ts";
import type { DonorCoin } from "./donors.ts";
import {
  type Candidate,
  dustLimit,
  estimateVsize,
  inputMap,
  outputMap,
  type Plan,
  PlanError,
  type PlannedTx,
  RBF_SEQUENCE,
} from "./planner.ts";
import { encodePsbtBase64 } from "./psbt.ts";
import { parseTx, type Tx, txid as computeTxid } from "./tx.ts";
import type { WatchOnlyWallet } from "./wallet.ts";

export interface FanoutOptions {
  /** Outpoints ("txid:vout") of the donors to split; each gets its own transaction. */
  donors: string[];
  /** How many new donors per donor. */
  outputs: number;
  /** Exact value of each new donor (sats). Absent: split evenly. The rest comes back as change. */
  value?: number;
  feeRate: number;
  maxFeeFraction?: number;
}

export interface FanoutDeps {
  xbt: ChainBackend;
  donors: { coins: DonorCoin[]; descriptors: ParsedDescriptor[] };
  log?: (message: string) => void;
}

export async function buildFanout(
  config: Config,
  wallet: WatchOnlyWallet,
  options: FanoutOptions,
  deps: FanoutDeps,
): Promise<{ plan: Plan; nextIndex: Map<number, number> }> {
  const { xbt } = deps;
  if (!options.donors.length) throw new PlanError("Choose at least one donor to fan out");
  if (!Number.isSafeInteger(options.outputs) || options.outputs < 2 || options.outputs > 100) {
    throw new PlanError("--outputs must be a whole number from 2 to 100");
  }
  if (!(options.feeRate > 0 && options.feeRate <= 500)) {
    throw new PlanError("The fee rate must be 0-500 sat/vB");
  }
  const warnings: string[] = [];
  const nextIndex = new Map<number, number>();
  const transactions: PlannedTx[] = [];
  const seen = new Set<string>();

  for (const [n, key] of options.donors.entries()) {
    if (seen.has(key)) throw new PlanError(`Donor ${key} was given twice`);
    seen.add(key);
    const coin = deps.donors.coins.find((c) => `${c.txid}:${c.vout}` === key);
    if (!coin) throw new PlanError(`Donor ${key} isn't in the donor scan (run \`donor scan\`)`);
    if (!coin.eligible) {
      throw new PlanError(`Donor ${key} can't be used: ${coin.reasons.join("; ")}`);
    }
    const di = coin.descriptorIndex;
    const descriptor = di === undefined ? undefined : deps.donors.descriptors[di];
    const derived = coin.branch === undefined || coin.derivationIndex === undefined
      ? undefined
      : descriptor?.branches[coin.branch]?.derive(coin.derivationIndex);
    if (di === undefined || !descriptor || !derived || derived.scriptPubKey !== coin.scriptPubKey) {
      throw new PlanError(`Donor ${key} doesn't match its descriptor (re-run \`donor scan\`)`);
    }
    const branch = descriptor.branches[0];
    if (!branch.ranged) {
      throw new PlanError("The donor wallet descriptor must be ranged (end in /*)");
    }

    // Live re-check on XBT, and the previous transaction for signers that need it.
    const obs = await xbt.observeOutput(coin.txid, coin.vout);
    if (obs.state !== "unspent" || obs.createdHeight === undefined) {
      throw new PlanError(`Donor ${key} is now ${obs.state} on XBT; re-run \`donor scan\``);
    }
    if (obs.value !== coin.value) throw new PlanError(`Donor ${key}: value changed`);
    const cand: Candidate = { coin, derived, descriptor };
    if (derived.kind !== "tr") {
      cand.prevRaw = await xbt.rawTransaction(coin.txid);
      cand.prevTx = parseTx(cand.prevRaw);
      const out = cand.prevTx.outputs[coin.vout];
      if (!out || toHex(out.script) !== coin.scriptPubKey || Number(out.value) !== coin.value) {
        throw new PlanError(`Donor ${key}: previous transaction doesn't match the scan`);
      }
    }

    // New donor addresses: the wallet's counter, skipping any the chain has seen used.
    // Never earlier than the last index the scan saw a coin on: RPC backends can't say whether an
    // address was used, and reusing a donor address would tie the new donors to old ones.
    const scanned = deps.donors.coins
      .filter((c) => c.descriptorIndex === di && c.branch === 0 && c.derivationIndex !== undefined)
      .reduce((m, c) => Math.max(m, c.derivationIndex! + 1), 0);
    let next = Math.max(nextIndex.get(di) ?? wallet.donors?.[di]?.nextIndex ?? 0, scanned);
    const outs: { out: ReturnType<typeof branch.derive>; index: number }[] = [];
    const wanted = options.outputs + (options.value === undefined ? 0 : 1);
    while (outs.length < wanted) {
      const out = branch.derive(next);
      const used = xbt.addressTxCount
        ? (await xbt.addressTxCount(out.address, out.scriptPubKey)) > 0
        : false;
      if (used) warnings.push(`Donor address index ${next} was already used; skipping it`);
      else outs.push({ out, index: next });
      next++;
    }
    nextIndex.set(di, next);

    const scriptLen = fromHex(outs[0].out.scriptPubKey).length;
    if (scriptLen > 34) {
      throw new PlanError(
        "XBT (RDTS) rejects output scripts over 34 bytes; use another donor type",
      );
    }
    // Size: one input, N outputs (the helper counts one).
    const vsize = estimateVsize([derived], scriptLen, false) + (wanted - 1) * (9 + scriptLen);
    const fee = Math.ceil(vsize * options.feeRate);
    if (fee > coin.value * (options.maxFeeFraction ?? 0.1)) {
      throw new PlanError(`Donor ${key}: the fee ${fee} sats is over 10% of its value`);
    }
    const spendable = coin.value - fee;
    const dust = dustLimit(fromHex(outs[0].out.scriptPubKey));
    let values: number[];
    if (options.value === undefined) {
      const each = Math.floor(spendable / options.outputs);
      values = Array.from({ length: options.outputs }, () => each);
      values[values.length - 1] += spendable - each * options.outputs;
    } else {
      const change = spendable - options.value * options.outputs;
      if (change < 0) {
        throw new PlanError(
          `Donor ${key} (${coin.value} sats) can't pay ${options.outputs} × ${options.value} ` +
            `sats plus a ${fee} sat fee`,
        );
      }
      values = Array(options.outputs).fill(options.value);
      if (change >= dust) values.push(change);
      else values[values.length - 1] += change; // too small for its own output: keep it in the last
      if (values.length < wanted) outs.pop();
    }
    if (values.some((v) => v < dust)) {
      throw new PlanError(`Donor ${key}: an output would be below the dust limit (${dust} sats)`);
    }
    if (values.some((v) => v < 2000)) {
      warnings.push(
        `Donor ${key}: some new donors are under 2000 sats, which may cost more to spend than ` +
          "they are worth at a normal fee rate",
      );
    }

    const tx: Tx = {
      version: 2,
      inputs: [{
        txid: coin.txid,
        vout: coin.vout,
        scriptSig: new Uint8Array(),
        sequence: RBF_SEQUENCE,
        witness: [],
      }],
      outputs: values.map((v, i) => ({
        value: BigInt(v),
        script: fromHex(outs[i].out.scriptPubKey),
      })),
      lockTime: 0,
    };
    const unsignedTxid = computeTxid(tx);
    const outputs = values.map((v, i) => ({
      address: outs[i].out.address,
      value: v,
      destinationIndex: outs[i].index,
    }));
    transactions.push({
      chain: "xbt",
      order: n + 1,
      testFirst: false,
      file: `xbt/${String(n + 1).padStart(3, "0")}-${unsignedTxid.slice(0, 8)}.psbt`,
      unsignedTxid,
      inputs: [{
        txid: coin.txid,
        vout: coin.vout,
        value: coin.value,
        address: coin.address,
        kind: derived.kind,
      }],
      output: outputs[0],
      outputs,
      fee: coin.value - values.reduce((s, v) => s + v, 0),
      feeRate: options.feeRate,
      vsize,
      lockTime: 0,
      sequence: RBF_SEQUENCE,
      psbt: encodePsbtBase64({
        tx,
        global: [],
        inputs: [inputMap(cand, false)],
        outputs: values.map((_, i) => outputMap(outs[i].out)),
      }),
      donor: { txid: coin.txid, vout: coin.vout, value: coin.value, provenance: coin.provenance },
    });
  }

  const now = new Date();
  const id = `${now.toISOString().replace(/[-:]/gu, "").replace(/\.(\d+)Z$/u, "$1")}-${
    toHex(crypto.getRandomValues(new Uint8Array(3)))
  }`;
  warnings.push(
    "Donor fan-out: each transaction spends one donor and pays the new donors to your donor " +
      "wallet. The new donors count as XBT-only once the fan-out is verified and broadcast.",
  );
  return {
    plan: {
      version: 1,
      id,
      createdAt: now.toISOString(),
      profile: config.profile.id,
      route: "donor-fanout",
      scanAt: now.toISOString(),
      batch: { kind: "coin" },
      transactions,
      warnings,
      reserved: {},
    },
    nextIndex,
  };
}

/** Parses the donor descriptors of a wallet (helper for callers). */
export function donorDescriptors(wallet: WatchOnlyWallet, config: Config): ParsedDescriptor[] {
  return (wallet.donors ?? []).map((d) =>
    parseDescriptor(d.descriptor, networkForProfile(config.profile))
  );
}
