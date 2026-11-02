import { assert, assertEquals } from "./assert.ts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { type CliIO, main } from "../src/cli/main.ts";
import { parseDescriptor } from "../src/core/descriptors.ts";
import type { ChainId } from "../src/core/profiles.ts";
import { addOutput, type FakeChain, fakeChain, FakeEsploraTransport, txid } from "./fakes.ts";

const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
)).derive("m/84'/0'/0'").publicExtendedKey;
const DESC = `wpkh(${xpub}/<0;1>/*)`;
const wallet = parseDescriptor(DESC);
const addr = (i: number) => wallet.branches[0].derive(i);

function harness(chains: Record<ChainId, FakeChain>, confirmAnswer = true) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: () => confirmAnswer,
    env: {},
    tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
    transportFactory: (_config, chain) => new FakeEsploraTransport(chains[chain]),
  };
  return { io, out, err, text: () => out.join("\n"), errors: () => err.join("\n") };
}

/** Builds the three chains for one wallet with coins in every interesting state. */
function scenario() {
  const btc = fakeChain("btc", 975_000);
  const xbt = fakeChain("xbt", 970_000);
  const ecx = fakeChain("ecx", 974_500);
  const all = [btc, xbt, ecx];
  const put = (chains: FakeChain[], n: number, i: number, value: number, height = 900_000) => {
    const a = addr(i);
    for (const c of chains) addOutput(c, txid(n), 0, value, a.address, a.scriptPubKey, height);
  };
  // 1: pre-fork coin, untouched everywhere -> shared on all three.
  put(all, 1, 0, 100_000);
  // 2: split on both forks long ago -> separated (BTC only).
  put(all, 2, 1, 200_000);
  xbt.spends.set(`${txid(2)}:0`, { txid: txid(102), height: 965_000 });
  ecx.spends.set(`${txid(2)}:0`, { txid: txid(202), height: 974_000 });
  // 3: ECX split only 21 deep, XBT split deep -> pending.
  put(all, 3, 2, 300_000);
  xbt.spends.set(`${txid(3)}:0`, { txid: txid(103), height: 965_000 });
  ecx.spends.set(`${txid(3)}:0`, { txid: txid(203), height: 974_480 });
  // 4: spent on BTC (and therefore ECX) before 973,727 but never on XBT -> XBT-only claimable.
  put(all, 4, 3, 400_000);
  btc.spends.set(`${txid(4)}:0`, { txid: txid(104), height: 965_000 });
  ecx.spends.set(`${txid(4)}:0`, { txid: txid(104), height: 965_000 });
  // 5: received on BTC after both forks -> BTC only, absent on forks.
  put([btc], 5, 4, 500_000, 974_900);
  return { btc, xbt, ecx };
}

async function freshDir() {
  return await Deno.makeTempDir({ prefix: "splayed-cli-" });
}

Deno.test("gate: nothing coin-related is allowed before init", async () => {
  const chains = scenario();
  const h = harness(chains);
  const dir = await freshDir();
  assertEquals(await main(["--data-dir", dir, "import", DESC], h.io), 1);
  assert(h.errors().includes("splayed init"));
  assertEquals(await main(["--data-dir", dir, "scan"], h.io), 1);
  // No request touched any chain before init.
  assertEquals(
    chains.btc.requests.length + chains.xbt.requests.length + chains.ecx.requests.length,
    0,
  );
});

Deno.test("init only sends identity queries and needs an explicit yes", async () => {
  const chains = scenario();
  const dir = await freshDir();
  const declined = harness(chains, false);
  assertEquals(await main(["--data-dir", dir, "init"], declined.io), 1);
  assertEquals(await main(["--data-dir", dir, "import", DESC], declined.io), 1);
  const h = harness(chains);
  assertEquals(await main(["--data-dir", dir, "init"], h.io), 0);
  for (const c of [chains.btc, chains.xbt, chains.ecx]) {
    assert(
      c.requests.every((p) => p === "/blocks/tip/height" || p.startsWith("/block-height/")),
      `init sent a non-identity request: ${c.requests.join(", ")}`,
    );
  }
  assert(h.text().includes("public onion service via Tor"));
});

Deno.test("init fails when a backend is on the wrong chain", async () => {
  const chains = scenario();
  const h = harness({ ...chains, xbt: chains.btc }); // XBT backend actually serves BTC
  assertEquals(await main(["--data-dir", await freshDir(), "init", "--yes"], h.io), 1);
  assert(h.text().includes("wrong chain"));
});

