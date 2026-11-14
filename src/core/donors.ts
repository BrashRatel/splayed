/**
 * Advanced donor routes (XBT donor, BTC donor).
 *
 * A donor is a coin that exists on ONE chain only (its "home": XBT for the forks-first route, BTC for
 * the BTC-first route). The text below is written for XBT; the BTC donor is the same with the chains
 * swapped.
 *
 * A donor on XBT is a coin that exists on XBT only. A transaction that spends a donor next to a shared coin
 * can't be valid on BTC or ECX, because those chains have never heard of the donor input. The shared
 * coin can then be signed with an ordinary SIGHASH_ALL signature, which stock hardware wallets can
 * make, instead of the 0x21 signature only a few signers support.
 *
 * That holds only while the donor really is XBT-only, so every donor is judged on three things:
 *
 *   1. It is unspent and deep enough on XBT.
 *   2. It is ABSENT on BTC and ECX (not unknown, not "spent or never existed").
 *   3. Its creating transaction can't be broadcast elsewhere later: it is a coinbase of an XBT block,
 *      or the output of a transaction this tool itself verified and sent on XBT (protected by 0x21 or
 *      by another donor). Anything else is "unproven" and is refused: a funding transaction signed
 *      without 0x21 could still be sent to BTC by someone holding it, which would make the donor
 *      exist there and the spend replayable.
 */
import { join } from "node:path";
import type { ChainBackend } from "../backends/types.ts";
import { PLANS_DIR } from "./planner.ts";
import { loadProgress } from "./execute.ts";
import { isCoinbaseTx, proveFunding } from "./origin.ts";
import type { ChainId } from "./profiles.ts";
import type { CoinRecord } from "./state.ts";
import { readJson, writeJsonAtomic } from "./store.ts";
import { parseTx } from "./tx.ts";
import type { ScanResult } from "./scan.ts";

export const DONOR_SCAN_FILE = "donor-scan.json";
/** The web UI's record that the donor rules were read and accepted (see donorOptIn). */
export const DONOR_OPT_IN_FILE = "donor-opt-in.json";
/**
 * Bump when the donor rules or the linkage they create change in a way people should read again:
 * an opt-in to an older version no longer counts.
 */
export const DONOR_RULES_VERSION = 1;
/** Coinbase outputs can't be spent until this many blocks are on top of them. */
export const COINBASE_MATURITY = 100;

/**
 * coinbase: a mature coinbase of its home chain. protected-spend: made by a transaction this tool
 * verified and sent. verified-funding: made elsewhere, but its funding transaction was traced on
 * chain to a coinbase or a 0x21 signature (origin.ts). unproven: none of those, so it is refused.
 */
export type DonorProvenance = "coinbase" | "protected-spend" | "verified-funding" | "unproven";
/** The chain a donor lives on: the only chain that has it. */
export type DonorHome = "xbt" | "btc";

export interface DonorCoin extends CoinRecord {
  /** Absent in scans written before the BTC-first route: those are XBT donors. */
  home?: DonorHome;
  provenance: DonorProvenance;
  /** For verified-funding: how the funding transaction was shown to be home-only. */
  funding?: string;
  eligible: boolean;
  /** Why it is not eligible (empty when it is). */
  reasons: string[];
}

export interface DonorScan {
  version: 1;
  scannedAt: string;
  profile: string;
  tips: ScanResult["tips"];
  warnings: string[];
  coins: DonorCoin[];
}

/**
 * Txids of transactions this tool verified and sent on `home`: their outputs exist on that chain only
 * (the transaction was protected, so it never reached the other chains).
 */
