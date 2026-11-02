import { assert, assertEquals } from "./assert.ts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { type CliIO, main } from "../src/cli/main.ts";
import { parseDescriptor } from "../src/core/descriptors.ts";
import { describeProgress, type Progress, throttleProgress } from "../src/core/progress.ts";
import type { ChainId } from "../src/core/profiles.ts";
import { JobRunner } from "../src/ui/jobs.ts";
import { addOutput, type FakeChain, fakeChain, FakeEsploraTransport, txid } from "./fakes.ts";

const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
)).derive("m/84'/0'/0'").publicExtendedKey;
const DESC = `wpkh(${xpub}/<0;1>/*)`;
const wallet = parseDescriptor(DESC);

Deno.test("throttleProgress: passes changes of phase/chain and final reports, holds the rest", () => {
  let t = 0;
  const seen: Progress[] = [];
  const p = throttleProgress((x) => seen.push(x), 250, () => t);
  p({ phase: "discovery", chain: "btc", done: 1 });
  p({ phase: "discovery", chain: "btc", done: 2 }); // held: same key, too soon
  t = 100;
  p({ phase: "discovery", chain: "btc", done: 3 }); // held
  p({ phase: "discovery", chain: "xbt", done: 1 }); // new chain: passes
  t = 400;
  p({ phase: "discovery", chain: "xbt", done: 2 }); // interval elapsed: passes
  p({ phase: "crosscheck", done: 0, total: 5 }); // new phase
  p({ phase: "crosscheck", done: 3, total: 5 }); // held
  p.flush(); // sends the held 3/5
  p({ phase: "crosscheck", done: 5, total: 5 }); // final always passes
  assertEquals(seen.map((x) => `${x.phase}:${x.chain ?? "-"}:${x.done}`), [
    "discovery:btc:1",
    "discovery:xbt:1",
    "discovery:xbt:2",
    "crosscheck:-:0",
    "crosscheck:-:3",
    "crosscheck:-:5",
  ]);
});

Deno.test("describeProgress: readable one-line text", () => {
  assertEquals(
    describeProgress({ phase: "tor", done: 45, total: 100, detail: "Loading relay descriptors" }),
    "Loading relay descriptors 45%",
  );
  assertEquals(
    describeProgress({
      phase: "identity",
      chain: "ecx",
      done: 1,
      total: 2,
      detail: "checking server",
    }),
    "ECX: checking server (1 of 2)",
  );
  assertEquals(
    describeProgress({ phase: "discovery", chain: "btc", done: 12 }),
    "BTC: addresses checked (12)",
  );
  assertEquals(
    describeProgress({ phase: "crosscheck", done: 3, total: 8 }),
    "cross-checking coins (3 of 8)",
  );
});

function chainsWithCoins(): Record<ChainId, FakeChain> {
  const btc = fakeChain("btc", 975_000);
  const xbt = fakeChain("xbt", 970_000);
  const ecx = fakeChain("ecx", 974_500);
  for (const [n, i] of [[1, 0], [2, 3]]) {
    const a = wallet.branches[0].derive(i);
    for (const c of [btc, xbt, ecx]) {
      addOutput(c, txid(n), 0, 100_000 * n, a.address, a.scriptPubKey, 900_000);
    }
  }
  return { btc, xbt, ecx };
}

function harness(chains: Record<ChainId, FakeChain>) {
  const progress: Progress[] = [];
  const io: CliIO = {
    out: () => {},
    err: () => {},
    confirm: () => true,
    env: {},
    tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
    transportFactory: (_config, chain) => new FakeEsploraTransport(chains[chain]),
    progress: (p) => progress.push(p),
  };
  return { io, progress };
}

Deno.test("init and scan report progress: Tor, identity checks, discovery, cross-check", async () => {
  const chains = chainsWithCoins();
  const dir = await Deno.makeTempDir({ prefix: "splayed-progress-" });
  await Deno.writeTextFile(`${dir}/splayed.toml`, `[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n`);
  const h = harness(chains);
  assertEquals(await main(["--data-dir", dir, "init", "--yes"], h.io), 0);
  const init = h.progress.splice(0);
  assert(init.some((p) => p.phase === "tor" && p.detail === "connecting through Tor"));
  for (const chain of ["btc", "xbt", "ecx"] as const) {
    assert(
      init.some((p) => p.phase === "identity" && p.chain === chain && p.total !== undefined),
      `identity progress for ${chain}`,
    );
  }

  assertEquals(await main(["--data-dir", dir, "import", DESC], h.io), 0);
  h.progress.splice(0);
  assertEquals(await main(["--data-dir", dir, "scan"], h.io), 0);
  const scan = h.progress;
  for (const chain of ["btc", "xbt", "ecx"] as const) {
    const counts = scan.filter((p) => p.phase === "discovery" && p.chain === chain)
      .map((p) => p.done ?? 0);
    assert(counts.length >= 2, `discovery progress for ${chain}`);
    assertEquals(counts[0], 0);
    for (let i = 1; i < counts.length; i++) assert(counts[i] >= counts[i - 1], "monotonic");
    // Both receive and change branches: at least 2 × gap limit (20) addresses.
    assert(counts[counts.length - 1] >= 40, `final count for ${chain}`);
  }
  // Coins are on all three chains, so there is nothing to cross-check: no crosscheck reports.
  assertEquals(scan.filter((p) => p.phase === "crosscheck").length, 0);
});