Deno.test("end to end: import, scan and status classify every coin", async () => {
  const chains = scenario();
  const dir = await freshDir();
  const h = harness(chains);
  assertEquals(await main(["--data-dir", dir, "init", "--yes"], h.io), 0);
  assertEquals(await main(["--data-dir", dir, "import", DESC, "--label", "test"], h.io), 0);
  assert(h.text().includes("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"));
  // Fast test: no jitter.
  const cfg = `[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n`;
  await Deno.writeTextFile(`${dir}/splayed.toml`, cfg);
  // Changing the config closes the gate...
  assertEquals(await main(["--data-dir", dir, "scan"], h.io), 1);
  // ...until it is confirmed again.
  assertEquals(await main(["--data-dir", dir, "init", "--yes"], h.io), 0);
  assertEquals(await main(["--data-dir", dir, "scan"], h.io), 0);

  const s = harness(chains);
  assertEquals(await main(["--data-dir", dir, "status", "--json"], s.io), 0);
  const result = JSON.parse(s.text());
  const byTx = Object.fromEntries(
    result.coins.map((
      c: { txid: string; classification: { status: string; unspentOn: string[] } },
    ) => [
      c.txid,
      c.classification,
    ]),
  );
  assertEquals(byTx[txid(1)].status, "shared");
  assertEquals(byTx[txid(1)].unspentOn, ["btc", "xbt", "ecx"]);
  assertEquals(byTx[txid(2)].status, "separated");
  assertEquals(byTx[txid(3)].status, "pending");
  assertEquals(byTx[txid(4)].status, "separated");
  assertEquals(byTx[txid(4)].unspentOn, ["xbt"]);
  assertEquals(byTx[txid(5)].status, "separated");
  assertEquals(result.coins.length, 5);
  // Every outpoint check asked for the transaction before its outspend (Esplora trap).
  for (const c of [chains.btc, chains.xbt, chains.ecx]) {
    c.requests.forEach((p, i) => {
      const m = /^\/tx\/([0-9a-f]{64})\/outspend\/\d+$/u.exec(p);
      if (m) assertEquals(c.requests[i - 1], `/tx/${m[1]}`);
    });
  }
  const table = harness(chains);
  await main(["--data-dir", dir, "status"], table.io);
  assert(table.text().includes("SHARED (BTC+XBT+ECX)"));
  assert(table.text().includes("Split on XBT: SIGHASH_ALL|UNIFIED (0x21)"));
});

Deno.test("config edits validate before saving and re-gate", async () => {
  const chains = scenario();
  const dir = await freshDir();
  const h = harness(chains);
  assertEquals(await main(["--data-dir", dir, "init", "--yes"], h.io), 0);
  // Clearnet without opt-in is rejected and nothing is written.
  assertEquals(
    await main([
      "--data-dir",
      dir,
      "config",
      "backend",
      "add",
      "ecx",
      "--kind",
      "esplora",
      "--url",
      "https://esplora.ecash.ninja",
      "--proxy",
      "none",
    ], h.io),
    1,
  );
  assertEquals(await Deno.stat(`${dir}/splayed.toml`).then(() => true).catch(() => false), false);
  // A local node is accepted and keeps the default as a second backend.
  assertEquals(
    await main([
      "--data-dir",
      dir,
      "config",
      "backend",
      "add",
      "btc",
      "--kind",
      "rpc",
      "--url",
      "http://127.0.0.1:8332",
      "--cookie-file",
      "/tmp/none",
      "--priority",
      "0",
    ], h.io),
    0,
  );
  const show = harness(chains);
  await main(["--data-dir", dir, "config", "show"], show.io);
  assert(show.text().includes("local (this machine)"));
  assert(show.text().includes("Network settings confirmed: NO"));
});

Deno.test("init asks before contacting anything; declining sends zero requests", async () => {
  const chains = scenario();
  const h = harness(chains, false);
  assertEquals(await main(["--data-dir", await freshDir(), "init"], h.io), 1);
  assert(h.text().includes("Nothing was contacted"));
  assertEquals(
    chains.btc.requests.length + chains.xbt.requests.length + chains.ecx.requests.length,
    0,
  );
});

