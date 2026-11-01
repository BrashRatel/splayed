import { assert, assertEquals, assertRejects } from "./assert.ts";
import { join } from "node:path";
import {
  ConfigError,
  configFingerprint,
  loadConfig,
  networkConfirmed,
  writeConfigFile,
  writeGate,
} from "../src/core/config.ts";
import { EsploraBackend } from "../src/backends/esplora.ts";
import { btcToSats } from "../src/backends/rpc.ts";
import { verifyIdentity } from "../src/core/identity.ts";
import { MAINNET } from "../src/core/profiles.ts";
import { classify, type CoinRecord } from "../src/core/state.ts";
import { addOutput, fakeChain, FakeEsploraTransport, txid } from "./fakes.ts";

const tmp = () => Deno.makeTempDir({ prefix: "splayed-test-" });

Deno.test("defaults: primary onion/Tor endpoints only, fallbacks not enabled", async () => {
  const config = await loadConfig({ dataDir: await tmp(), env: {} });
  assertEquals(config.chains.btc.backends.map((b) => b.url), [
    "http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api",
  ]);
  assertEquals(config.chains.xbt.backends.length, 1);
  assertEquals(config.chains.ecx.backends[0].url, "https://explorer.ecash.com/api");
  assert(config.chains.ecx.backends.every((b) => b.proxy.kind === "tor"));
  assertEquals(config.torSocks, { host: "127.0.0.1", port: 9050 });
  assertEquals(config.chains.ecx.confirmations, 50);
});

Deno.test("precedence: flag > env > file", async () => {
  const dir = await tmp();
  await writeConfigFile(dir, { tor: { socks: "127.0.0.1:9150" } });
  assertEquals((await loadConfig({ dataDir: dir, env: {} })).torSocks.port, 9150);
  assertEquals(
    (await loadConfig({ dataDir: dir, env: { SPLAYED_TOR_SOCKS: "127.0.0.1:9250" } })).torSocks
      .port,
    9250,
  );
  assertEquals(
    (await loadConfig({
      dataDir: dir,
      env: { SPLAYED_TOR_SOCKS: "127.0.0.1:9250" },
      torSocks: "127.0.0.1:9350",
    })).torSocks.port,
    9350,
  );
});

Deno.test("config refuses stored passwords, sub-minimum confirmations and silent clearnet", async () => {
  const dir = await tmp();
  await writeConfigFile(dir, {
    chains: { btc: { backends: [{ kind: "rpc", url: "http://127.0.0.1:8332", password: "x" }] } },
  });
  await assertRejects(() => loadConfig({ dataDir: dir, env: {} }), ConfigError, "password");
  await writeConfigFile(dir, { chains: { ecx: { confirmations: 3 } } });
  await assertRejects(() => loadConfig({ dataDir: dir, env: {} }), ConfigError, "between 20");
  await writeConfigFile(dir, {
    chains: {
      ecx: {
        backends: [{ kind: "esplora", url: "https://explorer.ecash.com/api", proxy: "none" }],
      },
    },
  });
  await assertRejects(() => loadConfig({ dataDir: dir, env: {} }), ConfigError, "clearnet");
});

Deno.test("confirmation gate closes when privacy-relevant settings change", async () => {
  const dir = await tmp();
  const before = await loadConfig({ dataDir: dir, env: {} });
  assertEquals(await networkConfirmed(before), false);
  await writeGate(before, {});
  assertEquals(await networkConfirmed(before), true);
  await writeConfigFile(dir, {
    chains: {
      btc: { backends: [{ kind: "rpc", url: "http://127.0.0.1:8332", cookie_file: "/x" }] },
    },
  });
  const after = await loadConfig({ dataDir: dir, env: {} });
  assert(configFingerprint(before) !== configFingerprint(after));
  assertEquals(await networkConfirmed(after), false);
  // Tor address changes re-gate too.
  const viaFlag = await loadConfig({ dataDir: dir, env: {}, torSocks: "127.0.0.1:9150" });
  assert(configFingerprint(viaFlag) !== configFingerprint(after));
});

Deno.test("identity: right chain passes; a BTC explorer posing as XBT fails; lagging fails", async () => {
  const xbt = fakeChain("xbt");
  const btcConfig = {
    kind: "esplora" as const,
    url: "http://x/api",
    proxy: { kind: "tor" as const },
    role: "both" as const,
    priority: 0,
    origin: "user" as const,
  };
  const ok = await verifyIdentity(
    new EsploraBackend("xbt", btcConfig, new FakeEsploraTransport(xbt)),
    MAINNET.chains.xbt,
  );
  assertEquals(ok.ok, true);
  const btc = fakeChain("btc");
  const wrong = await verifyIdentity(
    new EsploraBackend("xbt", btcConfig, new FakeEsploraTransport(btc)),
    MAINNET.chains.xbt,
  );
  assertEquals(wrong.ok, false);
  assert(wrong.detail.includes("wrong chain"));
  const lagging = fakeChain("ecx", 974_000); // below the 974,017 checkpoint
  const lag = await verifyIdentity(
    new EsploraBackend("ecx", btcConfig, new FakeEsploraTransport(lagging)),
    MAINNET.chains.ecx,
  );
  assertEquals(lag.ok, false);
  // An ECX node still on v1.0.0 follows a different block at 974,017.
  const stale = fakeChain("ecx");
  stale.hashes.set(974_017, "11".repeat(32));
  const v100 = await verifyIdentity(
    new EsploraBackend("ecx", btcConfig, new FakeEsploraTransport(stale)),
    MAINNET.chains.ecx,
  );
  assertEquals(v100.ok, false);
});

