import { assertEquals } from "./assert.ts";
import { loadConfig } from "../src/core/config.ts";

Deno.test("SPLAYED_TOR_MODE sets the Tor mode (containers), over the config file", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-tormode-" });
  await Deno.writeTextFile(`${dataDir}/splayed.toml`, `[tor]\nmode = "managed"\n`);
  assertEquals((await loadConfig({ dataDir, env: {} })).tor.mode, "managed");
  const c = await loadConfig({
    dataDir,
    env: { SPLAYED_TOR_MODE: "system", SPLAYED_TOR_SOCKS: "tor:9050" },
  });
  assertEquals(c.tor.mode, "system");
  assertEquals(c.tor.socks, { host: "tor", port: 9050 });
  let refused = false;
  try {
    await loadConfig({ dataDir, env: { SPLAYED_TOR_MODE: "clearnet" } });
  } catch {
    refused = true;
  }
  assertEquals(refused, true);
});
