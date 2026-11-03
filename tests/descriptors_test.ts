import { assert, assertEquals, assertThrows } from "./assert.ts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { descriptorChecksum, DescriptorError, parseDescriptor } from "../src/core/descriptors.ts";

// BIP44/49/84/86 test mnemonic.
const SEED = mnemonicToSeedSync(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const master = HDKey.fromMasterSeed(SEED);
const account = (path: string) => master.derive(path).publicExtendedKey;
const fp = master.fingerprint.toString(16).padStart(8, "0");

Deno.test("BIP380 checksum vector", () => {
  assertEquals(descriptorChecksum("raw(deadbeef)"), "89f8spxm");
});

Deno.test("BIP84 wpkh vectors with multipath and origin", () => {
  const d = parseDescriptor(`wpkh([${fp}/84h/0h/0h]${account("m/84'/0'/0'")}/<0;1>/*)`);
  assertEquals(d.branches.length, 2);
  assertEquals(d.branches[0].derive(0).address, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  assertEquals(d.branches[0].derive(1).address, "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
  assertEquals(d.branches[1].derive(0).address, "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
});

Deno.test("BIP86 tr vectors", () => {
  const d = parseDescriptor(`tr(${account("m/86'/0'/0'")}/<0;1>/*)`);
  assertEquals(
    d.branches[0].derive(0).address,
    "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
  );
  assertEquals(
    d.branches[0].derive(1).address,
    "bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh",
  );
  assertEquals(
    d.branches[1].derive(0).address,
    "bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7",
  );
});

Deno.test("BIP49 sh(wpkh) and BIP44 pkh vectors", () => {
  assertEquals(
    parseDescriptor(`sh(wpkh(${account("m/49'/0'/0'")}/0/*))`).branches[0].derive(0).address,
    "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf",
  );
  assertEquals(
    parseDescriptor(`pkh(${account("m/44'/0'/0'")}/0/*)`).branches[0].derive(0).address,
    "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",
  );
});

Deno.test("checksum is verified and normalized output round-trips", () => {
  const body = `wpkh(${account("m/84'/0'/0'")}/0/*)`;
  const withSum = `${body}#${descriptorChecksum(body)}`;
  assertEquals(parseDescriptor(withSum).hadChecksum, true);
  const bad = `${body}#qqqqqqqq`;
  assertThrows(() => parseDescriptor(bad), DescriptorError, "checksum mismatch");
  const reparsed = parseDescriptor(parseDescriptor(withSum).normalized);
  assertEquals(
    reparsed.branches[0].derive(0).address,
    "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  );
});

Deno.test("sortedmulti is order independent", () => {
  const a = account("m/48'/0'/0'/2'");
  const b = master.derive("m/48'/0'/1'/2'").publicExtendedKey;
  const one = parseDescriptor(`wsh(sortedmulti(1,${a}/0/*,${b}/0/*))`).branches[0].derive(3);
  const two = parseDescriptor(`wsh(sortedmulti(1,${b}/0/*,${a}/0/*))`).branches[0].derive(3);
  assertEquals(one.address, two.address);
  assertEquals(one.address.startsWith("bc1q"), true);
  assertEquals(one.address.length, 62);
});

Deno.test("private keys and hardened public derivation are refused", () => {
  const xprv = master.derive("m/84'/0'/0'").privateExtendedKey;
  assertThrows(() => parseDescriptor(`wpkh(${xprv}/0/*)`), DescriptorError, "PRIVATE");
  assertThrows(() => parseDescriptor(`wpkh(${account("m/84'/0'/0'")}/0h/*)`), DescriptorError);
  assertThrows(() => parseDescriptor(`wpkh(${account("m/84'/0'/0'")}/0/*')`), DescriptorError);
});

Deno.test("a bare 32-byte hex key is refused (it may be a private key), in tr() and elsewhere", () => {
  const hex32 = "c9".repeat(32);
  assertThrows(() => parseDescriptor(`tr(${hex32})`), DescriptorError, "PRIVATE");
  assertThrows(
    () => parseDescriptor(`tr([00000000/86h/0h/0h]${hex32})`),
    DescriptorError,
    "PRIVATE",
  );
  assertThrows(() => parseDescriptor(`wsh(multi(1,${hex32}))`), DescriptorError, "PRIVATE");
  // Other lengths keep the old message; a 33-byte compressed key still works in tr().
  assertThrows(() => parseDescriptor(`wpkh(${"ab".repeat(20)})`), DescriptorError, "33-byte");
  const pub = master.derive("m/86'/0'/0'/0/0").publicKey!;
  parseDescriptor(`tr(${Array.from(pub, (b) => b.toString(16).padStart(2, "0")).join("")})`);
});

Deno.test("timelocked and miniscript descriptors are refused with a clear reason", () => {
  const k = account("m/84'/0'/0'");
  const lock = (d: string, ...parts: string[]) => {
    const e = assertThrows(() => parseDescriptor(d), DescriptorError);
    for (const part of parts) assert(e.message.includes(part), `${d}: ${e.message}`);
  };
  lock(`wsh(and_v(v:pk(${k}/0/*),after(800000)))`, "miniscript", "timelock");
  lock(`wsh(older(144))`, "older() is a timelock", "ECX replay marker");
  lock(`wsh(after(800000))`, "after() is a timelock", "CLTV");
  lock(`wsh(v:pk(${k}/0/*))`, "v: is miniscript");
  lock(`wsh(thresh(2,pk(${k}/0/*)))`, "thresh() is miniscript");
  lock(`combo(${k}/0/*)`, "Unsupported descriptor function combo()");
});

Deno.test("global xpubs for PSBTs carry the network's own version bytes (xpub, or tpub on regtest)", () => {
  const a = account("m/48'/0'/0'/2'");
  const b = account("m/48'/0'/1'/2'");
  const d = `wsh(sortedmulti(2,${a}/0/*,${b}/0/*))`;
  const main = parseDescriptor(d, MAIN_NETWORK).xpubs;
  const reg = parseDescriptor(d, REGTEST_NETWORK).xpubs;
  const hex = (u: Uint8Array) => Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
  assertEquals(main.length, 2);
  assertEquals(reg.length, 2);
  for (let i = 0; i < 2; i++) {
    assertEquals(hex(main[i].raw.slice(0, 4)), "0488b21e");
    assertEquals(hex(reg[i].raw.slice(0, 4)), "043587cf");
    // Only the version differs: depth, fingerprint, child number, chain code and key are the same.
    assertEquals(hex(reg[i].raw.slice(4)), hex(main[i].raw.slice(4)));
    assertEquals(reg[i].raw.length, 78);
  }
});

Deno.test("zpub is converted to xpub with identical addresses", () => {
  // SLIP-132 zpub for the BIP84 account: same key material, different version bytes.
  const d = parseDescriptor(
    "wpkh(zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs/0/*)",
  );
  assertEquals(d.branches[0].derive(0).address, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
});

// ---- regtest network (test profiles only) ----

import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { MAIN_NETWORK, REGTEST_NETWORK } from "../src/core/descriptors.ts";

const b58 = createBase58check(sha256);
function withVersion(xpub: string, version: number): string {
  const raw = b58.decode(xpub);
  new DataView(raw.buffer, raw.byteOffset).setUint32(0, version);
  return b58.encode(raw);
}
const REG_XPUB = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).derive("m/84'/1'/0'")
  .publicExtendedKey;
const TPUB = withVersion(REG_XPUB, 0x043587cf);
const VPUB = withVersion(REG_XPUB, 0x045f1cf6);

Deno.test("regtest network: tpub and vpub give the same bcrt1 addresses as the xpub", () => {
  const fromX = parseDescriptor(`wpkh(${REG_XPUB}/0/*)`, REGTEST_NETWORK);
  const fromT = parseDescriptor(`wpkh(${TPUB}/0/*)`, REGTEST_NETWORK);
  const fromV = parseDescriptor(`wpkh(${VPUB}/0/*)`, REGTEST_NETWORK);
  const addr = fromT.branches[0].derive(0).address;
  assert(addr.startsWith("bcrt1q"), addr);
  assertEquals(fromX.branches[0].derive(0).address, addr);
  assertEquals(fromV.branches[0].derive(0).address, addr);
  // The stored (normalized) form uses the xpub and must parse again under the same network.
  assertEquals(parseDescriptor(fromT.normalized, REGTEST_NETWORK).normalized, fromT.normalized);
});

Deno.test("regtest network: legacy, wrapped and multisig outputs use regtest address prefixes", () => {
  const legacy = parseDescriptor(`pkh(${TPUB}/0/*)`, REGTEST_NETWORK).branches[0].derive(0);
  assert(/^[mn]/u.test(legacy.address), legacy.address);
  const wrapped = parseDescriptor(`sh(wpkh(${TPUB}/0/*))`, REGTEST_NETWORK).branches[0].derive(0);
  assert(wrapped.address.startsWith("2"), wrapped.address);
  const ms = parseDescriptor(`wsh(sortedmulti(1,${TPUB}/0/*,${VPUB}/1/*))`, REGTEST_NETWORK)
    .branches[0].derive(0);
  assert(ms.address.startsWith("bcrt1q"), ms.address);
  const tr = parseDescriptor(`tr(${TPUB}/0/*)`, REGTEST_NETWORK).branches[0].derive(0);
  assert(tr.address.startsWith("bcrt1p"), tr.address);
});

Deno.test("mainnet still refuses testnet keys, and regtest refuses mainnet-only versions", () => {
  assertThrows(() => parseDescriptor(`wpkh(${TPUB}/0/*)`), DescriptorError, "mainnet");
  assertThrows(() => parseDescriptor(`wpkh(${VPUB}/0/*)`, MAIN_NETWORK), DescriptorError);
  const ypub = withVersion(REG_XPUB, 0x049d7cb2);
  assertThrows(
    () => parseDescriptor(`wpkh(${ypub}/0/*)`, REGTEST_NETWORK),
    DescriptorError,
    "regtest",
  );
  // Mainnet behaviour is unchanged: bc1 addresses.
  assert(parseDescriptor(`wpkh(${REG_XPUB}/0/*)`).branches[0].derive(0).address.startsWith("bc1q"));
});

Deno.test("regtest network: private extended keys are still refused", () => {
  const tprv = HDKey.fromMasterSeed(new Uint8Array(32).fill(7), {
    private: 0x04358394,
    public: 0x043587cf,
  }).privateExtendedKey;
  assertThrows(
    () => parseDescriptor(`wpkh(${tprv}/0/*)`, REGTEST_NETWORK),
    DescriptorError,
    "PRIVATE",
  );
});
