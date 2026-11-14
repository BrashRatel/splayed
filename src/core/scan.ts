import { join } from "node:path";
import type { ChainBackend, FoundUtxo, OutputObservation } from "../backends/types.ts";
import type { Config } from "./config.ts";
import type { ParsedDescriptor } from "./descriptors.ts";
import { ownHistoryFrom, proveChainSpecific } from "./chain_specific.ts";
import { CHAIN_IDS, type ChainId } from "./profiles.ts";
import { type ProgressSink, throttleProgress } from "./progress.ts";
import { classify, type CoinRecord, type SeparationStatus } from "./state.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export const SCAN_FILE = "scan.json";

export interface ScanResult {
  version: 1;
  scannedAt: string;
  profile: string;
  tips: Partial<Record<ChainId, number>>;
  backends: Partial<Record<ChainId, { url: string; route: string }>>;
  addressesRevealed: Partial<Record<ChainId, number>>;
  warnings: string[];
  coins: CoinRecord[];
  /**
   * Shared coins that turned up since an earlier scan (see newSharedCoins). Absent in scan files
   * written before this field existed.
   */
  newShared?: NewSharedCoin[];
}

/** A coin that is shared now but wasn't in an earlier scan, or wasn't shared then. */
export interface NewSharedCoin {
  txid: string;
  vout: number;
  value: number;
  address?: string;
  /** Chains where it is unspent at this scan. */
  unspentOn: ChainId[];
  /** Its status in the scan before it was first flagged; "absent" if that scan didn't list it. */
  previously: SeparationStatus | "absent";
  /** scannedAt of the scan that first flagged it. */
  firstSeen: string;
}

export interface ScanDeps {
  /** Verified backends; a missing chain means "no backend passed identity checks". */
  backends: Partial<Record<ChainId, ChainBackend>>;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Address range scanned per branch with node RPC (scantxoutset has no gap limit). */
  rpcRange?: number;
  /** Structured progress for the web UI (throttled here). */
  progress?: ProgressSink;
  /** Clock for progress throttling; tests replace it. */
  now?: () => number;
  /**
   * Transactions this tool verified and sent with protection, per chain: their outputs exist on
   * that chain only (donors.ts protectedTxids).
   */
  ownProtected?: Partial<Record<ChainId, Set<string>>>;
  /** Most transactions fetched in all to prove coins chain-specific (default 200). */
  proofBudget?: number;
}

