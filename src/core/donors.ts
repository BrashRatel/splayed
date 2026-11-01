/**
 * Advanced XBT donor route.
 *
 * A donor is a coin that exists on XBT only. A transaction that spends a donor next to a shared coin
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
import type { CoinRecord } from "./state.ts";
import { readJson, writeJsonAtomic } from "./store.ts";
import { parseTx } from "./tx.ts";
import type { ScanResult } from "./scan.ts";

export const DONOR_SCAN_FILE = "donor-scan.json";
/** Coinbase outputs can't be spent until this many blocks are on top of them. */
export const COINBASE_MATURITY = 100;

export type DonorProvenance = "coinbase" | "protected-spend" | "unproven";

export interface DonorCoin extends CoinRecord {
  provenance: DonorProvenance;
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

const NULL_TXID = "0".repeat(64);

/** Txids of XBT transactions this tool verified: the outputs of those are XBT-only too. */
export async function protectedXbtTxids(dataDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const root = join(dataDir, PLANS_DIR);
  try {
    for await (const e of Deno.readDir(root)) {
      if (!e.isDirectory) continue;
      const dir = join(root, e.name);
      const plan = await readJson<{ transactions: { chain: string; file: string }[] }>(
        join(dir, "plan.json"),
      );
      if (!plan) continue;
      const progress = await loadProgress(dir);
      for (const t of plan.transactions) {
        const v = progress.txs[t.file]?.verified;
        const sent = progress.txs[t.file]?.broadcast?.status === "accepted";
        if (t.chain === "xbt" && v && sent) out.add(v.txid);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out;
}

export interface DonorContext {
  tips: ScanResult["tips"];
  /** Confirmations XBT needs before a coin counts (config). */
  xbtConfirmations: number;
}

/** Pure judgement of one scanned donor candidate. */
export function assessDonor(
  coin: CoinRecord,
  ctx: DonorContext,
  provenance: DonorProvenance,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const xbt = coin.observations.xbt;
  if (xbt.state !== "unspent") {
    reasons.push(`not unspent on XBT (${xbt.state})`);
  } else if (xbt.createdHeight === undefined) {
    reasons.push("its creating transaction is unconfirmed on XBT");
  } else if (ctx.tips.xbt === undefined) {
    reasons.push("XBT tip unknown");
  } else {
    const depth = ctx.tips.xbt - xbt.createdHeight + 1;
    if (depth < ctx.xbtConfirmations) {
      reasons.push(`only ${depth} of ${ctx.xbtConfirmations} confirmations on XBT`);
    }
    if (provenance === "coinbase" && depth < COINBASE_MATURITY) {
      reasons.push(`coinbase output is immature (${depth} of ${COINBASE_MATURITY} blocks)`);
    }
  }
  for (const chain of ["btc", "ecx"] as const) {
    const o = coin.observations[chain];
    if (o.state === "unknown") {
      reasons.push(`couldn't check ${chain.toUpperCase()} (${o.error})`);
    } else if (o.state !== "absent") {
      reasons.push(
        `exists on ${chain.toUpperCase()} (${o.state}): it is a shared coin, not an XBT-only donor`,
      );
    }
  }
  if (provenance === "unproven") {
    reasons.push(
      "unproven origin: not an XBT coinbase and not made by a transaction this tool verified on " +
        "XBT, so someone could still put its funding transaction on BTC. Make donors by mining, " +
        "or by splitting to a donor address first with a 0x21 signer",
    );
  }
  return { eligible: reasons.length === 0, reasons };
}

export function isCoinbase(rawTx: string): boolean {
  const tx = parseTx(rawTx);
  return tx.inputs.length === 1 && tx.inputs[0].txid === NULL_TXID &&
    tx.inputs[0].vout === 0xffff_ffff;
}

/** Works out each donor's provenance and eligibility from a scan of the donor descriptors. */
export async function evaluateDonors(
  scan: ScanResult,
  xbt: ChainBackend | undefined,
  xbtConfirmations: number,
  protectedTxids: Set<string>,
): Promise<DonorScan> {
  const warnings = [...scan.warnings];
  const coins: DonorCoin[] = [];
  const ctx = { tips: scan.tips, xbtConfirmations };
  for (const coin of scan.coins) {
    let provenance: DonorProvenance = "unproven";
    if (coin.observations.xbt.state === "unspent") {
      if (protectedTxids.has(coin.txid)) {
        provenance = "protected-spend";
      } else if (xbt) {
        try {
          if (isCoinbase(await xbt.rawTransaction(coin.txid))) provenance = "coinbase";
        } catch (error) {
          warnings.push(
            `${coin.txid.slice(0, 8)}:${coin.vout}: couldn't read its creating transaction ` +
              `(${(error as Error).message})`,
          );
        }
      }
    }
    coins.push({ ...coin, provenance, ...assessDonor(coin, ctx, provenance) });
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
  return c.eligible ? c.provenance : `${c.provenance} · NOT usable: ${c.reasons[0]}`;
}
