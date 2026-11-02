import { assert, assertEquals } from "./assert.ts";
import { type CliIO, main } from "../src/cli/main.ts";
import { loadConfig, networkConfirmed } from "../src/core/config.ts";
import type { ChainId } from "../src/core/profiles.ts";
import { startUi } from "../src/ui/server.ts";
import { type FakeChain, fakeChain, FakeEsploraTransport } from "./fakes.ts";

function harness() {
  const chains: Record<ChainId, FakeChain> = {
    btc: fakeChain("btc", 975_000),
    xbt: fakeChain("xbt", 970_000),
    ecx: fakeChain("ecx", 974_500),
  };
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: () => true,
    env: {},
    tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
    transportFactory: (_c, chain) => new FakeEsploraTransport(chains[chain]),
  };
  return { io, out, err };
}

Deno.test("config scan sets gap limit and jitter, and re-locks until init", async () => {
  const dir = await Deno.makeTempDir({ prefix: "splayed-cfgscan-" });
  const h = harness();
  assertEquals(await main(["--data-dir", dir, "init", "--yes"], h.io), 0);
  assert(await networkConfirmed(await loadConfig({ dataDir: dir, env: {} })));

  assertEquals(
    await main(
      ["--data-dir", dir, "config", "scan", "--gap-limit", "50", "--jitter", "0-300"],
      h.io,
    ),
    0,
  );
  const config = await loadConfig({ dataDir: dir, env: {} });
  assertEquals(config.scan, { gapLimit: 50, jitterMinMs: 0, jitterMaxMs: 300 });
  // Scan settings are privacy-relevant: changing them closes the gate.
  assertEquals(await networkConfirmed(config), false);

  // One setting at a time keeps the other.
  assertEquals(await main(["--data-dir", dir, "config", "scan", "--gap-limit", "30"], h.io), 0);
  assertEquals((await loadConfig({ dataDir: dir, env: {} })).scan.jitterMaxMs, 300);
});

Deno.test("config scan refuses bad values and leaves the file untouched", async () => {
  const dir = await Deno.makeTempDir({ prefix: "splayed-cfgscan-" });
  const h = harness();
  assertEquals(await main(["--data-dir", dir, "config", "scan", "--gap-limit", "25"], h.io), 0);
  const before = await Deno.readTextFile(`${dir}/splayed.toml`);
  for (
    const args of [
      ["--gap-limit", "0"],
      ["--gap-limit", "5000"],
      ["--gap-limit", "abc"],
      ["--jitter", "900-100"], // max below min
      ["--jitter", "100"],
      ["--jitter", "0-70000"],
      [], // nothing to set
    ]
  ) {
    const code = await main(["--data-dir", dir, "config", "scan", ...args], h.io);
    assert(code !== 0, `expected failure for ${args.join(" ")}`);
  }
  assertEquals(await Deno.readTextFile(`${dir}/splayed.toml`), before);
});

Deno.test("UI: overview reports the scan settings; config scan runs from the UI", async () => {
  const dir = await Deno.makeTempDir({ prefix: "splayed-cfgscan-ui-" });
  const h = harness();
  const ui = startUi({ dataDir: dir, run: main, baseIO: { env: {}, tor: h.io.tor } });
  const api = async (path: string, body?: unknown) =>
    await (await fetch(`http://127.0.0.1:${ui.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${ui.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })).json();
  try {
    assertEquals((await api("/api/overview")).scanSettings, {
      gapLimit: 20,
      jitterMinMs: 150,
      jitterMaxMs: 900,
    });
    let job = await api("/api/run", {
      args: ["config", "scan", "--gap-limit", "40", "--jitter", "100-200"],
    });
    while (!job.done) {
      await new Promise((r) => setTimeout(r, 10));
      job = await api(`/api/jobs/${job.id}`);
    }
    assertEquals(job.exitCode, 0);
    assertEquals((await api("/api/overview")).scanSettings, {
      gapLimit: 40,
      jitterMinMs: 100,
      jitterMaxMs: 200,
    });
  } finally {
    await ui.server.shutdown();
  }
});