interface Origin {
  descriptorIndex: number;
  branch: number;
  derivationIndex: number;
  address: string;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function runScan(
  config: Config,
  descriptors: ParsedDescriptor[],
  deps: ScanDeps,
): Promise<ScanResult> {
  const log = deps.log ?? (() => {});
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const rpcRange = deps.rpcRange ?? 1000;
  const progress = throttleProgress(deps.progress ?? (() => {}), 250, deps.now);
  const warnings: string[] = [];
  const tips: ScanResult["tips"] = {};
  const addressesRevealed: ScanResult["addressesRevealed"] = {};
  const backendsUsed: ScanResult["backends"] = {};

  const pace = async (backend: ChainBackend) => {
    if (!backend.remote) return;
    const { jitterMinMs: lo, jitterMaxMs: hi } = config.scan;
    await sleep(lo + Math.floor(random() * (hi - lo + 1)));
  };

  // scriptPubKey -> origin, filled lazily as addresses are derived.
  const origins = new Map<string, Origin>();
  const coins = new Map<string, CoinRecord>();
  const observed = new Map<string, Partial<Record<ChainId, OutputObservation>>>();

  const record = (chain: ChainId, utxo: FoundUtxo, origin?: Origin) => {
    const key = `${utxo.txid}:${utxo.vout}`;
    if (!coins.has(key)) {
      coins.set(key, {
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        scriptPubKey: utxo.scriptPubKey,
        address: origin?.address,
        descriptorIndex: origin?.descriptorIndex,
        branch: origin?.branch,
        derivationIndex: origin?.derivationIndex,
        observations: {} as CoinRecord["observations"],
      });
      observed.set(key, {});
    }
    observed.get(key)![chain] = { state: "unspent", value: utxo.value, createdHeight: utxo.height };
  };

  // ---- 1. Discovery, chain by chain ----
  for (const chain of CHAIN_IDS) {
    const backend = deps.backends[chain];
    if (!backend) {
      warnings.push(`${chain.toUpperCase()}: no verified backend; coins there can't be discovered`);
      continue;
    }
    backendsUsed[chain] = { url: backend.config.url, route: backend.route.via };
    progress({ phase: "discovery", chain, done: 0, detail: "addresses checked" });
    try {
      tips[chain] = await backend.tipHeight();
      if (backend.scanDescriptors) {
        log(`${chain.toUpperCase()}: scanning the UTXO set on your node (this can take minutes)…`);
        progress({
          phase: "discovery",
          chain,
          detail: "scanning the UTXO set on your node (this can take minutes)",
        });
        const requests: { desc: string; range?: [number, number] }[] = [];
        descriptors.forEach((d, descriptorIndex) => {
          for (const branch of d.branches) {
            const last = branch.ranged ? rpcRange - 1 : 0;
            for (let i = 0; i <= last; i++) {
              const out = branch.derive(i);
              origins.set(out.scriptPubKey, {
                descriptorIndex,
                branch: branch.branch,
                derivationIndex: i,
                address: out.address,
              });
            }
            // Core rejects a range on an unranged descriptor.
            requests.push(
              branch.ranged ? { desc: branch.body, range: [0, last] } : { desc: branch.body },
            );
          }
        });
        const found = await backend.scanDescriptors(requests);
        for (const u of found) record(chain, u, origins.get(u.scriptPubKey));
        addressesRevealed[chain] = 0;
        log(`${chain.toUpperCase()}: ${found.length} unspent output(s) found locally`);
      } else if (backend.addressTxCount && backend.addressUtxos) {
        let revealed = 0;
        const gap = config.scan.gapLimit;
        for (const [descriptorIndex, d] of descriptors.entries()) {
          for (const branch of d.branches) {
            let lastUsed = -1;
            let start = 0;
            const limit = branch.ranged ? Infinity : 1;
            while (start <= lastUsed + gap && start < limit) {
              const end = Math.min(lastUsed + gap, limit - 1);
              const indexes = shuffle(
                Array.from({ length: end - start + 1 }, (_, k) => start + k),
                random,
              );
              for (const i of indexes) {
                const out = branch.derive(i);
                const origin = {
                  descriptorIndex,
                  branch: branch.branch,
                  derivationIndex: i,
                  address: out.address,
                };
                origins.set(out.scriptPubKey, origin);
                await pace(backend);
                revealed++;
                progress({
                  phase: "discovery",
                  chain,
                  done: revealed,
                  detail: "addresses checked",
                });
                const count = await backend.addressTxCount(out.address, out.scriptPubKey);
                if (count > 0) {
                  lastUsed = Math.max(lastUsed, i);
                  await pace(backend);
                  for (const u of await backend.addressUtxos(out.address, out.scriptPubKey)) {
                    record(chain, u, origin);
                  }
                }
              }
              start = end + 1;
            }
          }
        }
        addressesRevealed[chain] = revealed;
        progress.flush();
        log(`${chain.toUpperCase()}: checked ${revealed} address(es)`);
      } else {
        warnings.push(`${chain.toUpperCase()}: backend can't discover coins`);
      }
    } catch (error) {
      warnings.push(
        `${chain.toUpperCase()}: discovery stopped early: ${(error as Error).message}. ` +
          "Results for this chain may be incomplete.",
      );
    }
  }

  // ---- 2. Cross-check every discovered outpoint on every chain ----
  const tasks: { key: string; chain: ChainId }[] = [];
  for (const key of coins.keys()) {
    for (const chain of CHAIN_IDS) if (!observed.get(key)![chain]) tasks.push({ key, chain });
  }
  if (tasks.length) {
    log(`Cross-checking ${coins.size} coin(s) across chains (${tasks.length} lookups)…`);
  }
  let checked = 0;
  for (const { key, chain } of shuffle(tasks, random)) {
    progress({
      phase: "crosscheck",
      done: checked++,
      total: tasks.length,
      detail: "cross-checking coins on the other chains",
    });
    const backend = deps.backends[chain];
    const slot = observed.get(key)!;
    if (!backend) {
      slot[chain] = { state: "unknown", error: "no verified backend for this chain" };
      continue;
    }
    const coin = coins.get(key)!;
    try {
      await pace(backend);
      slot[chain] = await backend.observeOutput(coin.txid, coin.vout);
    } catch (error) {
      slot[chain] = { state: "unknown", error: (error as Error).message };
    }
  }
  if (tasks.length) {
    progress({
      phase: "crosscheck",
      done: tasks.length,
      total: tasks.length,
      detail: "cross-checking coins on the other chains",
    });
  }

  const coinList: CoinRecord[] = [...coins.entries()].map(([key, coin]) => ({
    ...coin,
    observations: observed.get(key) as CoinRecord["observations"],
  }));

  // ---- 3. Explicitly chain-specific coins ----
  // A coin unspent on one chain only, created after that chain's own history began, may have a
  // creating transaction that can't be valid anywhere else. Pre-fork coins are skipped: their
  // block is on every chain, so there's nothing to prove and nothing to fetch.
  let budget = deps.proofBudget ?? 200;
  const candidates = coinList.filter((coin) => {
    const unspent = CHAIN_IDS.filter((c) => coin.observations[c].state === "unspent");
    if (unspent.length !== 1) return false;
    const home = unspent[0];
    const obs = coin.observations[home];
    if (obs.state !== "unspent" || obs.createdHeight === undefined) return false;
    if (obs.createdHeight <= ownHistoryFrom(config.profile, home)) return false;
    return CHAIN_IDS.every((c) => c === home || coin.observations[c].state !== "spent");
  });
  if (candidates.length) {
    log(`Checking whether ${candidates.length} single-chain coin(s) can exist only there…`);
  }
  let proven = 0;
  let skipped = 0;
  for (const [n, coin] of candidates.entries()) {
    const home = CHAIN_IDS.find((c) => coin.observations[c].state === "unspent")!;
    const backend = deps.backends[home];
    if (!backend) continue;
    if (budget <= 0) {
      skipped++;
      continue;
    }
    progress({
      phase: "crosscheck",
      done: n,
      total: candidates.length,
      detail: "checking which coins exist on one chain only",
    });
    const result = await proveChainSpecific(coin.txid, home, {
      profile: config.profile,
      rawTransaction: async (id) => {
        budget--;
        await pace(backend);
        return await backend.rawTransaction(id);
      },
      ownProtected: deps.ownProtected?.[home],
    }, { depth: 4, fetches: Math.min(12, Math.max(budget, 0)) });
    if (result.ok) {
      coin.onlyOn = result.proof;
      proven++;
    }
  }
  if (candidates.length) {
    log(`${proven} of ${candidates.length} proven to exist on one chain only`);
    if (skipped) {
      warnings.push(
        `Didn't check whether ${skipped} coin(s) exist on one chain only (transaction lookup ` +
          "limit); they are judged by what each chain reports, as before.",
      );
    }
  }
  coinList.sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    profile: config.profile.id,
    tips,
    backends: backendsUsed,
    addressesRevealed,
    warnings,
    coins: coinList,
  };
}

