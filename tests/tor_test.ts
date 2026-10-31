import { assert, assertEquals, assertRejects } from "./assert.ts";
import { fromFileUrl } from "./paths.ts";
import { probeSocks, TorManager, TorStartError } from "../src/net/tor.ts";
import { TorUnavailableError } from "../src/net/transport.ts";

const FAKE_TOR = fromFileUrl(new URL("./fixtures/fake_tor.sh", import.meta.url));

/** A minimal "running Tor": answers the SOCKS5 greeting. */
function fakeSystemTor(): { port: number; close: () => void; greetings: () => number } {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  let greetings = 0;
  (async () => {
    for await (const conn of listener) {
      const buf = new Uint8Array(8);
      await conn.read(buf).catch(() => null);
      greetings++;
      await conn.write(Uint8Array.of(5, 2)).catch(() => {});
      conn.close();
    }
  })().catch(() => {});
  return {
    port: (listener.addr as Deno.NetAddr).port,
    close: () => listener.close(),
    greetings: () => greetings,
  };
}

function closedPort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

Deno.test("probeSocks: SOCKS5 server yes, closed port no", async () => {
  const sys = fakeSystemTor();
  try {
    assert(await probeSocks({ host: "127.0.0.1", port: sys.port }));
    assert(!(await probeSocks({ host: "127.0.0.1", port: closedPort() })));
  } finally {
    sys.close();
  }
});

Deno.test("auto/system: a running Tor at the configured address is used, nothing is started", async () => {
  const sys = fakeSystemTor();
  const m = new TorManager();
  try {
    const ep = await m.ensure(
      {
        mode: "auto",
        socks: { host: "127.0.0.1", port: sys.port },
        binary: "/nonexistent/tor",
        bootstrapTimeoutSec: 10,
      },
      await Deno.makeTempDir(),
    );
    assertEquals(ep.port, sys.port);
    assertEquals(m.status.state === "ready" && m.status.source, "system");
  } finally {
    await m.stop();
    sys.close();
  }
});

Deno.test("system mode never starts Tor; it fails closed", async () => {
  const m = new TorManager();
  await assertRejects(
    () =>
      m.ensure(
        { mode: "system", socks: { host: "127.0.0.1", port: 1 }, bootstrapTimeoutSec: 10 },
        "/tmp",
      ),
    TorUnavailableError,
  );
});

Deno.test("managed: starts its own Tor, waits for bootstrap, stops it", async () => {
  const dir = await Deno.makeTempDir();
  const m = new TorManager();
  const logs: string[] = [];
  const ep = await m.ensure(
    { mode: "managed", binary: FAKE_TOR, bootstrapTimeoutSec: 30 },
    dir,
    (l) => logs.push(l),
  );
  try {
    assert(await probeSocks(ep));
    assert(logs.some((l) => l.includes("bootstrapped 100%")));
    const rc = await Deno.readTextFile(`${dir}/tor/torrc`);
    assert(rc.includes(`SocksPort 127.0.0.1:${ep.port} IsolateSOCKSAuth`));
    assert(rc.includes("SafeSocks 1"));
    assert(rc.includes(`__OwningControllerProcess ${Deno.pid}`));
    // A second ensure() reuses the running instance.
    assertEquals(
      (await m.ensure({ mode: "managed", binary: FAKE_TOR, bootstrapTimeoutSec: 30 }, dir)).port,
      ep.port,
    );
  } finally {
    await m.stop();
  }
  assert(!(await probeSocks(ep)));
});

Deno.test("managed: a Tor that fails to start is reported, not hidden", async () => {
  Deno.env.set("FAKE_TOR_MODE", "error");
  try {
    await assertRejects(
      () =>
        new TorManager().ensure(
          { mode: "managed", binary: FAKE_TOR, bootstrapTimeoutSec: 30 },
          Deno.makeTempDirSync(),
        ),
      TorStartError,
    );
  } finally {
    Deno.env.delete("FAKE_TOR_MODE");
  }
});
