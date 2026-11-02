import { assert, assertEquals } from "./assert.ts";
import { type CliIO, main } from "../src/cli/main.ts";
import { loadConfig } from "../src/core/config.ts";
import type { ChainId } from "../src/core/profiles.ts";
import { type FakeChain, fakeChain, FakeEsploraTransport } from "./fakes.ts";

/** Each URL serves one fake chain, whichever chain splayed asks it as. */
function harness(byUrl: Record<string, FakeChain>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: () => true,
    env: {},
    tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
    transportFactory: (_config, _chain, backend) => {
      const c = byUrl[backend.url];
      if (!c) throw new Error(`connection refused: ${backend.url}`);
      return new FakeEsploraTransport(c);
    },
  };
  return { io, out, err, text: () => [...out, ...err].join("\n") };
}

const URLS: Record<ChainId, string> = {
  btc: "http://10.0.3.1:3001/api",
  xbt: "http://10.0.3.1:3002/api",
  ecx: "http://10.0.3.1:3003/api",
};

Deno.test("config backend detect: names the chain each backend follows, by its checkpoints", async () => {
  const h = harness({
    [URLS.btc]: fakeChain("btc", 975_000),
    [URLS.xbt]: fakeChain("xbt", 970_000),
    [URLS.ecx]: fakeChain("ecx", 974_500),
  });
  const dir = await Deno.makeTempDir({ prefix: "splayed-detect-" });
  for (const chain of ["btc", "xbt", "ecx"] as ChainId[]) {
    h.out.length = 0;
    const code = await main(
      ["--data-dir", dir, "config", "backend", "detect", "--kind", "esplora", "--url", URLS[chain]],
      h.io,
    );
    assertEquals(code, 0, h.text());
    const matches = h.out.filter((l) => l.includes("MATCH"));
    assertEquals(matches.length, 1, h.text());
    assert(h.text().includes(`follows`), h.text());
    assert(h.text().includes(`config backend add ${chain}`), h.text());
  }
  // Without --add nothing is written.
  const config = await loadConfig({ dataDir: dir, env: {} });
  for (const chain of ["btc", "xbt", "ecx"] as ChainId[]) {
    assert(!config.chains[chain].backends.some((b) => Object.values(URLS).includes(b.url)));
  }
});

Deno.test("config backend detect --add: adds it to the matching chain only (and re-locks)", async () => {
  const h = harness({ [URLS.xbt]: fakeChain("xbt", 970_000) });
  const dir = await Deno.makeTempDir({ prefix: "splayed-detect-" });
  const code = await main(
    [
      "--data-dir",
      dir,
      "config",
      "backend",
      "detect",
      "--kind",
      "esplora",
      "--url",
      URLS.xbt,
      "--add",
    ],
    h.io,
  );
  assertEquals(code, 0, h.text());
  const config = await loadConfig({ dataDir: dir, env: {} });
  assert(config.chains.xbt.backends.some((b) => b.url === URLS.xbt), "added to XBT");
  assert(!config.chains.btc.backends.some((b) => b.url === URLS.xbt), "not BTC");
  assert(!config.chains.ecx.backends.some((b) => b.url === URLS.xbt), "not ECX");
  assert(h.text().includes("run `splayed init`"), h.text());
});

Deno.test("config backend detect: refuses a backend that matches no chain, and adds nothing", async () => {
  // A BTC server still syncing (behind the checkpoints), and one that doesn't answer.
  const h = harness({ [URLS.btc]: fakeChain("btc", 960_000) });
  const dir = await Deno.makeTempDir({ prefix: "splayed-detect-" });
  for (const url of [URLS.btc, URLS.ecx]) {
    const code = await main(
      [
        "--data-dir",
        dir,
        "config",
        "backend",
        "detect",
        "--kind",
        "esplora",
        "--url",
        url,
        "--add",
      ],
      h.io,
    );
    assertEquals(code, 1, h.text());
  }
  assert(h.text().includes("doesn't follow any of the three chains"), h.text());
  const config = await loadConfig({ dataDir: dir, env: {} });
  for (const chain of ["btc", "xbt", "ecx"] as ChainId[]) {
    assert(!config.chains[chain].backends.some((b) => Object.values(URLS).includes(b.url)));
  }
});
