import { assertEquals, assertThrows } from "./assert.ts";
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

Deno.test("zpub is converted to xpub with identical addresses", () => {
  // SLIP-132 zpub for the BIP84 account: same key material, different version bytes.
  const d = parseDescriptor(
    "wpkh(zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs/0/*)",
  );
  assertEquals(d.branches[0].derive(0).address, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
});
