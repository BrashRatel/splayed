/**
 * Proving where a donor came from when this tool did not make its funding transaction.
 *
 * A donor is safe only if nobody can put its funding transaction F on another chain. F cannot be
 * valid there if ANY of these holds:
 *
 *   - F is a coinbase of the home chain (a block that exists on that chain only);
 *   - (XBT) one of F's signatures carries the SIGHASH_UNIFIED bit 0x20, which changes the digest so
 *     the signature fails on BTC and ECX (F is confirmed on XBT, so the signature verified there);
 *   - one of F's inputs was created by a transaction that itself cannot be valid elsewhere (this
 *     rule is what carries the proof back along a chain of donor spends, and is the only one a BTC
 *     donor has, since BTC has no replay protection of its own).
 *
 * The search is bounded (depth and number of transactions fetched); running out is "unproven".
 */
import { SIGHASH_UNIFIED } from "./profiles.ts";
import { parsePushes, parseTx, type Tx } from "./tx.ts";

const NULL_TXID = "0".repeat(64);

export function isCoinbaseTx(tx: Tx): boolean {
  return tx.inputs.length === 1 && tx.inputs[0].txid === NULL_TXID &&
    tx.inputs[0].vout === 0xffff_ffff;
}

/** A DER ECDSA signature with its sighash byte: 0x30 len 0x02 …, total length len + 3. */
function looksLikeDerSignature(item: Uint8Array): boolean {
  return item.length >= 9 && item.length <= 73 && item[0] === 0x30 && item[1] === item.length - 3 &&
    item[2] === 0x02;
}

/** True when some signature in the (confirmed) transaction has the SIGHASH_UNIFIED bit set. */
export function carriesUnifiedSignature(tx: Tx): boolean {
  for (const input of tx.inputs) {
    let pushes: Uint8Array[] = [];
    try {
      pushes = input.scriptSig.length ? parsePushes(input.scriptSig) : [];
    } catch { /* not a push-only script: no signatures to read there */ }
    for (const item of [...input.witness, ...pushes]) {
      if (looksLikeDerSignature(item) && (item[item.length - 1] & SIGHASH_UNIFIED) !== 0) {
        return true;
      }
    }
    // Taproot key-path: a lone 65-byte witness item is a Schnorr signature plus a sighash byte.
    if (input.witness.length === 1 && input.witness[0].length === 65) {
      if ((input.witness[0][64] & SIGHASH_UNIFIED) !== 0) return true;
    }
  }
  return false;
}

export interface OriginDeps {
  /** Which chain the donor lives on. 0x21 signatures count only for XBT. */
  home: "xbt" | "btc";
  /** Raw transaction hex from the home chain's backend. */
  rawTransaction(txid: string): Promise<string>;
  /** True only when EVERY other chain positively says this output is absent (not "unknown"). */
  absentElsewhere(txid: string, vout: number): Promise<boolean>;
  /** Transactions this tool itself verified and sent on the home chain. */
  ownProtected: Set<string>;
}

export type OriginProof = { ok: true; via: string } | { ok: false; reason: string };

export async function proveFunding(
  txid: string,
  deps: OriginDeps,
  limits = { depth: 6, fetches: 40 },
): Promise<OriginProof> {
  let fetches = 0;
  let exhausted = false;
  const seen = new Set<string>();

  const prove = async (id: string, depth: number): Promise<string | undefined> => {
    if (deps.ownProtected.has(id)) return "a transaction this tool verified and sent";
    if (seen.has(id)) return undefined;
    seen.add(id);
    if (fetches >= limits.fetches) {
      exhausted = true;
      return undefined;
    }
    fetches++;
    let tx: Tx;
    try {
      tx = parseTx(await deps.rawTransaction(id));
    } catch {
      return undefined;
    }
    if (isCoinbaseTx(tx)) {
      // A coinbase from before the forks exists on every chain: it must be absent elsewhere.
      return (await deps.absentElsewhere(id, 0))
        ? `a ${deps.home.toUpperCase()} coinbase`
        : undefined;
    }
    if (deps.home === "xbt" && carriesUnifiedSignature(tx)) {
      return "a SIGHASH_UNIFIED (0x21) signature, which fails on BTC and ECX";
    }
    if (depth <= 0) {
      exhausted = true;
      return undefined;
    }
    for (const input of tx.inputs) {
      const via = await prove(input.txid, depth - 1);
      if (via) return `${via}, reached through an input of ${id.slice(0, 8)}…`;
    }
    return undefined;
  };

  const via = await prove(txid, limits.depth);
  if (via) return { ok: true, via };
  return {
    ok: false,
    reason: exhausted
      ? "couldn't trace its funding back to a coinbase or a 0x21 signature within the search limit"
      : "its funding transaction has no 0x21 signature and no input that leads to a " +
        `${deps.home.toUpperCase()} coinbase`,
  };
}