export async function protectedTxids(dataDir: string, home: ChainId): Promise<Set<string>> {
  const out = new Set<string>();
  const root = join(dataDir, PLANS_DIR);
  try {
    for await (const e of Deno.readDir(root)) {
      if (!e.isDirectory) continue;
      const dir = join(root, e.name);
      const plan = await readJson<
        { transactions: { chain: string; file: string; gate?: unknown }[] }
      >(
        join(dir, "plan.json"),
      );
      if (!plan) continue;
      const progress = await loadProgress(dir);
      for (const t of plan.transactions) {
        const v = progress.txs[t.file]?.verified;
        const sent = progress.txs[t.file]?.broadcast?.status === "accepted";
        // A gated transaction (plain signature, sent after the coin was spent everywhere else) is
        // not protected: its outputs are ordinary shared-chain coins.
        if (t.chain === home && v && sent && !t.gate) out.add(v.txid);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out;
}

export const protectedXbtTxids = (dataDir: string) => protectedTxids(dataDir, "xbt");

/** protectedTxids for every chain, for a scan's chain-specific proofs. */
export async function protectedByChain(dataDir: string): Promise<Record<ChainId, Set<string>>> {
  return {
    btc: await protectedTxids(dataDir, "btc"),
    xbt: await protectedTxids(dataDir, "xbt"),
    ecx: await protectedTxids(dataDir, "ecx"),
  };
}

export interface DonorContext {
  tips: ScanResult["tips"];
  /** Confirmations XBT needs before a coin counts (config). */
  xbtConfirmations: number;
  /** Same for BTC (defaults to the XBT figure). */
  btcConfirmations?: number;
}

/** Which chain a scanned coin could be a donor on: where it is unspent, XBT if neither. */
export function homeOf(coin: CoinRecord): DonorHome {
  return coin.observations.btc.state === "unspent" && coin.observations.xbt.state !== "unspent"
    ? "btc"
    : "xbt";
}

/** Pure judgement of one scanned donor candidate. */
export function assessDonor(
  coin: CoinRecord,
  ctx: DonorContext,
  provenance: DonorProvenance,
  home: DonorHome = "xbt",
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const H = home.toUpperCase();
  const here = coin.observations[home];
  const needed = home === "btc"
    ? ctx.btcConfirmations ?? ctx.xbtConfirmations
    : ctx.xbtConfirmations;
  if (here.state !== "unspent") {
    reasons.push(`not unspent on ${H} (${here.state})`);
  } else if (here.createdHeight === undefined) {
    reasons.push(`its creating transaction is unconfirmed on ${H}`);
  } else if (ctx.tips[home] === undefined) {
    reasons.push(`${H} tip unknown`);
  } else {
    const depth = ctx.tips[home]! - here.createdHeight + 1;
    if (depth < needed) {
      reasons.push(`only ${depth} of ${needed} confirmations on ${H}`);
    }
    if (provenance === "coinbase" && depth < COINBASE_MATURITY) {
      reasons.push(`coinbase output is immature (${depth} of ${COINBASE_MATURITY} blocks)`);
    }
  }
  for (const chain of (["btc", "xbt", "ecx"] as const).filter((c) => c !== home)) {
    const o = coin.observations[chain];
    if (o.state === "unknown") {
      reasons.push(`couldn't check ${chain.toUpperCase()} (${o.error})`);
    } else if (o.state !== "absent") {
      reasons.push(
        `exists on ${chain.toUpperCase()} (${o.state}): it is a shared coin, not a ${H}-only donor`,
      );
    }
  }
  if (provenance === "unproven") {
    reasons.push(
      `unproven origin: not a ${H} coinbase and not made by a transaction this tool verified on ` +
        `${H}, so someone could still put its funding transaction on another chain. Make donors by ` +
        "mining, or by splitting to a donor address first with a protected transaction",
    );
  }
  return { eligible: reasons.length === 0, reasons };
}

export function isCoinbase(rawTx: string): boolean {
  return isCoinbaseTx(parseTx(rawTx));
}

/** Works out each donor's provenance and eligibility from a scan of the donor descriptors. */
export async function evaluateDonors(
  scan: ScanResult,
  backends: Partial<Record<ChainId, ChainBackend>>,
  confirmations: Record<DonorHome, number>,
  protectedByHome: Record<DonorHome, Set<string>>,
): Promise<DonorScan> {
  const warnings = [...scan.warnings];
  const coins: DonorCoin[] = [];
  const fundingNotes = new Map<string, string>();
  const ctx = {
    tips: scan.tips,
    xbtConfirmations: confirmations.xbt,
    btcConfirmations: confirmations.btc,
  };
  for (const coin of scan.coins) {
    const home = homeOf(coin);
    let provenance: DonorProvenance = "unproven";
    if (coin.observations[home].state === "unspent") {
      const backend = backends[home];
      if (protectedByHome[home].has(coin.txid)) {
        provenance = "protected-spend";
      } else if (coin.onlyOn?.chain === home) {
        // The scan already proved its creating transaction can't be valid elsewhere.
        provenance = coin.onlyOn.kind === "coinbase" ? "coinbase" : "verified-funding";
        if (provenance === "verified-funding") {
          fundingNotes.set(`${coin.txid}:${coin.vout}`, coin.onlyOn.via);
        }
      } else if (backend) {
        try {
          if (isCoinbase(await backend.rawTransaction(coin.txid))) {
            provenance = "coinbase";
          } else {
            // Funded by someone else's transaction: trace it on chain.
            const others = (["btc", "xbt", "ecx"] as const).filter((c) => c !== home);
            const proof = await proveFunding(coin.txid, {
              home,
              rawTransaction: (id) => backend.rawTransaction(id),
              absentElsewhere: async (id, vout) => {
                for (const c of others) {
                  const other = backends[c];
                  if (!other) return false;
                  const o = await other.observeOutput(id, vout).catch(() => undefined);
                  if (o?.state !== "absent") return false;
                }
                return true;
              },
              ownProtected: protectedByHome[home],
            });
            if (proof.ok) {
              provenance = "verified-funding";
              fundingNotes.set(`${coin.txid}:${coin.vout}`, proof.via);
            } else {
              fundingNotes.set(`${coin.txid}:${coin.vout}`, proof.reason);
            }
          }
        } catch (error) {
          warnings.push(
            `${coin.txid.slice(0, 8)}:${coin.vout}: couldn't read its creating transaction ` +
              `(${(error as Error).message})`,
          );
        }
      }
    }
    const verdict = assessDonor(coin, ctx, provenance, home);
    const note = fundingNotes.get(`${coin.txid}:${coin.vout}`);
    if (note && provenance === "unproven") verdict.reasons.push(`(${note})`);
    coins.push({
      ...coin,
      home,
      provenance,
      ...verdict,
      ...(provenance === "verified-funding" ? { funding: note } : {}),
    });
  }
  return {
    version: 1,
    scannedAt: scan.scannedAt,
    profile: scan.profile,
    tips: scan.tips,
    warnings,
    coins,
  };
}

export async function saveDonorScan(dataDir: string, scan: DonorScan): Promise<void> {
  await writeJsonAtomic(join(dataDir, DONOR_SCAN_FILE), scan);
}

export async function loadDonorScan(dataDir: string): Promise<DonorScan | undefined> {
  return await readJson<DonorScan>(join(dataDir, DONOR_SCAN_FILE));
}

export const donorKey = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`;

/** The shortest summary of a donor for tables. */
export function describeDonor(c: DonorCoin): string {
  const home = (c.home ?? "xbt").toUpperCase();
  return c.eligible
    ? `${home} donor · ${c.provenance}${c.funding ? ` (${c.funding})` : ""}`
    : `${home} · ${c.provenance} · NOT usable: ${c.reasons[0]}`;
}

export interface DonorOptIn {
  version: 1;
  rules: number;
  at: string;
}

/** The web UI's donor opt-in, if one was given for the current rules. */
export async function donorOptIn(dataDir: string): Promise<DonorOptIn | undefined> {
  const r = await readJson<DonorOptIn>(join(dataDir, DONOR_OPT_IN_FILE));
  return r?.rules === DONOR_RULES_VERSION ? r : undefined;
}

/** Records (accept) or withdraws the opt-in. */
export async function setDonorOptIn(dataDir: string, accept: boolean, now = new Date()) {
  if (accept) {
    await writeJsonAtomic(
      join(dataDir, DONOR_OPT_IN_FILE),
      {
        version: 1,
        rules: DONOR_RULES_VERSION,
        at: now.toISOString(),
      } satisfies DonorOptIn,
    );
    return;
  }
  await Deno.remove(join(dataDir, DONOR_OPT_IN_FILE)).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}

/** Whether CLI arguments use a donor route: any `donor` command, or a plan with donors. */
export function usesDonors(args: readonly string[]): boolean {
  return args[0] === "donor" ||
    args.some((a) =>
      a === "--donor" || a.startsWith("--donor=") || a === "--btc-first" ||
      a.startsWith("--btc-first=")
    );
}
