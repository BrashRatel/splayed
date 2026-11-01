/**
 * Guided-route planner (forks-first + 0x21): builds UNSIGNED PSBTs that move only a fork's copy of
 * shared coins to fresh addresses, with that fork's replay protection applied before signing.
 *
 *   ECX: nLockTime = 499,999,998 and nSequence = 0xfffffffd on every input (any signer).
 *   XBT: PSBT_IN_SIGHASH_TYPE = 0x21 on every input (needs a SIGHASH_UNIFIED-capable signer).
 *
 * Protection can't be added after signing (locktime/sequence are committed by every sighash; the
 * unified bit changes the digest), which is why it is stamped here, on the unsigned transaction.
 */
import { join } from "node:path";
import type { ChainBackend } from "../backends/types.ts";
import { fromHex, toHex } from "./bytes.ts";
import type { Config } from "./config.ts";
import {
  type DerivedOutput,
  networkForProfile,
  type OutputKind,
  type ParsedDescriptor,
  parseDescriptor,
} from "./descriptors.ts";
import type { DonorCoin } from "./donors.ts";
import { ECX_MAINNET_REPLAY_LOCKTIME, SIGHASH_UNIFIED } from "./profiles.ts";
import {
  derivationValue,
  encodePsbtBase64,
  GLOBAL_XPUB,
  IN_BIP32_DERIVATION,
  IN_NON_WITNESS_UTXO,
  IN_REDEEM_SCRIPT,
  IN_SIGHASH_TYPE,
  IN_TAP_BIP32_DERIVATION,
  IN_TAP_INTERNAL_KEY,
  IN_WITNESS_SCRIPT,
  IN_WITNESS_UTXO,
  type KeyValue,
  kv,
  OUT_BIP32_DERIVATION,
  OUT_REDEEM_SCRIPT,
  OUT_TAP_BIP32_DERIVATION,
  OUT_TAP_INTERNAL_KEY,
  OUT_WITNESS_SCRIPT,
  tapDerivationValue,
} from "./psbt.ts";
import type { ScanResult } from "./scan.ts";
import { classify, type CoinRecord } from "./state.ts";
import { ensureDir, writeJsonAtomic, writeTextAtomic } from "./store.ts";
import { compactSize, concatBytes, i64le, u32le } from "./bytes.ts";
import { parseTx, type Tx, txid as computeTxid } from "./tx.ts";
import type { WatchOnlyWallet } from "./wallet.ts";

export type ForkChain = "xbt" | "ecx";
export const RBF_SEQUENCE = 0xffff_fffd;
export const SIGHASH_ALL_UNIFIED = 0x01 | SIGHASH_UNIFIED;

export const XBT_SIGNERS: Record<string, { label: string; experimental?: boolean }> = {
  knots: { label: "Bitcoin Knots wallet (walletprocesspsbt)" },
  "sparrow-blake2b": { label: "Sparrow BLAKE2b build" },
  shrike: { label: "Shrike (Sparrow fork)" },
  embit: { label: "embit-based signer (sighash_unified)" },
  "privkeyio-firmware": {
    label: "privkeyio SeedSigner/Coldcard/Trezor firmware forks",
    experimental: true,
  },
};

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export type BatchPolicy = { kind: "coin" } | { kind: "address" } | { kind: "all" } | {
  kind: "size";
  size: number;
};

export function parseBatchPolicy(value: string | undefined): BatchPolicy {
  if (!value || value === "coin") return { kind: "coin" };
  if (value === "address") return { kind: "address" };
  if (value === "all") return { kind: "all" };
  const n = Number(value);
  if (Number.isSafeInteger(n) && n >= 1 && n <= 500) return { kind: "size", size: n };
  throw new PlanError('--batch must be "coin", "address", "all" or a number from 1 to 500');
}

// ---- Size estimation (vbytes; deliberately a little high) ----

