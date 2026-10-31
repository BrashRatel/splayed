import { assert, assertEquals, assertThrows } from "./assert.ts";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NETWORK, p2ms, p2pkh, p2sh, p2tr, p2wpkh, p2wsh, Transaction } from "@scure/btc-signer";
import { compactSize, concatBytes, fromHex, i64le, toHex, u32le, utf8 } from "../src/core/bytes.ts";
import type { OutputKind } from "../src/core/descriptors.ts";
import {
  decodePsbt,
  encodePsbt,
  IN_BIP32_DERIVATION,
  IN_NON_WITNESS_UTXO,
  IN_REDEEM_SCRIPT,
  IN_SIGHASH_TYPE,
  IN_WITNESS_SCRIPT,
  IN_WITNESS_UTXO,
  type KeyValue,
  kv,
  type Psbt,
} from "../src/core/psbt.ts";
import {
  extractSignatures,
  finalize,
  inputContexts,
  SigCheckError,
  verifyInputs,
} from "../src/core/sigcheck.ts";
import { parseTx, serializeStripped, serializeTx, type Tx, txid } from "../src/core/tx.ts";
import { unifiedSignatureHash } from "../src/core/unified_sighash.ts";

const master = HDKey.fromMasterSeed(mnemonicToSeedSync(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
));
const key = (i: number) => master.derive(`m/84'/0'/0'/0/${i}`);
const DEST = p2wpkh(key(9).publicKey!, NETWORK).script;

interface Fixture {
  own: Psbt;
  kinds: OutputKind[];
  privs: Uint8Array[];
  spent: { value: bigint; script: Uint8Array };
}

