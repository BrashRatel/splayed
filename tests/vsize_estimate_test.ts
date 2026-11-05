import { assert } from "./assert.ts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NETWORK, p2ms, p2pkh, p2sh, p2tr, p2wpkh, p2wsh, Transaction } from "@scure/btc-signer";
import type { OutputKind } from "../src/core/descriptors.ts";
import { estimateVsize } from "../src/core/planner.ts";
import { serializeStripped, type Tx, txid } from "../src/core/tx.ts";

// The planner prices a transaction from its estimated size, so an estimate below the real size
// would pay less than the fee rate asked for, and one far above would overpay. Each case signs a
// one-input, one-output spend the way an ordinary wallet does and compares its real vsize with
// `estimateVsize`. Native node tests (tests/integration) then check the same against mined blocks.

const master = HDKey.fromMasterSeed(mnemonicToSeedSync(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
));
const key = (i: number) => master.derive(`m/84'/0'/0'/0/${i}`);
const DEST = p2wpkh(key(99).publicKey!, NETWORK).script; // 22-byte output script

interface Shape {
  kind: OutputKind;
  m?: number;
  n?: number;
}

/** Real vsize of a signed one-input spend of the given shape. */
function signedVsize({ kind, m = 1, n = 1 }: Shape): number {
  const privs = Array.from({ length: n }, (_, i) => key(i).privateKey!);
  const pubs = Array.from({ length: n }, (_, i) => key(i).publicKey!);
  let out: { script: Uint8Array; redeemScript?: Uint8Array; witnessScript?: Uint8Array };
  let legacy = false;
  switch (kind) {
    case "pkh":
      out = p2pkh(pubs[0], NETWORK);
      legacy = true;
      break;
    case "wpkh":
      out = p2wpkh(pubs[0], NETWORK);
      break;
    case "sh-wpkh":
      out = p2sh(p2wpkh(pubs[0], NETWORK), NETWORK);
      break;
    case "tr":
      out = p2tr(pubs[0].slice(1), undefined, NETWORK);
      break;
    case "wsh-ms":
      out = p2wsh(p2ms(m, pubs), NETWORK);
      break;
    case "sh-wsh-ms":
      out = p2sh(p2wsh(p2ms(m, pubs), NETWORK), NETWORK);
      break;
    case "sh-ms":
      out = p2sh(p2ms(m, pubs), NETWORK);
      legacy = true;
      break;
    default:
      throw new Error(kind);
  }
  const value = 150_000n;
  const prev: Tx = {
    version: 2,
    inputs: [{
      txid: "77".repeat(32),
      vout: 0,
      scriptSig: new Uint8Array(),
      sequence: 0xffffffff,
      witness: [],
    }],
    outputs: [{ value, script: out.script }],
    lockTime: 0,
  };
  const tx = new Transaction();
  tx.addInput({
    txid: txid(prev),
    index: 0,
    sequence: 0xfffffffd,
    ...(legacy
      ? { nonWitnessUtxo: serializeStripped(prev) }
      : { witnessUtxo: { script: out.script, amount: value } }),
    ...(out.redeemScript ? { redeemScript: out.redeemScript } : {}),
    ...(out.witnessScript ? { witnessScript: out.witnessScript } : {}),
    ...(kind === "tr" ? { tapInternalKey: pubs[0].slice(1) } : {}),
  });
  tx.addOutput({ script: DEST, amount: 149_000n });
  // Any m of the n keys satisfy the script; sign with the last m, like a quorum that isn't the first.
  const signers = kind.endsWith("-ms") ? privs.slice(n - m) : [privs[0]];
  for (const p of signers) tx.signIdx(p, 0);
  tx.finalize();
  return tx.vsize;
}

const SHAPES: Shape[] = [
  { kind: "pkh" },
  { kind: "wpkh" },
  { kind: "sh-wpkh" },
  { kind: "tr" },
  ...(["wsh-ms", "sh-wsh-ms", "sh-ms"] as const).flatMap((kind) =>
    [[1, 2], [2, 2], [2, 3], [3, 5], [5, 7], [7, 10], [11, 15]].map(([m, n]) => ({ kind, m, n }))
  ),
];

for (const shape of SHAPES) {
  const name = shape.m ? `${shape.kind} ${shape.m}-of-${shape.n}` : shape.kind;
  Deno.test(`vsize estimate: ${name} never undershoots the signed transaction`, () => {
    const actual = signedVsize(shape);
    const estimate = estimateVsize(
      [{ kind: shape.kind, multisig: shape.m ? { m: shape.m, n: shape.n! } : undefined }],
      DEST.length,
      false,
    );
    console.log(
      `  ${name.padEnd(20)} actual ${actual}  estimate ${estimate}  over ${estimate - actual}`,
    );
    assert(estimate >= actual, `${name}: estimated ${estimate} vbytes, signed tx is ${actual}`);
    // "Deliberately a little high": at most one extra byte of signature per signature, plus slack.
    const sigs = shape.m ?? 1;
    assert(
      estimate - actual <= 3 * sigs + 4,
      `${name}: estimated ${estimate} vbytes is far above the signed ${actual}`,
    );
  });
}