function inputVbytes(kind: OutputKind, unified: boolean, ms?: { m: number; n: number }): number {
  const ecdsaSig = 73; // DER max + sighash byte
  switch (kind) {
    case "pkh":
      return 148;
    case "wpkh":
      return 68.25;
    case "sh-wpkh":
      return 91.25;
    case "tr":
      // 64-byte Schnorr sig, plus one byte when a sighash byte is appended (0x21 always is).
      return 41 + (1 + 1 + (unified ? 65 : 64)) / 4;
    case "wsh-ms":
    case "sh-wsh-ms": {
      const { m, n } = ms!;
      const script = 3 + 34 * n;
      const witness = 1 + 1 + m * (1 + ecdsaSig) + compactSize(script).length + script;
      return (kind === "wsh-ms" ? 41 : 76) + witness / 4;
    }
    case "sh-ms": {
      const { m, n } = ms!;
      const redeem = 3 + 34 * n;
      const scriptSig = 1 + m * (1 + ecdsaSig) + (redeem > 75 ? 2 : 1) + redeem;
      return 40 + compactSize(scriptSig).length + scriptSig;
    }
  }
}

export function estimateVsize(
  inputs: { kind: OutputKind; multisig?: { m: number; n: number } }[],
  outputScriptLength: number,
  unified: boolean,
): number {
  const segwit = inputs.some((i) => i.kind !== "pkh" && i.kind !== "sh-ms");
  const overhead = 4 + 4 + compactSize(inputs.length).length + 1 + (segwit ? 0.5 : 0);
  const output = 8 + 1 + outputScriptLength;
  const total = overhead + output +
    inputs.reduce((sum, i) => sum + inputVbytes(i.kind, unified, i.multisig), 0);
  return Math.ceil(total);
}

export function dustLimit(script: Uint8Array): number {
  if (script.length === 25) return 546; // P2PKH
  if (script.length === 23) return 540; // P2SH
  if (script.length === 22) return 294; // P2WPKH
  return 330; // P2WSH / P2TR
}

// ---- Planning ----

export interface PlanOptions {
  chains: ForkChain[];
  batch: BatchPolicy;
  feeRates: Partial<Record<ForkChain, number>>;
  xbtSigner?: string;
  /** Restrict to these outpoints ("txid:vout"). */
  coins?: string[];
  maxFeeFraction?: number;
  /**
   * Advanced XBT donor route: outpoints ("txid:vout") of XBT-only donors from the donor wallet,
   * one per XBT transaction. Replaces the 0x21 signer.
   */
  donors?: string[];
}

export interface PlannedInput {
  txid: string;
  vout: number;
  value: number;
  address?: string;
  kind: OutputKind;
}

export interface PlannedTx {
  chain: ForkChain;
  order: number;
  testFirst: boolean;
  file: string;
  /** Equals the final txid only when every input is native segwit or Taproot (no scriptSig). */
  unsignedTxid: string;
  inputs: PlannedInput[];
  output: { address: string; value: number; destinationIndex: number };
  /** Donor fan-out: every output (`output` is the first). Absent on ordinary one-output splits. */
  outputs?: { address: string; value: number; destinationIndex: number }[];
  fee: number;
  feeRate: number;
  vsize: number;
  lockTime: number;
  sequence: number;
  sighashType?: number;
  psbt: string;
  /**
   * XBT donor route: this transaction is protected by an XBT-only input (one of `inputs`) instead of
   * by 0x21, so its signatures are plain SIGHASH_ALL.
   */
  donor?: { txid: string; vout: number; value: number; provenance: string };
  /** Set on a fee-bump replacement: the transaction of an earlier plan this one replaces. */
  replaces?: { plan: string; file: string; txid: string; fee: number; feeRate: number };
}

