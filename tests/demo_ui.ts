// Dev-only: a UI populated from in-memory chains, for screenshots. Not part of the test suite.
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { type CliIO, main } from "../src/cli/main.ts";
import { parseDescriptor } from "../src/core/descriptors.ts";
import { startUi } from "../src/ui/server.ts";
import { fakeChain, FakeEsploraTransport, fund, spendReal } from "./fakes.ts";

const seed = (w: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(w));
const S = seed(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const O = seed("legal winner thank year wave sausage worth useful legal winner thank yellow");
const fp = (k: HDKey) => k.fingerprint.toString(16).padStart(8, "0");
const SRC = `wpkh([${fp(S)}/84h/0h/0h]${S.derive("m/84'/0'/0'").publicExtendedKey}/<0;1>/*)`;
const src = parseDescriptor(SRC);
const btc = fakeChain("btc", 975_000),
  xbt = fakeChain("xbt", 970_000),
  ecx = fakeChain("ecx", 974_500);
const all = [btc, xbt, ecx];
const vals = [100_000, 250_000, 1_200_000, 40_000_000];
const ids = vals.map((v, i) =>
  fund(all, [{ ...src.branches[0].derive(i), value: v }], 900_000 + i, i + 1)
);
spendReal(xbt, ids[2], 0, 965_000, 50);
spendReal(ecx, ids[2], 0, 974_000, 51);
spendReal(ecx, ids[3], 0, 974_490, 52);
const chains = { btc, xbt, ecx } as const;
const dir = await Deno.makeTempDir();
await Deno.writeTextFile(`${dir}/splayed.toml`, "[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n");
const io: CliIO = {
  out: () => {},
  err: () => {},
  confirm: () => true,
  env: {},
  tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
  transportFactory: (_c, chain) => new FakeEsploraTransport(chains[chain]),
};
for (
  const a of [["init", "--yes"], ["import", SRC, "--label", "cold storage"], ["scan"], [
    "dest",
    "set",
    "ecx",
    `wpkh([${fp(O)}/84h/0h/0h]${O.derive("m/84'/0'/0'").publicExtendedKey}/0/*)`,
  ], [
    "dest",
    "set",
    "xbt",
    `tr([${fp(O)}/86h/0h/0h]${O.derive("m/86'/0'/0'").publicExtendedKey}/0/*)`,
  ], ["plan", "--xbt-signer", "knots", "--fee-rate", "ecx=2,xbt=3", "--yes"]]
) {
  const code = await main(["--data-dir", dir, ...a], io);
  if (code) console.error("step failed", a[0]);
}
const { out: _o, err: _e, confirm: _c, ...baseIO } = io;
const ui = startUi({
  dataDir: dir,
  run: main,
  baseIO,
  port: 8765,
  token: "demo-token-demo-token-demo-token-demo-tok",
});
console.log(ui.url);
await ui.server.finished;
