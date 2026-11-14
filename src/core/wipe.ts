/**
 * "Wipe all": forget everything splayed has recorded about the user's coins, and start over.
 *
 * Removed: imported and donor descriptors, fork destinations, scan results, every plan folder
 * (unsigned and signed PSBTs, progress, uploads), the web UI's donor opt-in and the network
 * confirmation, so `init` has to be run again. Kept: the network settings in splayed.toml, including servers the user added,
 * and the UI access token. Nothing on any blockchain changes, and no keys are involved.
 */
import { join } from "node:path";
import { type Config, GATE_FILE } from "./config.ts";
import { DONOR_OPT_IN_FILE, DONOR_SCAN_FILE } from "./donors.ts";
import { unsettledTransactions } from "./plan_admin.ts";
import { type Plan, PLANS_DIR } from "./planner.ts";
import { SCAN_FILE } from "./scan.ts";
import { readJson } from "./store.ts";
import { loadWallet, WALLET_FILE } from "./wallet.ts";

export interface WipePreview {
  descriptors: number;
  donors: number;
  destinations: number;
  scan: boolean;
  donorScan: boolean;
  /** Plan folders, archived ones included. */
  plans: number;
  /** Sent transactions that are not confirmed yet: wiping stops `track` following them. */
  unsettled: string[];
  /** True when the network confirmation exists. */
  confirmation: boolean;
}

const exists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

async function planFolders(dataDir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(join(dataDir, PLANS_DIR))) {
      if (e.isDirectory) out.push(e.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out.sort();
}

export async function previewWipe(config: Config): Promise<WipePreview> {
  const dir = config.dataDir;
  const wallet = await loadWallet(dir);
  const ids = await planFolders(dir);
  const unsettled: string[] = [];
  for (const id of ids) {
    const planDir = join(dir, PLANS_DIR, id);
    const plan = await readJson<Plan>(join(planDir, "plan.json")).catch(() => undefined);
    if (!plan?.transactions) continue;
    for (const line of await unsettledTransactions(config, planDir, plan).catch(() => [])) {
      unsettled.push(`plan ${id}: ${line}`);
    }
  }
  return {
    descriptors: wallet.descriptors.length,
    donors: wallet.donors?.length ?? 0,
    destinations: Object.keys(wallet.destinations ?? {}).length,
    scan: await exists(join(dir, SCAN_FILE)),
    donorScan: await exists(join(dir, DONOR_SCAN_FILE)),
    plans: ids.length,
    unsettled,
    confirmation: await exists(join(dir, GATE_FILE)),
  };
}

/** True when there is nothing for `wipe` to remove. */
export function nothingToWipe(p: WipePreview): boolean {
  return !p.descriptors && !p.donors && !p.destinations && !p.scan && !p.donorScan && !p.plans &&
    !p.confirmation;
}

export async function wipeAll(dataDir: string): Promise<void> {
  for (const file of [WALLET_FILE, SCAN_FILE, DONOR_SCAN_FILE, DONOR_OPT_IN_FILE, GATE_FILE]) {
    await Deno.remove(join(dataDir, file)).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
  await Deno.remove(join(dataDir, PLANS_DIR), { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}