Deno.test("scan cross-check progress ends at done === total", async () => {
  const chains = chainsWithCoins();
  // A coin only BTC knows about: XBT and ECX are asked about it in the cross-check.
  const a = wallet.branches[0].derive(5);
  addOutput(chains.btc, txid(9), 0, 50_000, a.address, a.scriptPubKey, 974_900);
  const dir = await Deno.makeTempDir({ prefix: "splayed-progress-" });
  await Deno.writeTextFile(`${dir}/splayed.toml`, `[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n`);
  const h = harness(chains);
  assertEquals(await main(["--data-dir", dir, "init", "--yes"], h.io), 0);
  assertEquals(await main(["--data-dir", dir, "import", DESC], h.io), 0);
  h.progress.splice(0);
  await main(["--data-dir", dir, "scan"], h.io);
  const cross = h.progress.filter((p) => p.phase === "crosscheck");
  assert(cross.length >= 1);
  const last = cross[cross.length - 1];
  assertEquals(last.done, last.total);
  assertEquals(last.total, 2);
});

Deno.test("JobRunner keeps only the latest progress and clears it when the job ends", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runner = new JobRunner(
    async (_argv, io) => {
      io.progress?.({ phase: "discovery", chain: "btc", done: 1 });
      io.progress?.({ phase: "discovery", chain: "btc", done: 7 });
      await gate;
      return 0;
    },
    { env: {} },
    "/tmp/unused",
  );
  const job = runner.start(["scan"]);
  const running = runner.get(job.id);
  assertEquals(running.progress?.phase, "discovery");
  assertEquals(running.progress?.done, 7);
  assert(typeof running.progress?.at === "string");
  release();
  await new Promise((r) => setTimeout(r, 10));
  const done = runner.get(job.id);
  assertEquals(done.done, true);
  assertEquals(done.progress, undefined);
});

Deno.test("UI: a running scan exposes progress on /api/jobs/<id>, and none once done", async () => {
  const { startUi } = await import("../src/ui/server.ts");
  const chains = chainsWithCoins();
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-progress-ui-" });
  await Deno.writeTextFile(
    `${dataDir}/splayed.toml`,
    `[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n`,
  );
  // Slow every request down while `slow` is set, so the scan is still running when polled.
  let slow = false;
  const ui = startUi({
    dataDir,
    run: main,
    baseIO: {
      env: {},
      tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
      transportFactory: (_c, chain) => {
        const inner = new FakeEsploraTransport(chains[chain]);
        return {
          route: inner.route,
          request: async (spec) => {
            if (slow) await new Promise((r) => setTimeout(r, 15));
            return inner.request(spec);
          },
        };
      },
    },
  });
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${ui.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await r.json();
  };
  const runToEnd = async (args: string[]) => {
    let job = await api("/api/run", { args });
    while (!job.done) {
      await new Promise((r) => setTimeout(r, 10));
      job = await api(`/api/jobs/${job.id}`);
    }
    return job;
  };
  try {
    assertEquals((await runToEnd(["init", "--yes"])).exitCode, 0);
    assertEquals((await runToEnd(["import", DESC])).exitCode, 0);
    slow = true;
    let job = await api("/api/run", { args: ["scan"] });
    const phases = new Set<string>();
    while (!job.done) {
      if (job.progress) {
        phases.add(job.progress.phase);
        assert(typeof job.progress.at === "string");
      }
      await new Promise((r) => setTimeout(r, 20));
      job = await api(`/api/jobs/${job.id}`);
    }
    assertEquals(job.exitCode, 0);
    assert(phases.has("discovery"), `saw ${[...phases].join(",")}`);
    assertEquals(job.progress, undefined);
  } finally {
    await ui.server.shutdown();
  }
});

Deno.test("JobRunner passes on how a question is put: No is the default when yes skips a safety step", async () => {
  const runner = new JobRunner(
    async (_argv, io) => {
      const risky = await io.confirm("Send anyway?", { recommend: "no" });
      const plain = await io.confirm("Send?");
      return risky || !plain ? 1 : 0;
    },
    { env: {} },
    "/tmp/unused",
  );
  const job = runner.start(["broadcast", "p"]);
  const wait = async () => {
    for (let i = 0; i < 100 && !runner.get(job.id).question; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    return runner.get(job.id).question!;
  };
  const q1 = await wait();
  assertEquals(q1.recommend, "no");
  runner.answer(job.id, q1.id, false);
  const q2 = await wait();
  assertEquals(q2.text, "Send?");
  assertEquals(q2.recommend, undefined);
  runner.answer(job.id, q2.id, true);
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(runner.get(job.id).exitCode, 0);
});
