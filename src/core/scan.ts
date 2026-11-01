import { join } from "node:path";
import type { ChainBackend, FoundUtxo, OutputObservation } from "../backends/types.ts";
import type { Config } from "./config.ts";
import type { ParsedDescriptor } from "./descriptors.ts";
import { CHAIN_IDS, type ChainId } from "./profiles.ts";
import type { CoinRecord } from "./state.ts";
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
}

export interface ScanDeps {
  /** Verified backends; a missing chain means "no backend passed identity checks". */
  backends: Partial<Record<ChainId, ChainBackend>>;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Address range scanned per branch with node RPC (scantxoutset has no gap limit). */
  rpcRange?: number;
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
    try {
      tips[chain] = await backend.tipHeight();
      if (backend.scanDescriptors) {
        log(`${chain.toUpperCase()}: scanning the UTXO set on your node (this can take minutes)…`);
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
  for (const { key, chain } of shuffle(tasks, random)) {
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

  const coinList = [...coins.entries()].map(([key, coin]) => ({
    ...coin,
    observations: observed.get(key) as CoinRecord["observations"],
  }));
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
