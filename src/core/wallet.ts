import { join } from "node:path";
import { type ParsedDescriptor, parseDescriptor } from "./descriptors.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export const WALLET_FILE = "watch-only.json";

export interface StoredDescriptor {
  descriptor: string;
  label?: string;
  addedAt: string;
}

export interface Destination {
  /** Ranged descriptor; fresh addresses come from branch 0 (receive). */
  descriptor: string;
  /** Next derivation index not yet handed out by a plan. */
  nextIndex: number;
}

export interface WatchOnlyWallet {
  version: 1;
  descriptors: StoredDescriptor[];
  /** Where split outputs go on each fork (ideally a new seed per fork). */
  destinations?: Partial<Record<"xbt" | "ecx", Destination>>;
}

export async function loadWallet(dataDir: string): Promise<WatchOnlyWallet> {
  return (await readJson<WatchOnlyWallet>(join(dataDir, WALLET_FILE))) ??
    { version: 1, descriptors: [] };
}

export async function saveWallet(dataDir: string, wallet: WatchOnlyWallet): Promise<void> {
  await writeJsonAtomic(join(dataDir, WALLET_FILE), wallet);
}

export function parsedDescriptors(wallet: WatchOnlyWallet): ParsedDescriptor[] {
  return wallet.descriptors.map((d) => parseDescriptor(d.descriptor));
}

export async function importDescriptor(
  dataDir: string,
  input: string,
  label?: string,
): Promise<{ parsed: ParsedDescriptor; added: boolean }> {
  const parsed = parseDescriptor(input);
  const wallet = await loadWallet(dataDir);
  if (
    wallet.descriptors.some((d) => parseDescriptor(d.descriptor).normalized === parsed.normalized)
  ) {
    return { parsed, added: false };
  }
  wallet.descriptors.push({
    descriptor: parsed.normalized,
    label,
    addedAt: new Date().toISOString(),
  });
  await saveWallet(dataDir, wallet);
  return { parsed, added: true };
}
