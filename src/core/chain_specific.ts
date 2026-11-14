/**
 * Explicitly chain-specific coins: proving a coin can exist on ONE chain only, from how its
 * creating transaction was made, instead of only "the other chains don't have it right now".
 *
 * "Absent elsewhere" says nothing about the future: if the creating transaction T could be valid on
 * another chain, anyone holding it can broadcast it there and the coin becomes shared. T cannot be
 * valid on chain C if any of these holds:
 *
 *   - T is a coinbase of its chain at a height above the last block that chain shares with C;
 *   - (XBT) one of T's signatures carries the SIGHASH_UNIFIED bit, so it fails on chains without it;
 *   - (ECX) T has the replay marker: nLockTime 499,999,998 with a non-final input, a height lock no
 *     other chain will reach;
 *   - T is a transaction this tool itself verified and sent on that chain with protection;
 *   - one of T's inputs was created by a transaction that cannot be valid on C (the proof carries
 *     down a chain of spends: an input that doesn't exist on C makes T invalid there).
 *
 * The search is bounded per coin (depth and transactions fetched); running out is "not proven",
 * which leaves the coin's status exactly as the observations alone give it.
 */
import { carriesUnifiedSignature, isCoinbaseTx } from "./origin.ts";
import { CHAIN_IDS, type ChainId, type NetworkProfile } from "./profiles.ts";
import { parsePushes, parseTx, type Tx } from "./tx.ts";

/** How a coin was shown to exist on one chain only. */
export interface ChainSpecific {
  chain: ChainId;
  kind: "coinbase" | "replay-protected" | "own-transaction" | "inherited";
  /** For people: "a SIGHASH_UNIFIED (0x21) signature in its creating transaction". */
  via: string;
}

/** Height of the last block chains `a` and `b` have in common. */
export function sharedHeight(profile: NetworkProfile, a: ChainId, b: ChainId): number {
  if (a === b) return Infinity;
  return Math.min(
    profile.chains[a].lastSharedHeight ?? Infinity,
    profile.chains[b].lastSharedHeight ?? Infinity,
  );
}

/**
 * The lowest height above which a block of `chain` is shared with no other chain. A coin created
 * at or below it was created in a block some other chain also has, so it can't be chain-specific.
 */
export function ownHistoryFrom(profile: NetworkProfile, chain: ChainId): number {
  return Math.max(
    ...CHAIN_IDS.filter((c) => c !== chain).map((c) => sharedHeight(profile, chain, c)),
  );
}

/** BIP34: the block height a coinbase commits to in its first push, or undefined. */
export function coinbaseHeight(tx: Tx): number | undefined {
  const script = tx.inputs[0]?.scriptSig;
  if (!script?.length) return undefined;
  const op = script[0];
  if (op === 0x00) return 0;
  if (op >= 0x51 && op <= 0x60) return op - 0x50; // OP_1..OP_16 (regtest's first blocks)
  if (op < 1 || op > 8) return undefined;
  let pushes: Uint8Array[];
  try {
    pushes = parsePushes(script.subarray(0, 1 + op));
  } catch {
    return undefined;
  }
  const n = pushes[0];
  if (!n?.length || n[n.length - 1] & 0x80) return undefined; // negative: not a height
  let height = 0;
  for (let i = n.length - 1; i >= 0; i--) height = height * 256 + n[i];
  return height;
}

/** Whether `tx` carries the ECX-style locktime replay marker of `chain`, if it has one. */
function hasLocktimeMarker(profile: NetworkProfile, chain: ChainId, tx: Tx): boolean {
  const rp = profile.chains[chain].replayProtection;
  return rp.kind === "locktime-marker" && tx.lockTime === rp.lockTime &&
    tx.inputs.some((i) => i.sequence < 0xffff_ffff);
}

export interface ChainSpecificDeps {
  profile: NetworkProfile;
  /** Raw transaction hex from the coin's own chain. */
  rawTransaction(txid: string): Promise<string>;
  /** Transactions this tool verified and sent with protection on that chain. */
  ownProtected?: Set<string>;
}