/** Builds the tool-side ("own") PSBT for one input of the given kind. */
function fixture(kind: OutputKind, lockTime: number, unified: boolean): Fixture {
  const k = [key(0), key(1), key(2)];
  const pubs = k.map((x) => x.publicKey!);
  let out: { script: Uint8Array; redeemScript?: Uint8Array; witnessScript?: Uint8Array };
  let privs = [k[0].privateKey!];
  switch (kind) {
    case "wpkh":
      out = p2wpkh(pubs[0], NETWORK);
      break;
    case "pkh":
      out = p2pkh(pubs[0], NETWORK);
      break;
    case "sh-wpkh":
      out = p2sh(p2wpkh(pubs[0], NETWORK), NETWORK);
      break;
    case "tr":
      out = p2tr(pubs[0].slice(1), undefined, NETWORK);
      break;
    case "wsh-ms":
      out = p2wsh(p2ms(2, pubs), NETWORK);
      privs = [k[0].privateKey!, k[2].privateKey!];
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
  const tx: Tx = {
    version: 2,
    inputs: [{
      txid: txid(prev),
      vout: 0,
      scriptSig: new Uint8Array(),
      sequence: 0xfffffffd,
      witness: [],
    }],
    outputs: [{ value: 149_000n, script: DEST }],
    lockTime,
  };
  const map: KeyValue[] = [
    kv(IN_NON_WITNESS_UTXO, new Uint8Array(), serializeStripped(prev)),
  ];
  if (kind !== "pkh") {
    map.push(
      kv(
        IN_WITNESS_UTXO,
        new Uint8Array(),
        concatBytes(i64le(value), compactSize(out.script.length), out.script),
      ),
    );
  }
  if (out.redeemScript) map.push(kv(IN_REDEEM_SCRIPT, new Uint8Array(), out.redeemScript));
  if (out.witnessScript) map.push(kv(IN_WITNESS_SCRIPT, new Uint8Array(), out.witnessScript));
  if (kind !== "tr") {
    for (const p of kind === "wsh-ms" ? pubs : [pubs[0]]) {
      map.push(kv(IN_BIP32_DERIVATION, p, concatBytes(fromHex("73c5da0a"), u32le(0))));
    }
  }
  if (kind === "tr") {
    map.push(kv(0x17, new Uint8Array(), pubs[0].slice(1)));
    map.push(
      kv(0x16, pubs[0].slice(1), concatBytes(Uint8Array.of(0), fromHex("73c5da0a"), u32le(0))),
    );
  }
  if (unified) map.push(kv(IN_SIGHASH_TYPE, new Uint8Array(), u32le(0x21)));
  return {
    own: { tx, global: [], inputs: [map], outputs: [[]] },
    kinds: [kind],
    privs,
    spent: { value, script: out.script },
  };
}

/** Sign like an ordinary wallet (SIGHASH_ALL / DEFAULT) with @scure/btc-signer. */
function stockSign(f: Fixture, finalizeIt: boolean): { psbt: Psbt; raw?: Uint8Array } {
  const tx = Transaction.fromPSBT(encodePsbt(f.own));
  for (const p of f.privs) tx.signIdx(p, 0);
  if (finalizeIt) {
    tx.finalize();
    return { psbt: decodePsbt(tx.toPSBT()), raw: tx.extract() };
  }
  return { psbt: decodePsbt(tx.toPSBT()) };
}

function tweakedPriv(priv: Uint8Array): Uint8Array {
  const n = secp256k1.Point.Fn.ORDER;
  const P = secp256k1.Point.BASE.multiply(BigInt("0x" + toHex(priv)));
  let d = BigInt("0x" + toHex(priv));
  if (P.y % 2n === 1n) d = n - d;
  const x = fromHex(P.x.toString(16).padStart(64, "0"));
  const tag = sha256(utf8("TapTweak"));
  const t = BigInt("0x" + toHex(sha256(concatBytes(tag, tag, x))));
  return fromHex(((d + t) % n).toString(16).padStart(64, "0"));
}

/** A 0x21 signer, like the Knots wallet would be, for one-input fixtures. */
function unifiedSign(f: Fixture, hashType = 0x21): Psbt {
  const tx = f.own.tx;
  const kind = f.kinds[0];
  const scriptType = kind === "tr" ? 2 : kind === "pkh" ? 0 : 1;
  const pub = key(0).publicKey!;
  const scriptCode = kind === "pkh" ? f.spent.script : kind === "tr" ? undefined : concatBytes(
    Uint8Array.of(0x76, 0xa9, 0x14),
    p2wpkh(pub, NETWORK).script.slice(2),
    Uint8Array.of(0x88, 0xac),
  );
  const digest = unifiedSignatureHash(
    {
      version: tx.version,
      lockTime: tx.lockTime,
      inputs: tx.inputs.map((i) => ({
        txid: fromHex(i.txid),
        index: i.vout,
        sequence: i.sequence,
      })),
      outputs: tx.outputs.map((o) => ({ amount: o.value, script: o.script })),
    },
    0,
    hashType,
    [{ amount: f.spent.value, script: f.spent.script }],
    { scriptType: scriptType as 0 | 1 | 2, scriptCode },
  )!;
  const signed: Psbt = { ...f.own, inputs: [[...f.own.inputs[0]]] };
  if (kind === "tr") {
    const sig = schnorr.sign(digest, tweakedPriv(f.privs[0]));
    signed.inputs[0].push(kv(0x13, new Uint8Array(), concatBytes(sig, Uint8Array.of(hashType))));
  } else {
    const der = secp256k1.sign(digest, f.privs[0], { prehash: false, format: "der", lowS: true });
    signed.inputs[0].push(kv(0x02, pub, concatBytes(der, Uint8Array.of(hashType))));
  }
  return signed;
}

for (const kind of ["wpkh", "pkh", "sh-wpkh", "tr", "wsh-ms"] as OutputKind[]) {
  Deno.test(`standard (ECX) ${kind}: stock signatures verify; finalize matches the signer's own`, () => {
    const f = fixture(kind, 499_999_998, false);
    const ctxs = inputContexts(f.own, f.kinds);
    // Partial signatures (unfinalized PSBT).
    const partial = stockSign(f, false);
    const v1 = verifyInputs(
      f.own.tx,
      ctxs,
      extractSignatures(ctxs, { psbt: partial.psbt }),
      "standard",
    );
    const final1 = finalize(f.own.tx, ctxs, v1);
    // Finalized PSBT and raw transaction give the same result, byte for byte.
    const done = stockSign(f, true);
    const v2 = verifyInputs(
      f.own.tx,
      ctxs,
      extractSignatures(ctxs, { psbt: done.psbt }),
      "standard",
    );
    const fromRaw = parseTx(done.raw!);
    const v3 = verifyInputs(f.own.tx, ctxs, extractSignatures(ctxs, { tx: fromRaw }), "standard");
    assertEquals(toHex(serializeTx(finalize(f.own.tx, ctxs, v2))), toHex(done.raw!));
    assertEquals(toHex(serializeTx(finalize(f.own.tx, ctxs, v3))), toHex(done.raw!));
    // ECDSA is deterministic (RFC 6979), so separate signing sessions match byte for byte.
    if (kind !== "wsh-ms" && kind !== "tr") {
      assertEquals(toHex(serializeTx(final1)), toHex(done.raw!));
    }
    assertEquals(final1.lockTime, 499_999_998);
  });
}

for (const kind of ["wpkh", "pkh", "tr"] as OutputKind[]) {
  Deno.test(`unified (XBT) ${kind}: 0x21 signatures verify; stock ones are refused`, () => {
    const f = fixture(kind, 0, true);
    const ctxs = inputContexts(f.own, f.kinds);
    const signed = unifiedSign(f);
    const v = verifyInputs(f.own.tx, ctxs, extractSignatures(ctxs, { psbt: signed }), "unified");
    assertEquals(v[0].hashTypes, [0x21]);
    const final = finalize(f.own.tx, ctxs, v);
    const lastByte = kind === "pkh" ? final.inputs[0].scriptSig : final.inputs[0].witness[0];
    assert(serializeTx(final).length > 0 && lastByte.length > 0);
    // A stock SIGHASH_ALL signature must never pass as an XBT signature.
    const stock = fixture(kind, 0, false);
    const sctx = inputContexts(stock.own, stock.kinds);
    assertThrows(
      () =>
        verifyInputs(
          stock.own.tx,
          sctx,
          extractSignatures(sctx, { psbt: stockSign(stock, false).psbt }),
          "unified",
        ),
      SigCheckError,
    );
    // A 0x21 signature isn't an ECX signature either.
    assertThrows(
      () => verifyInputs(f.own.tx, ctxs, extractSignatures(ctxs, { psbt: signed }), "standard"),
      SigCheckError,
      "only SIGHASH_ALL",
    );
  });
}

Deno.test("unified: ANYONECANPAY variant (0xa1) is refused", () => {
  const f = fixture("wpkh", 0, true);
  const ctxs = inputContexts(f.own, f.kinds);
  assertThrows(
    () =>
      verifyInputs(
        f.own.tx,
        ctxs,
        extractSignatures(ctxs, { psbt: unifiedSign(f, 0xa1) }),
        "unified",
      ),
    SigCheckError,
    "not 0x21",
  );
});

Deno.test("a signature over a different transaction does not verify", () => {
  const f = fixture("wpkh", 499_999_998, false);
  const ctxs = inputContexts(f.own, f.kinds);
  const sigs = extractSignatures(ctxs, { psbt: stockSign(f, false).psbt });
  const changed: Tx = { ...f.own.tx, outputs: [{ value: 100_000n, script: DEST }] };
  assertThrows(
    () => verifyInputs(changed, ctxs, sigs, "standard"),
    SigCheckError,
    "does not verify",
  );
});