export interface Plan {
  version: 1;
  id: string;
  createdAt: string;
  profile: string;
  route: "forks-first-0x21" | "forks-first-donor" | "donor-fanout";
  xbtSigner?: string;
  scanAt: string;
  batch: BatchPolicy;
  transactions: PlannedTx[];
  warnings: string[];
  /** Destination indexes this plan used, to be reserved in the wallet when written. */
  reserved: Partial<Record<ForkChain, number>>;
}

export interface PlanDeps {
  backends: Partial<Record<ForkChain, ChainBackend>>;
  /** Scanned donor wallet, needed for the donor route. */
  donors?: { coins: DonorCoin[]; descriptors: ParsedDescriptor[] };
  log?: (message: string) => void;
}

export interface Candidate {
  coin: CoinRecord;
  derived: DerivedOutput;
  descriptor: ParsedDescriptor;
  prevTx?: Tx;
  prevRaw?: string;
}

function groupBatches(cands: Candidate[], policy: BatchPolicy): Candidate[][] {
  switch (policy.kind) {
    case "coin":
      return cands.map((c) => [c]);
    case "all":
      return cands.length ? [cands] : [];
    case "size": {
      const out: Candidate[][] = [];
      for (let i = 0; i < cands.length; i += policy.size) out.push(cands.slice(i, i + policy.size));
      return out;
    }
    case "address": {
      const groups = new Map<string, Candidate[]>();
      for (const c of cands) {
        const key = c.coin.scriptPubKey;
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      return [...groups.values()];
    }
  }
}

function sameSeedWarning(dest: ParsedDescriptor, sources: ParsedDescriptor[]): string | undefined {
  const fps = new Set(sources.flatMap((s) => s.xpubs.map((x) => toHex(x.fingerprint))));
  if (dest.xpubs.some((x) => fps.has(toHex(x.fingerprint)))) {
    return "Destination uses the same key fingerprint as your source wallet. That works, but a " +
      "separate seed for each fork keeps fork coins from ever sitting next to your BTC.";
  }
  return undefined;
}

export async function buildPlan(
  config: Config,
  scan: ScanResult,
  wallet: WatchOnlyWallet,
  options: PlanOptions,
  deps: PlanDeps,
): Promise<Plan> {
  const log = deps.log ?? (() => {});
  const warnings: string[] = [];
  const sources = wallet.descriptors.map((d) =>
    parseDescriptor(d.descriptor, networkForProfile(config.profile))
  );
  const donorKeys = options.donors ?? [];
  if (donorKeys.length && !options.chains.includes("xbt")) {
    throw new PlanError("--donor only applies to XBT transactions: add xbt to --chains");
  }
  if (donorKeys.length && options.xbtSigner) {
    throw new PlanError(
      "Choose one XBT route: --xbt-signer (0x21 signatures) or --donor (XBT-only donor inputs)",
    );
  }
  if (options.chains.includes("xbt") && !donorKeys.length) {
    if (!options.xbtSigner) {
      throw new PlanError(
        "Say what will sign the XBT transactions with --xbt-signer. They need SIGHASH_UNIFIED " +
          "(0x21) signatures, which stock hardware wallets (Ledger, Trezor, Coldcard, Jade, " +
          "BitBox) can't make. Supported: " +
          Object.entries(XBT_SIGNERS).map(([k, v]) => `${k} (${v.label})`).join("; ") +
          ". If you only have a stock hardware wallet, plan ECX now (--chains ecx), or use the " +
          "advanced donor route: `forksplit donor import`, `donor scan`, then `plan --donor txid:vout`.",
      );
    }
    const signer = XBT_SIGNERS[options.xbtSigner];
    if (!signer) throw new PlanError(`Unknown --xbt-signer "${options.xbtSigner}"`);
    if (signer.experimental) {
      warnings.push(
        `${signer.label} is experimental and unaudited. Test with the smallest coin first.`,
      );
    }
  }
  if (!sources.every((s) => s.allKeysHaveOrigin)) {
    warnings.push(
      "A source descriptor has no [fingerprint/path] key origin. Most signers can't recognise " +
        "inputs without it; re-import the descriptor exported by your wallet.",
    );
  }
  const ctx = {
    tips: scan.tips,
    confirmations: {
      btc: config.chains.btc.confirmations,
      xbt: config.chains.xbt.confirmations,
      ecx: config.chains.ecx.confirmations,
    },
  };
  const filter = options.coins ? new Set(options.coins) : undefined;
  const transactions: PlannedTx[] = [];
  const reserved: Partial<Record<ForkChain, number>> = {};
  const now = new Date();
  // Sortable to the millisecond, plus randomness so two plans never collide.
  const id = `${now.toISOString().replace(/[-:]/gu, "").replace(/\.(\d+)Z$/u, "$1")}-${
    toHex(crypto.getRandomValues(new Uint8Array(3)))
  }`;

  for (const chain of options.chains) {
    const backend = deps.backends[chain];
    if (!backend) throw new PlanError(`No verified ${chain.toUpperCase()} backend`);
    const destination = wallet.destinations?.[chain];
    if (!destination) {
      throw new PlanError(
        `No ${chain.toUpperCase()} destination. Set one with ` +
          `\`forksplit dest set ${chain} '<descriptor>'\` (ideally from a new seed for ${chain.toUpperCase()}).`,
      );
    }
    const dest = parseDescriptor(destination.descriptor, networkForProfile(config.profile));
    const destBranch = dest.branches[0];
    if (!destBranch.ranged) {
      throw new PlanError("Destination descriptor must be ranged (end in /*)");
    }
    const seedWarning = sameSeedWarning(dest, sources);
    if (seedWarning) warnings.push(`${chain.toUpperCase()}: ${seedWarning}`);

    // 1. Candidates: coins the last scan saw shared and unspent on this fork.
    const cands: Candidate[] = [];
    for (const coin of scan.coins) {
      const key = `${coin.txid}:${coin.vout}`;
      if (filter && !filter.has(key)) continue;
      const c = classify(coin, ctx);
      const obs = coin.observations[chain];
      if (c.status !== "shared" || !c.unspentOn.includes(chain) || obs.state !== "unspent") {
        continue;
      }
      if (obs.createdHeight === undefined) {
        warnings.push(`${chain.toUpperCase()} ${key}: skipped, still unconfirmed`);
        continue;
      }
      if (
        coin.descriptorIndex === undefined || coin.branch === undefined ||
        coin.derivationIndex === undefined
      ) {
        warnings.push(`${chain.toUpperCase()} ${key}: skipped, origin unknown (re-scan)`);
        continue;
      }
      const descriptor = sources[coin.descriptorIndex];
      const derived = descriptor?.branches[coin.branch]?.derive(coin.derivationIndex);
      if (!derived || derived.scriptPubKey !== coin.scriptPubKey) {
        warnings.push(
          `${chain.toUpperCase()} ${key}: skipped, doesn't match its descriptor (re-scan)`,
        );
        continue;
      }
      cands.push({ coin, derived, descriptor });
    }
    if (!cands.length) {
      log(`${chain.toUpperCase()}: nothing to split`);
      continue;
    }

    // 2. Live re-check on this chain, and fetch + verify previous transactions.
    log(`${chain.toUpperCase()}: re-checking ${cands.length} coin(s) on ${backend.config.url}…`);
    const recheck = async (cand: Candidate, fatal = false): Promise<Candidate | undefined> => {
      const key = `${cand.coin.txid}:${cand.coin.vout}`;
      const obs = await backend.observeOutput(cand.coin.txid, cand.coin.vout).catch((e) => ({
        state: "unknown" as const,
        error: (e as Error).message,
      }));
      if (obs.state !== "unspent" || obs.createdHeight === undefined) {
        const message = `${chain.toUpperCase()} ${key}: now ${obs.state} on ${chain.toUpperCase()}`;
        if (fatal) throw new PlanError(`${message}; re-run \`donor scan\``);
        warnings.push(`${message.replace(": now", ": skipped, now")}`);
        return undefined;
      }
      if (obs.value !== cand.coin.value) {
        throw new PlanError(
          `${chain.toUpperCase()} ${key}: value changed (${cand.coin.value} → ${obs.value})`,
        );
      }
      if (cand.derived.kind !== "tr") {
        // Segwit v0 and legacy signers need the full previous transaction (and it's what stops a
        // server from lying about input amounts to inflate the fee).
        try {
          cand.prevRaw = await backend.rawTransaction(cand.coin.txid);
          cand.prevTx = parseTx(cand.prevRaw);
        } catch (error) {
          warnings.push(
            `${chain.toUpperCase()} ${key}: couldn't fetch the previous transaction ` +
              `(${(error as Error).message}); some hardware signers will refuse this input`,
          );
        }
        const out = cand.prevTx?.outputs[cand.coin.vout];
        if (
          cand.prevTx &&
          (!out || toHex(out.script) !== cand.coin.scriptPubKey ||
            Number(out.value) !== cand.coin.value)
        ) {
          throw new PlanError(
            `${chain.toUpperCase()} ${key}: previous transaction doesn't match the scan`,
          );
        }
      }
      return cand;
    };
    const live: Candidate[] = [];
    for (const cand of cands) {
      const ok = await recheck(cand);
      if (ok) live.push(ok);
    }

    // 2b. XBT donor route: the chosen donors, re-checked the same way.
    const donorRoute = chain === "xbt" && donorKeys.length > 0;
    const liveDonors: Candidate[] = [];
    if (donorRoute) {
      const pool = deps.donors;
      if (!pool) throw new PlanError("Scan the donor wallet first: `forksplit donor scan`");
      for (const key of donorKeys) {
        const coin = pool.coins.find((c) => `${c.txid}:${c.vout}` === key);
        if (!coin) throw new PlanError(`Donor ${key} isn't in the donor scan (run \`donor scan\`)`);
        if (!coin.eligible) {
          throw new PlanError(`Donor ${key} can't be used: ${coin.reasons.join("; ")}`);
        }
        if (liveDonors.some((d) => `${d.coin.txid}:${d.coin.vout}` === key)) {
          throw new PlanError(`Donor ${key} was given twice`);
        }
        const descriptor = coin.descriptorIndex === undefined
          ? undefined
          : pool.descriptors[coin.descriptorIndex];
        const derived = coin.branch === undefined || coin.derivationIndex === undefined
          ? undefined
          : descriptor?.branches[coin.branch]?.derive(coin.derivationIndex);
        if (!descriptor || !derived || derived.scriptPubKey !== coin.scriptPubKey) {
          throw new PlanError(`Donor ${key} doesn't match its descriptor (re-run \`donor scan\`)`);
        }
        if (live.some((c) => c.coin.txid === coin.txid && c.coin.vout === coin.vout)) {
          throw new PlanError(`Donor ${key} is also a shared coin; that can't be right`);
        }
        liveDonors.push((await recheck({ coin, derived, descriptor }, true))!);
      }
    }

    // 3. Fee rate.
    let feeRate = options.feeRates[chain];
    if (feeRate === undefined) {
      feeRate = await backend.feeRate?.(6).catch(() => undefined);
      if (feeRate === undefined) {
        throw new PlanError(
          `No fee estimate from the ${chain.toUpperCase()} backend; pass --fee-rate ${chain}=N`,
        );
      }
      feeRate = Math.max(1, Math.ceil(feeRate * 100) / 100);
      log(`${chain.toUpperCase()}: using the backend's fee estimate of ${feeRate} sat/vB`);
    }
    if (!(feeRate > 0 && feeRate <= 500)) {
      throw new PlanError(`${chain} fee rate must be 0-500 sat/vB`);
    }

    // 4. Batches -> transactions.
    let nextIndex = destination.nextIndex;
    const batches = groupBatches(live, options.batch)
      .sort((a, b) =>
        a.reduce((s, c) => s + c.coin.value, 0) - b.reduce((s, c) => s + c.coin.value, 0)
      );
    if (donorRoute && batches.length > liveDonors.length) {
      throw new PlanError(
        `XBT needs ${batches.length} transaction(s) with --batch ${
          options.batch.kind === "size" ? options.batch.size : options.batch.kind
        }, and each needs its own donor, but ${liveDonors.length} donor(s) were given. ` +
          "Give more --donor, or a bigger --batch (--batch all uses one donor).",
      );
    }
    if (donorRoute && batches.length) {
      warnings.push(
        "XBT donor route: these transactions use plain SIGHASH_ALL signatures and are protected only " +
          "because the donor input exists on XBT alone. Each one publicly links your donor wallet " +
          "to the coins it spends on XBT, and the donor's value ends up at the XBT destination.",
      );
    }
    for (const [n, batch] of batches.entries()) {
      const donor = donorRoute ? liveDonors[n] : undefined;
      // Fresh destination address, skipping any the chain has seen used.
      let destOut = destBranch.derive(nextIndex);
      for (let guard = 0; backend.addressTxCount && guard < 100; guard++) {
        if ((await backend.addressTxCount(destOut.address, destOut.scriptPubKey)) === 0) break;
        warnings.push(
          `${chain.toUpperCase()}: destination index ${nextIndex} already used; skipping it`,
        );
        destOut = destBranch.derive(++nextIndex);
      }
      const destScript = fromHex(destOut.scriptPubKey);
      if (chain === "xbt" && destScript.length > 34) {
        throw new PlanError(
          "XBT (RDTS) rejects output scripts over 34 bytes; use another destination type",
        );
      }
      const unified = chain === "xbt" && !donor;
      const inputs = [...batch, ...(donor ? [donor] : [])].sort((a, b) =>
        a.coin.txid.localeCompare(b.coin.txid) || a.coin.vout - b.coin.vout
      );
      const vsize = estimateVsize(inputs.map((c) => c.derived), destScript.length, unified);
      const inputValue = inputs.reduce((s, c) => s + c.coin.value, 0);
      const fee = Math.ceil(vsize * feeRate);
      const outputValue = inputValue - fee;
      const label = inputs.map((c) => `${c.coin.txid.slice(0, 8)}:${c.coin.vout}`).join(", ");
      if (outputValue < dustLimit(destScript)) {
        warnings.push(
          `${chain.toUpperCase()} ${label}: skipped, worth less than its fee; try a bigger --batch`,
        );
        continue;
      }
      if (fee > inputValue * (options.maxFeeFraction ?? 0.1)) {
        warnings.push(
          `${chain.toUpperCase()} ${label}: skipped, fee ${fee} sats is over ` +
            `${(options.maxFeeFraction ?? 0.1) * 100}% of its value; try a bigger --batch`,
        );
        continue;
      }
      const lockTime = chain === "ecx" ? ECX_MAINNET_REPLAY_LOCKTIME : 0;
      const tx: Tx = {
        version: 2,
        inputs: inputs.map((c) => ({
          txid: c.coin.txid,
          vout: c.coin.vout,
          scriptSig: new Uint8Array(),
          sequence: RBF_SEQUENCE,
          witness: [],
        })),
        outputs: [{ value: BigInt(outputValue), script: destScript }],
        lockTime,
      };
      const psbtInputs: KeyValue[][] = inputs.map((c) => inputMap(c, unified));
      const global: KeyValue[] = [];
      const seenXpub = new Set<string>();
      for (const c of inputs) {
        if (!c.derived.multisig || c.derived.multisig.n < 2) continue;
        for (const x of c.descriptor.xpubs) {
          const keyHex = toHex(x.raw);
          if (seenXpub.has(keyHex)) continue;
          seenXpub.add(keyHex);
          global.push(kv(GLOBAL_XPUB, x.raw, derivationValue(x.fingerprint, x.path)));
        }
      }
      const psbt = encodePsbtBase64({
        tx,
        global,
        inputs: psbtInputs,
        outputs: [outputMap(destOut)],
      });
      transactions.push({
        chain,
        order: n + 1,
        testFirst: n === 0 && batches.length > 1,
        file: `${chain}/${String(n + 1).padStart(3, "0")}-${computeTxid(tx).slice(0, 8)}.psbt`,
        unsignedTxid: computeTxid(tx),
        inputs: inputs.map((c) => ({
          txid: c.coin.txid,
          vout: c.coin.vout,
          value: c.coin.value,
          address: c.coin.address,
          kind: c.derived.kind,
        })),
        output: { address: destOut.address, value: outputValue, destinationIndex: nextIndex },
        fee,
        feeRate,
        vsize,
        lockTime,
        sequence: RBF_SEQUENCE,
        sighashType: unified ? SIGHASH_ALL_UNIFIED : undefined,
        psbt,
        donor: donor
          ? {
            txid: donor.coin.txid,
            vout: donor.coin.vout,
            value: donor.coin.value,
            provenance: (deps.donors!.coins.find((c) =>
              c.txid === donor.coin.txid && c.vout === donor.coin.vout
            ))!.provenance,
          }
          : undefined,
      });
      nextIndex++;
    }
    reserved[chain] = nextIndex;
  }

  return {
    version: 1,
    id,
    createdAt: now.toISOString(),
    profile: config.profile.id,
    route: donorKeys.length ? "forks-first-donor" : "forks-first-0x21",
    xbtSigner: options.xbtSigner,
    scanAt: scan.scannedAt,
    batch: options.batch,
    transactions,
    warnings,
    reserved,
  };
}

export function inputMap(c: Candidate, unified: boolean): KeyValue[] {
  const map: KeyValue[] = [];
  const d = c.derived;
  const script = fromHex(c.coin.scriptPubKey);
  if (c.prevRaw) map.push(kv(IN_NON_WITNESS_UTXO, new Uint8Array(), fromHex(c.prevRaw)));
  if (d.kind !== "pkh" && d.kind !== "sh-ms") {
    map.push(kv(
      IN_WITNESS_UTXO,
      new Uint8Array(),
      concatBytes(i64le(BigInt(c.coin.value)), compactSize(script.length), script),
    ));
  }
  if (unified) map.push(kv(IN_SIGHASH_TYPE, new Uint8Array(), u32le(SIGHASH_ALL_UNIFIED)));
  if (d.redeemScript) map.push(kv(IN_REDEEM_SCRIPT, new Uint8Array(), d.redeemScript));
  if (d.witnessScript) map.push(kv(IN_WITNESS_SCRIPT, new Uint8Array(), d.witnessScript));
  if (d.kind === "tr") {
    const [k] = d.keys;
    map.push(kv(IN_TAP_INTERNAL_KEY, new Uint8Array(), k.pubkey));
    map.push(kv(IN_TAP_BIP32_DERIVATION, k.pubkey, tapDerivationValue(k.fingerprint, k.path)));
  } else {
    for (const k of d.keys) {
      map.push(kv(IN_BIP32_DERIVATION, k.pubkey, derivationValue(k.fingerprint, k.path)));
    }
  }
  return map;
}

export function outputMap(d: DerivedOutput): KeyValue[] {
  const map: KeyValue[] = [];
  if (d.redeemScript) map.push(kv(OUT_REDEEM_SCRIPT, new Uint8Array(), d.redeemScript));
  if (d.witnessScript) map.push(kv(OUT_WITNESS_SCRIPT, new Uint8Array(), d.witnessScript));
  if (d.kind === "tr") {
    const [k] = d.keys;
    map.push(kv(OUT_TAP_INTERNAL_KEY, new Uint8Array(), k.pubkey));
    map.push(kv(OUT_TAP_BIP32_DERIVATION, k.pubkey, tapDerivationValue(k.fingerprint, k.path)));
  } else {
    for (const k of d.keys) {
      map.push(kv(OUT_BIP32_DERIVATION, k.pubkey, derivationValue(k.fingerprint, k.path)));
    }
  }
  return map;
}

export const PLANS_DIR = "plans";

const SIGNING_README = (plan: Plan) =>
  `forksplit plan ${plan.id}

These are UNSIGNED PSBTs for the guided route (forks-first + 0x21). Each one moves only a fork's
copy of your coins to a fresh address; your BTC is not touched.

ecx/  ECX splits. nLockTime = 499999998 and nSequence = 0xfffffffd on every input are already set.
      Any signer can sign them. Your signer must keep those fields: check the signed transaction
      still shows locktime 499999998 before it goes anywhere.
${
    plan.route === "donor-fanout"
      ? `xbt/  DONOR FAN-OUT. Each transaction spends one XBT-only donor and pays several smaller donors
      back to your donor wallet. Sign with the donor wallet using plain SIGHASH_ALL (not 0x21).
      Check that every output address is one of your donor wallet's own.
`
      : plan.transactions.some((t) => t.donor)
      ? `xbt/  XBT splits, DONOR ROUTE. Each one also spends an XBT-only donor input, which BTC and ECX
      don't have, so these transactions can't be replayed there. Sign them with any wallet,
      hardware wallets included, using plain SIGHASH_ALL (not 0x21). The signer must sign the
      donor input too: if the donor keys are in another wallet, sign with both in turn, passing
      the PSBT on. Don't let a signer change inputs or sighash flags (ANYONECANPAY is refused).
`
      : `xbt/  XBT splits. Every input asks for sighash type 0x21 (SIGHASH_ALL|SIGHASH_UNIFIED).
      Sign them with: ${
        plan.xbtSigner ? XBT_SIGNERS[plan.xbtSigner]?.label : "(no XBT transactions)"
      }.
      A signature without the 0x21 byte would be valid on BTC too. Don't let a signer "fix" it.
`
  }
${
    plan.transactions.some((t) => t.replaces)
      ? `This plan is a FEE BUMP: each transaction spends the same inputs as one from plan
${
        [...new Set(plan.transactions.map((t) => t.replaces?.plan))].join(", ")
      } and pays a higher fee (RBF). If the
original confirms first, the replacement simply becomes invalid. Sign it, then verify and
broadcast this plan as usual.

`
      : "Sign the transaction marked TEST FIRST on each chain before the rest.\n"
  }
Save each signed PSBT next to its original as <name>.signed.psbt (raw hex as <name>.signed.hex
also works), then:

  forksplit verify ${plan.id}
  forksplit broadcast ${plan.id}
  forksplit track ${plan.id}

verify checks every signature and replay marker against this plan. broadcast sends each
transaction only to its own chain, TEST FIRST transactions first. Don't broadcast these files
any other way: never send them to a Bitcoin node or explorer.
`;

/** Writes the plan to disk and reserves its destination indexes in the wallet. */
export async function writePlan(dataDir: string, plan: Plan): Promise<string> {
  const dir = join(dataDir, PLANS_DIR, plan.id);
  await ensureDir(join(dir, "ecx"));
  await ensureDir(join(dir, "xbt"));
  for (const tx of plan.transactions) await writeTextAtomic(join(dir, tx.file), tx.psbt + "\n");
  await writeJsonAtomic(join(dir, "plan.json"), plan);
  await writeTextAtomic(join(dir, "README.txt"), SIGNING_README(plan));
  return dir;
}
