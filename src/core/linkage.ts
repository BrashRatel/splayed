/**
 * Which of your coins are already linked to each other on chain, for `--batch linked`: batching
 * those together reveals nothing new, while batching unlinked coins would link them.
 *
 * Two coins count as linked when:
 *
 *   - they are on the same address (address reuse); or
 *   - each was created by a transaction whose inputs ALL came from your wallet, and those
 *     transactions spent from a common address of yours, directly or through a chain of such
 *     transactions (the common-input-ownership heuristic: the inputs of one transaction are taken
 *     to have one owner, and that owner made its outputs). Coins created by one such transaction
 *     are linked to each other the same way.
 *
 * A transaction with any input from outside your wallet (a payment to you, a coinjoin, a payjoin)
 * links nothing: its inputs don't show who owns its outputs. Only one generation is read: each
 * coin's own creating transaction and the scripts its inputs spent. Whatever can't be read or
 * recognized links nothing, so the result can only be under-merged, never over-merged: a missed
 * link costs a little fee, a false one would cost privacy.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { concatBytes, toHex } from "./bytes.ts";
import { parsePushes, parseTx, type Tx, type TxInput } from "./tx.ts";

const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
const isPubkey = (b: Uint8Array) =>
  (b.length === 33 && (b[0] === 2 || b[0] === 3)) || (b.length === 65 && b[0] === 4);
const p2sh = (redeem: Uint8Array) =>
  toHex(concatBytes(Uint8Array.of(0xa9, 0x14), hash160(redeem), Uint8Array.of(0x87)));

/**
 * The scriptPubKey an input spent, when its witness or scriptSig shows it (P2WPKH, P2WSH and both
 * nested in P2SH, P2PKH, bare P2SH). Undefined when they don't: Taproot, or anything unrecognized.
 */
export function spentScript(input: TxInput): string | undefined {
  let pushes: Uint8Array[] = [];
  try {
    pushes = input.scriptSig.length ? parsePushes(input.scriptSig) : [];
  } catch {
    return undefined;
  }
  const w = input.witness;
  if (w.length) {
    let inner: string | undefined;
    if (w.length === 2 && isPubkey(w[1]) && w[0].length >= 9 && w[0].length <= 73) {
      inner = toHex(concatBytes(Uint8Array.of(0x00, 0x14), hash160(w[1])));
    } else if (w.length >= 2) {
      inner = toHex(concatBytes(Uint8Array.of(0x00, 0x20), sha256(w[w.length - 1])));
    } else {
      return undefined; // a single witness item: Taproot key path
    }
    if (!pushes.length) return inner;
    // Nested: the scriptSig is one push of the witness program.
    if (pushes.length === 1 && toHex(pushes[0]) === inner) return p2sh(pushes[0]);
    return undefined;
  }
  if (pushes.length === 2 && isPubkey(pushes[1])) {
    return toHex(
      concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash160(pushes[1]), Uint8Array.of(0x88, 0xac)),
    );
  }
  // Bare P2SH multisig: OP_0 <sigs…> <redeem script>.
  if (pushes.length >= 2 && pushes[0].length === 0) return p2sh(pushes[pushes.length - 1]);
  return undefined;
}

export interface LinkCoin {
  txid: string;
  vout: number;
  scriptPubKey: string;
  /** The creating transaction, if the caller already has it. */
  prevTx?: Tx;
}

export interface LinkDeps {
  /** Raw transaction hex (verified to hash to the txid). */
  rawTransaction(txid: string): Promise<string>;
  /** Every scriptPubKey of your wallet that could have funded these coins. */
  ours: Set<string>;
  /** Most transactions fetched (default 100). */
  fetches?: number;
  /** Shared across calls (chains share the pre-fork history): txid → transaction. */
  cache?: Map<string, Tx>;
}

export interface LinkResult {
  /** Indexes into the coins given, one array per group; every coin is in exactly one. */
  groups: number[][];
  /** Coins whose creating transaction couldn't be read or checked fully. */
  unread: number;
}

/** Groups coins by what already links them on chain (see the module comment). */
export async function linkedGroups(coins: LinkCoin[], deps: LinkDeps): Promise<LinkResult> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const cache = deps.cache ?? new Map<string, Tx>();
  let budget = deps.fetches ?? 100;
  const tx = async (id: string): Promise<Tx | undefined> => {
    const known = cache.get(id);
    if (known) return known;
    if (budget <= 0) return undefined;
    budget--;
    try {
      const t = parseTx(await deps.rawTransaction(id));
      cache.set(id, t);
      return t;
    } catch {
      return undefined;
    }
  };
  let unread = 0;
  for (const [i, coin] of coins.entries()) {
    const node = `coin:${i}`;
    union(node, `addr:${coin.scriptPubKey}`);
    const creator = coin.prevTx ?? await tx(coin.txid);
    if (!creator) {
      unread++;
      continue;
    }
    if (coin.prevTx) cache.set(coin.txid, coin.prevTx);
    const funding: string[] = [];
    let allOurs = true;
    for (const input of creator.inputs) {
      let script = spentScript(input);
      if (script === undefined) {
        const prev = await tx(input.txid);
        const out = prev?.outputs[input.vout];
        script = out ? toHex(out.script) : undefined;
        if (script === undefined) {
          unread++; // this coin's links are unknown: it stays apart unless its address links it
          allOurs = false;
          break;
        }
      }
      if (!deps.ours.has(script)) {
        allOurs = false;
        break;
      }
      funding.push(script);
    }
    // Also links coins created by one transaction to each other, through its funding addresses.
    if (allOurs && funding.length) { for (const s of funding) union(node, `addr:${s}`); }
  }
  const groups = new Map<string, number[]>();
  for (let i = 0; i < coins.length; i++) {
    const root = find(`coin:${i}`);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  }
  return { groups: [...groups.values()], unread };
}
