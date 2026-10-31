import { assertEquals, assertRejects } from "./assert.ts";
import { rpcAuthorization, RpcBackend } from "../src/backends/rpc.ts";
import { verifyIdentity } from "../src/core/identity.ts";
import { MAINNET } from "../src/core/profiles.ts";
import { resolveRoute, RoutedTransport } from "../src/net/transport.ts";
import { BackendError } from "../src/backends/types.ts";

type Handler = (method: string, params: unknown[]) => unknown;

async function withFakeNode(handler: Handler, fn: (url: string, auths: string[]) => Promise<void>) {
  const auths: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    auths.push(req.headers.get("authorization") ?? "");
    const { id, method, params } = await req.json();
    try {
      return Response.json({ id, result: handler(method, params), error: null });
    } catch (e) {
      const err = e as { code?: number; message: string };
      return Response.json({
        id,
        result: null,
        error: { code: err.code ?? -1, message: err.message },
      });
    }
  });
  try {
    await fn(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, auths);
  } finally {
    await server.shutdown();
  }
}

const cfg = (url: string) => ({
  kind: "rpc" as const,
  url,
  proxy: { kind: "tor" as const },
  role: "both" as const,
  priority: 0,
  origin: "user" as const,
});

function backend(url: string, requiredDeployment?: string) {
  const route = resolveRoute(url, { kind: "tor" }, false, { host: "127.0.0.1", port: 9050 });
  return new RpcBackend(
    "xbt",
    cfg(url),
    new RoutedTransport(route),
    "Basic dGVzdA==",
    requiredDeployment,
  );
}

Deno.test("RPC: identity incl. XBT deployment check, local route, auth header", async () => {
  const xbtHash = MAINNET.chains.xbt.checkpoints[0].hash;
  let active = true;
  await withFakeNode((method, params) => {
    if (method === "getblockcount") return 970_000;
    if (method === "getblockhash") return params[0] === 961_640 ? xbtHash : "00".repeat(32);
    if (method === "getdeploymentinfo") {
      return { deployments: {}, blake2b: { height: 110, active } };
    }
    throw new Error(`unexpected ${method}`);
  }, async (url, auths) => {
    const b = backend(url, "blake2b");
    assertEquals(b.route.via, "direct");
    assertEquals((await verifyIdentity(b, MAINNET.chains.xbt)).ok, true);
    assertEquals(auths[0], "Basic dGVzdA==");
    active = false;
    const r = await verifyIdentity(b, MAINNET.chains.xbt);
    assertEquals(r.ok, false);
    assertEquals(r.detail.includes("blake2b"), true);
  });
});

Deno.test("RPC: gettxout null without txindex is 'gone', with txindex is spent/absent", async () => {
  let txindex = false;
  await withFakeNode((method, params) => {
    switch (method) {
      case "getblockcount":
        return 975_000;
      case "gettxout":
        return params[0] === "11".repeat(32) ? { confirmations: 10, value: 0.5 } : null;
      case "getindexinfo":
        return txindex ? { txindex: { synced: true } } : {};
      case "getrawtransaction":
        if (params[0] === "22".repeat(32)) return { vout: [{ value: 0.1 }] };
        throw Object.assign(new Error("No such mempool or blockchain transaction"), { code: -5 });
    }
    throw new Error(`unexpected ${method}`);
  }, async (url) => {
    const unspent = await backend(url).observeOutput("11".repeat(32), 0);
    assertEquals(unspent, { state: "unspent", value: 50_000_000, createdHeight: 974_991 });
    assertEquals((await backend(url).observeOutput("22".repeat(32), 0)).state, "gone");
    txindex = true;
    assertEquals((await backend(url).observeOutput("22".repeat(32), 0)).state, "spent");
    assertEquals((await backend(url).observeOutput("33".repeat(32), 0)).state, "absent");
  });
});

Deno.test("RPC auth: cookie file, env password, and refusal without either", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/.cookie`, "__cookie__:abc\n");
  assertEquals(
    await rpcAuthorization({ cookieFile: `${dir}/.cookie` }, {}),
    `Basic ${btoa("__cookie__:abc")}`,
  );
  assertEquals(
    await rpcAuthorization({ user: "u", passwordEnv: "PW" }, { PW: "p" }),
    `Basic ${btoa("u:p")}`,
  );
  await assertRejects(() => rpcAuthorization({ user: "u", passwordEnv: "PW" }, {}), BackendError);
  await assertRejects(() => rpcAuthorization(undefined, {}), BackendError);
});

Deno.test("scan: node RPC discovery (no addresses revealed) + Esplora cross-check", async () => {
  const { HDKey } = await import("@scure/bip32");
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const { parseDescriptor } = await import("../src/core/descriptors.ts");
  const { runScan } = await import("../src/core/scan.ts");
  const { loadConfig } = await import("../src/core/config.ts");
  const { EsploraBackend } = await import("../src/backends/esplora.ts");
  const { fakeChain, FakeEsploraTransport, addOutput, txid } = await import("./fakes.ts");
  const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  )).derive("m/84'/0'/0'").publicExtendedKey;
  const desc = parseDescriptor(`wpkh(${xpub}/<0;1>/*)`);
  const a7 = desc.branches[1].derive(7);
  const id = txid(42);
  const seen: unknown[] = [];
  await withFakeNode((method, params) => {
    if (method === "getblockcount") return 975_000;
    if (method === "scantxoutset") {
      seen.push(params[1]);
      return {
        success: true,
        unspents: [{
          txid: id,
          vout: 1,
          scriptPubKey: a7.scriptPubKey,
          amount: 0.0123,
          height: 900_000,
        }],
      };
    }
    throw new Error(`unexpected ${method}`);
  }, async (url) => {
    const config = await loadConfig({ dataDir: await Deno.makeTempDir(), env: {} });
    const route = resolveRoute(url, { kind: "tor" }, false, { host: "127.0.0.1", port: 9050 });
    const btc = new RpcBackend("btc", cfg(url), new RoutedTransport(route), "Basic dGVzdA==");
    const xbt = fakeChain("xbt", 970_000);
    const ecx = fakeChain("ecx", 974_500);
    addOutput(xbt, id, 1, 1_230_000, a7.address, a7.scriptPubKey, 900_000);
    addOutput(ecx, id, 1, 1_230_000, a7.address, a7.scriptPubKey, 900_000);
    ecx.spends.set(`${id}:1`, { txid: txid(43), height: 974_000 });
    const esp = (chain: "xbt" | "ecx", c: ReturnType<typeof fakeChain>) =>
      new EsploraBackend(
        chain,
        { ...cfg("http://x/api"), kind: "esplora" as const },
        new FakeEsploraTransport(c),
      );
    const result = await runScan(config, [desc], {
      backends: { btc, xbt: esp("xbt", xbt), ecx: esp("ecx", ecx) },
      sleep: () => Promise.resolve(),
      rpcRange: 10,
    });
    assertEquals(seen[0], [
      { desc: desc.branches[0].body, range: [0, 9] },
      { desc: desc.branches[1].body, range: [0, 9] },
    ]);
    assertEquals(result.addressesRevealed.btc, 0);
    // The coin was found by the node and by XBT's gap walk, so it shows up once.
    assertEquals(result.coins.length, 1);
    const coin = result.coins[0];
    assertEquals(coin.value, 1_230_000);
    assertEquals(coin.derivationIndex, 7);
    assertEquals(coin.observations.btc.state, "unspent");
    assertEquals(coin.observations.xbt.state, "unspent");
    assertEquals(coin.observations.ecx.state, "spent");
  });
});