export async function saveScan(dataDir: string, result: ScanResult): Promise<void> {
  await writeJsonAtomic(join(dataDir, SCAN_FILE), result);
}

export async function loadScan(dataDir: string): Promise<ScanResult | undefined> {
  return await readJson<ScanResult>(join(dataDir, SCAN_FILE));
}

/**
 * Compares a new scan with the previous one for things that should not happen on their own: a
 * spend that disappeared (a reorg, or a dropped transaction) or a spend replaced by another one.
 */
export function scanRegressions(prev: ScanResult | undefined, next: ScanResult): string[] {
  if (!prev) return [];
  const before = new Map(prev.coins.map((c) => [`${c.txid}:${c.vout}`, c]));
  const warnings: string[] = [];
  for (const coin of next.coins) {
    const old = before.get(`${coin.txid}:${coin.vout}`);
    if (!old) continue;
    for (const chain of CHAIN_IDS) {
      const was = old.observations[chain];
      const now = coin.observations[chain];
      const label = `${coin.txid.slice(0, 8)}:${coin.vout} on ${chain.toUpperCase()}`;
      if (was.state === "spent" && now.state === "unspent") {
        warnings.push(
          `REORG? ${label} was spent at the last scan and is unspent again. A spend can leave ` +
            "the chain in a reorg or be dropped. Do not spend the BTC copy; run `splayed track`.",
        );
      } else if (
        was.state === "spent" && now.state === "spent" && was.spendTxid && now.spendTxid &&
        was.spendTxid !== now.spendTxid
      ) {
        warnings.push(
          `${label} is now spent by ${now.spendTxid.slice(0, 16)}…, not ${
            was.spendTxid.slice(0, 16)
          }… as before (replaced or reorged).`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Coins that turn up later: shared coins in `next` that the previous scan didn't list, or listed
 * as not shared (a deposit to an old address, a pre-fork coin beyond the old gap limit, a split
 * that was reorged out). Spending their BTC copy would replay onto the forks, even if the user
 * already split everything else.
 *
 * Coins flagged by an earlier scan stay listed (with their first-seen time) while they are still
 * shared, or unverified because a chain couldn't be asked, so the warning doesn't vanish on the
 * next rescan; they drop off once the split shows on the chains. The first scan flags nothing:
 * there is nothing to compare with. Pure: uses the classification as it is.
 */
export function newSharedCoins(
  prev: ScanResult | undefined,
  next: ScanResult,
  confirmations: Record<ChainId, number>,
): NewSharedCoin[] {
  if (!prev) return [];
  const key = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`;
  const before = new Map(prev.coins.map((c) => [key(c), c]));
  const flagged = new Map((prev.newShared ?? []).map((c) => [key(c), c]));
  const out: NewSharedCoin[] = [];
  for (const coin of next.coins) {
    const now = classify(coin, { tips: next.tips, confirmations });
    const earlier = flagged.get(key(coin));
    const entry = {
      txid: coin.txid,
      vout: coin.vout,
      value: coin.value,
      ...(coin.address ? { address: coin.address } : {}),
      unspentOn: now.unspentOn,
    };
    if (earlier && (now.status === "shared" || now.status === "unverified")) {
      out.push({ ...entry, previously: earlier.previously, firstSeen: earlier.firstSeen });
      continue;
    }
    if (now.status !== "shared") continue;
    const old = before.get(key(coin));
    const was = old ? classify(old, { tips: prev.tips, confirmations }).status : "absent";
    if (was === "shared") continue;
    out.push({ ...entry, previously: was, firstSeen: next.scannedAt });
  }
  return out;
}