export type ChainSpecificProof = { ok: true; proof: ChainSpecific } | {
  ok: false;
  reason: string;
};

/**
 * Tries to prove that `txid`, confirmed on `chain`, can't be valid on any other chain, so its
 * outputs exist on `chain` only.
 */
export async function proveChainSpecific(
  txid: string,
  chain: ChainId,
  deps: ChainSpecificDeps,
  limits = { depth: 4, fetches: 12 },
): Promise<ChainSpecificProof> {
  const others = CHAIN_IDS.filter((c) => c !== chain);
  const label = chain.toUpperCase();
  let fetches = 0;
  let exhausted = false;
  let readFailed = false;
  /** Per transaction: which other chains it can't be valid on, and why (first reason found). */
  const memo = new Map<
    string,
    { excluded: Set<ChainId>; kind: ChainSpecific["kind"]; via: string }
  >();

  const visit = async (id: string, depth: number) => {
    const known = memo.get(id);
    if (known) return known;
    const result = {
      excluded: new Set<ChainId>(),
      kind: "inherited" as ChainSpecific["kind"],
      via: "",
    };
    memo.set(id, result); // a cycle can't happen on chain; this also stops repeats
    const all = (kind: ChainSpecific["kind"], via: string) => {
      for (const c of others) result.excluded.add(c);
      result.kind = kind;
      result.via = via;
      return result;
    };
    if (deps.ownProtected?.has(id)) {
      return all(
        "own-transaction",
        `a protected transaction this tool verified and sent on ${label}`,
      );
    }
    if (fetches >= limits.fetches) {
      exhausted = true;
      return result;
    }
    fetches++;
    let tx: Tx;
    try {
      tx = parseTx(await deps.rawTransaction(id));
    } catch {
      readFailed = true;
      return result;
    }
    if (isCoinbaseTx(tx)) {
      const h = coinbaseHeight(tx);
      if (h !== undefined) {
        for (const c of others) {
          if (h > sharedHeight(deps.profile, chain, c)) result.excluded.add(c);
        }
        result.kind = "coinbase";
        result.via = `a ${label} coinbase at height ${h}, after the forks`;
      }
      return result;
    }
    const rp = deps.profile.chains[chain].replayProtection;
    if (rp.kind === "unified-sighash" && carriesUnifiedSignature(tx)) {
      return all("replay-protected", "a SIGHASH_UNIFIED (0x21) signature, which fails elsewhere");
    }
    if (hasLocktimeMarker(deps.profile, chain, tx)) {
      return all(
        "replay-protected",
        `the ${label} replay marker (nLockTime ${tx.lockTime} with a non-final input)`,
      );
    }
    if (depth <= 0) {
      exhausted = true;
      return result;
    }
    for (const input of tx.inputs) {
      const parent = await visit(input.txid, depth - 1);
      let added = false;
      for (const c of parent.excluded) {
        if (!result.excluded.has(c)) {
          result.excluded.add(c);
          added = true;
        }
      }
      if (added && !result.via) {
        result.via = `${parent.via}, reached through an input of ${id.slice(0, 8)}…`;
      }
      if (others.every((c) => result.excluded.has(c))) break;
    }
    if (others.every((c) => result.excluded.has(c)) && result.via) {
      // Several inputs can share the work (one rules out BTC, another ECX): say so.
      const parents = tx.inputs.map((i) => memo.get(i.txid)).filter((p) => p?.excluded.size);
      if (parents.length > 1 && !parents.some((p) => others.every((c) => p!.excluded.has(c)))) {
        result.via = `inputs of ${id.slice(0, 8)}… that exist on ${label} only between them`;
      }
    }
    return result;
  };

  const top = await visit(txid, limits.depth);
  if (others.every((c) => top.excluded.has(c))) {
    return { ok: true, proof: { chain, kind: top.kind, via: top.via } };
  }
  return {
    ok: false,
    reason: readFailed
      ? `couldn't read a transaction it descends from on ${label}`
      : exhausted
      ? "nothing found within the search limit that ties it to one chain"
      : "its creating transaction could also be valid on another chain",
  };
}