Deno.test("Esplora trap: an unknown txid is absent even though outspend says unspent", async () => {
  const chain = fakeChain("ecx");
  const cfg = {
    kind: "esplora" as const,
    url: "http://x/api",
    proxy: { kind: "tor" as const },
    role: "both" as const,
    priority: 0,
    origin: "user" as const,
  };
  const backend = new EsploraBackend("ecx", cfg, new FakeEsploraTransport(chain));
  const obs = await backend.observeOutput(txid(1), 0);
  assertEquals(obs.state, "absent");
  addOutput(chain, txid(2), 0, 5000, "bc1qexample", "0014", 900_000);
  assertEquals((await backend.observeOutput(txid(2), 0)).state, "unspent");
  chain.spends.set(`${txid(2)}:0`, { txid: txid(3), height: 974_400 });
  const spent = await backend.observeOutput(txid(2), 0);
  assertEquals(spent.state, "spent");
  if (spent.state === "spent") assertEquals(spent.spendHeight, 974_400);
});

Deno.test("Esplora trap: a never-broadcast txid's /status says unconfirmed, not absent", async () => {
  const chain = fakeChain("ecx");
  chain.statusTrap = true;
  const cfg = {
    kind: "esplora" as const,
    url: "http://x/api",
    proxy: { kind: "tor" as const },
    role: "both" as const,
    priority: 0,
    origin: "user" as const,
  };
  const backend = new EsploraBackend("ecx", cfg, new FakeEsploraTransport(chain));
  // txStatus must not trust confirmed:false alone: it should check existence separately and
  // report a never-broadcast txid as absent, not mempool.
  assertEquals(await backend.txStatus(txid(1)), { state: "absent" });
  addOutput(chain, txid(2), 0, 5000, "bc1qexample", "0014"); // no height: unconfirmed
  assertEquals(await backend.txStatus(txid(2)), { state: "mempool" });
  chain.txs.get(txid(2))!.height = 974_400;
  assertEquals((await backend.txStatus(txid(2))).state, "confirmed");
});

Deno.test("btcToSats has no float drift", () => {
  assertEquals(btcToSats(0.1 + 0.2), 30_000_000);
  assertEquals(btcToSats(20999999.9769), 2_099_999_997_690_000);
  assertEquals(btcToSats(0.00000001), 1);
});

function coin(obs: Partial<CoinRecord["observations"]>): CoinRecord {
  return {
    txid: txid(9),
    vout: 0,
    value: 1000,
    scriptPubKey: "",
    observations: {
      btc: obs.btc ?? { state: "absent" },
      xbt: obs.xbt ?? { state: "absent" },
      ecx: obs.ecx ?? { state: "absent" },
    },
  };
}

Deno.test("classification", () => {
  const ctx = {
    tips: { btc: 975_000, xbt: 970_000, ecx: 974_500 },
    confirmations: { btc: 6, xbt: 50, ecx: 50 },
  };
  const unspent = { state: "unspent" as const, value: 1000, createdHeight: 900_000 };
  const deep = (h: number) => ({ state: "spent" as const, spendHeight: h, spendDetailKnown: true });

  const shared = classify(coin({ btc: unspent, xbt: unspent, ecx: unspent }), ctx);
  assertEquals(shared.status, "shared");
  assertEquals(shared.nextSteps.length, 3);
  assert(shared.nextSteps[0].includes("ECX"));
  assert(shared.nextSteps[1].includes("0x21"));

  assertEquals(
    classify(coin({ btc: unspent, xbt: deep(969_000), ecx: deep(974_000) }), ctx).status,
    "separated",
  );
  const shallow = classify(coin({ btc: unspent, xbt: deep(969_000), ecx: deep(974_480) }), ctx);
  assertEquals(shallow.status, "pending");
  assert(shallow.reasons[0].includes("21 of 50"));
  assertEquals(classify(coin({ btc: unspent, ecx: { state: "gone" } }), ctx).status, "pending");
  assertEquals(
    classify(coin({ btc: unspent, xbt: { state: "unknown", error: "timeout" } }), ctx).status,
    "unverified",
  );
  // Known-shared stays shared even if a third chain is unknown.
  assertEquals(
    classify(coin({ btc: unspent, ecx: unspent, xbt: { state: "unknown", error: "x" } }), ctx)
      .status,
    "shared",
  );
  // BTC already moved; fork copies still shared with each other.
  const forksOnly = classify(coin({ btc: deep(974_000), xbt: unspent, ecx: unspent }), ctx);
  assertEquals(forksOnly.status, "shared");
  assert(forksOnly.nextSteps[0].includes("ECX"));
});

Deno.test("files are written privately", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tmp();
  await writeGate(await loadConfig({ dataDir: dir, env: {} }), {});
  const info = await Deno.stat(join(dir, "network-confirmation.json"));
  assertEquals((info.mode ?? 0) & 0o077, 0);
});
