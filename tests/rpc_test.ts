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
    if (method === "getdeploymentinfo") return { deployments: { blake2b: { active } } };
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