Deno.test("adding your own backend removes the profile default; only the first passing backend is contacted", async () => {
  const chains = scenario();
  const dir = await freshDir();
  const urls: string[] = [];
  const h = harness(chains);
  h.io.transportFactory = (_config, chain, backend) => {
    urls.push(backend.url);
    return new FakeEsploraTransport(chains[chain]);
  };
  for (const [chain, port] of [["btc", 3001], ["xbt", 3002], ["ecx", 3003]] as const) {
    assertEquals(
      await main([
        "--data-dir",
        dir,
        "config",
        "backend",
        "add",
        chain,
        "--kind",
        "esplora",
        "--url",
        `http://127.0.0.1:${port}/api`,
      ], h.io),
      0,
    );
    // A second, lower-priority backend that should never be needed.
    assertEquals(
      await main([
        "--data-dir",
        dir,
        "config",
        "backend",
        "add",
        chain,
        "--kind",
        "esplora",
        "--url",
        `http://127.0.0.1:${port + 100}/api`,
        "--priority",
        "5",
      ], h.io),
      0,
    );
  }
  assert(h.errors().includes("profile default backend is removed"));
  const show = harness(chains);
  await main(["--data-dir", dir, "config", "show"], show.io);
  assert(!show.text().includes("mempoolhq"), "BTC default still configured");
  assert(!show.text().includes("explorer.ecash.com/api\n"), "ECX default still configured");
  assertEquals(await main(["--data-dir", dir, "init", "--yes"], h.io), 0, h.errors());
  assert(h.text().includes("not contacted (a higher-priority backend passed)"));
  assertEquals(urls.sort(), [
    "http://127.0.0.1:3001/api",
    "http://127.0.0.1:3002/api",
    "http://127.0.0.1:3003/api",
  ]);
});

Deno.test("a rescan warns about shared coins that turned up since the last scan", async () => {
  const chains = scenario();
  const dir = await freshDir();
  await Deno.writeTextFile(`${dir}/splayed.toml`, `[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n`);
  const h = harness(chains);
  assertEquals(await main(["--data-dir", dir, "init", "--yes"], h.io), 0);
  assertEquals(await main(["--data-dir", dir, "import", DESC], h.io), 0);
  const first = harness(chains);
  assertEquals(await main(["--data-dir", dir, "scan"], first.io), 0);
  // The first scan has nothing to compare with: coin 1 is shared but not "new".
  assert(!first.errors().includes("NEW SHARED"), first.errors());
  const readScan = async () => JSON.parse(await Deno.readTextFile(`${dir}/scan.json`));
  assertEquals((await readScan()).newShared, []);

  // A pre-fork coin on a further address turns up on all three chains.
  const a = addr(5);
  for (const c of [chains.btc, chains.xbt, chains.ecx]) {
    addOutput(c, txid(6), 0, 600_000, a.address, a.scriptPubKey, 900_000);
  }
  const second = harness(chains);
  // Not a failure: the exit code stays 0 (only warnings make it 1).
  assertEquals(await main(["--data-dir", dir, "scan"], second.io), 0);
  const warning = second.errors();
  assert(warning.includes("NEW SHARED COINS: 1 coin turned up"), warning);
  assert(warning.includes(`${txid(6)}:0`), warning); // in full, ready for `plan --coin`
  assert(warning.includes("unspent on BTC+XBT+ECX"), warning);
  assert(warning.includes("not in the previous scan"), warning);
  assert(warning.includes("Don't spend them on BTC"), warning);
  assert(warning.includes("--coin txid:vout"), warning);
  // Coin 1 was already shared at the first scan: not listed.
  assert(!warning.includes(`${txid(1)}:0`), warning);
  const saved = await readScan();
  assertEquals(saved.newShared, [{
    txid: txid(6),
    vout: 0,
    value: 600_000,
    address: a.address,
    unspentOn: ["btc", "xbt", "ecx"],
    previously: "absent",
    firstSeen: saved.scannedAt,
  }]);

  // Another rescan keeps the warning (same first sighting) until the coin is split...
  const third = harness(chains);
  assertEquals(await main(["--data-dir", dir, "scan"], third.io), 0);
  assert(third.errors().includes("NEW SHARED COINS"));
  assertEquals((await readScan()).newShared[0].firstSeen, saved.scannedAt);
  // ...and `status` repeats it without touching the network.
  const status = harness(chains);
  assertEquals(await main(["--data-dir", dir, "status"], status.io), 0);
  assert(status.errors().includes("NEW SHARED COINS"));

  // Split on both forks (deep): it drops off.
  chains.xbt.spends.set(`${txid(6)}:0`, { txid: txid(106), height: 965_000 });
  chains.ecx.spends.set(`${txid(6)}:0`, { txid: txid(206), height: 974_000 });
  const fourth = harness(chains);
  assertEquals(await main(["--data-dir", dir, "scan"], fourth.io), 0);
  assert(!fourth.errors().includes("NEW SHARED"));
  assertEquals((await readScan()).newShared, []);
});
