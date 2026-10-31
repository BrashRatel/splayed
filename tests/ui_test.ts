import { assert, assertEquals } from "./assert.ts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { main } from "../src/cli/main.ts";
import { parseDescriptor } from "../src/core/descriptors.ts";
import type { ChainId } from "../src/core/profiles.ts";
import { startUi } from "../src/ui/server.ts";
import { type FakeChain, fakeChain, FakeEsploraTransport, fund } from "./fakes.ts";

const seed = (w: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(w));
const SOURCE = seed(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const OTHER = seed("legal winner thank year wave sausage worth useful legal winner thank yellow");
const fp = (k: HDKey) => k.fingerprint.toString(16).padStart(8, "0");
const SRC_DESC = `wpkh([${fp(SOURCE)}/84h/0h/0h]${
  SOURCE.derive("m/84'/0'/0'").publicExtendedKey
}/<0;1>/*)`;
const ECX_DEST = `wpkh([${fp(OTHER)}/84h/0h/0h]${
  OTHER.derive("m/84'/0'/0'").publicExtendedKey
}/0/*)`;

async function withUi(
  fn: (ctx: {
    base: string;
    token: string;
    port: number;
    api: (path: string, init?: RequestInit) => Promise<Response>;
    runJob: (
      args: string[],
      answers?: boolean[],
    ) => Promise<{ exitCode: number; text: string; questions: string[] }>;
    chains: Record<ChainId, FakeChain>;
  }) => Promise<void>,
) {
  const btc = fakeChain("btc", 975_000);
  const xbt = fakeChain("xbt", 970_000);
  const ecx = fakeChain("ecx", 974_500);
  const a = parseDescriptor(SRC_DESC).branches[0].derive(0);
  fund([btc, xbt, ecx], [{ ...a, value: 100_000 }], 900_000, 1);
  const chains = { btc, xbt, ecx };
  const dataDir = await Deno.makeTempDir({ prefix: "forksplit-ui-" });
  await Deno.writeTextFile(
    `${dataDir}/forksplit.toml`,
    "[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n",
  );
  const ui = startUi({
    dataDir,
    run: main,
    baseIO: {
      env: {},
      tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
      transportFactory: (_c, chain) => new FakeEsploraTransport(chains[chain]),
    },
  });
  const base = `http://127.0.0.1:${ui.port}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${ui.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> ?? {}),
      },
    });
  const runJob = async (args: string[], answers: boolean[] = []) => {
    const start = await api("/api/run", { method: "POST", body: JSON.stringify({ args }) });
    assertEquals(start.status, 200, await start.clone().text());
    let job = await start.json();
    const questions: string[] = [];
    while (!job.done) {
      if (job.question) {
        questions.push(job.question.text);
        const r = await api(`/api/jobs/${job.id}/answer`, {
          method: "POST",
          body: JSON.stringify({ questionId: job.question.id, yes: answers.shift() ?? false }),
        });
        await r.body?.cancel();
      }
      await new Promise((r) => setTimeout(r, 20));
      job = await (await api(`/api/jobs/${job.id}`)).json();
    }
    return {
      exitCode: job.exitCode,
      text: job.lines.map((l: { text: string }) => l.text).join("\n"),
      questions,
    };
  };
  try {
    await fn({ base, token: ui.token, port: ui.port, api, runJob, chains });
  } finally {
    await ui.server.shutdown();
  }
}

Deno.test("UI security: token, host, content type, origin, static headers", async () => {
  await withUi(async ({ base, port, api }) => {
    const noToken = await fetch(`${base}/api/overview`);
    assertEquals(noToken.status, 401);
    await noToken.body?.cancel();
    const page = await fetch(`${base}/`);
    assertEquals(page.status, 200);
    assert(page.headers.get("content-security-policy")?.includes("script-src 'self'"));
    assertEquals(page.headers.get("x-frame-options"), "DENY");
    await page.body?.cancel();
    const missing = await fetch(`${base}/../forksplit.toml`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
    const textPost = await api("/api/run", {
      method: "POST",
      body: "x",
      headers: { "Content-Type": "text/plain" },
    });
    assertEquals(textPost.status, 415);
    await textPost.body?.cancel();
    const crossOrigin = await api("/api/run", {
      method: "POST",
      body: "{}",
      headers: { Origin: "http://evil.example" },
    });
    assertEquals(crossOrigin.status, 403);
    await crossOrigin.body?.cancel();
    // DNS rebinding: a request naming another host is refused before anything else.
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    await conn.write(
      new TextEncoder().encode("GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"),
    );
    const buf = new Uint8Array(256);
    const n = await conn.read(buf);
    conn.close();
    assert(new TextDecoder().decode(buf.subarray(0, n ?? 0)).startsWith("HTTP/1.1 403"));
  });
});

Deno.test("UI jobs: only CLI commands, no global overrides, no nested ui", async () => {
  await withUi(async ({ api }) => {
    for (
      const args of [
        ["ui"],
        ["--data-dir", "/tmp", "scan"],
        ["scan", "--tor-socks", "1.2.3.4:9050"],
        ["rm"],
        [],
      ]
    ) {
      const r = await api("/api/run", { method: "POST", body: JSON.stringify({ args }) });
      assertEquals(r.status, 400, JSON.stringify(args));
      await r.body?.cancel();
    }
  });
});

Deno.test("UI: init asks both questions through the browser; declining the first contacts nothing", async () => {
  await withUi(async ({ runJob, api, chains }) => {
    const declined = await runJob(["init"], [false]);
    assertEquals(declined.exitCode, 1);
    assertEquals(declined.questions.length, 1);
    assertEquals(chains.btc.requests.length, 0);
    const ok = await runJob(["init"], [true, true]);
    assertEquals(ok.exitCode, 0, ok.text);
    assertEquals(ok.questions.length, 2);
    const overview = await (await api("/api/overview")).json();
    assertEquals(overview.confirmed, true);
    assertEquals(overview.chains[0].backends[0].privacyClass, "tor");
  });
});

Deno.test("UI end to end: plan, download PSBT, upload signed file, verify", async () => {
  await withUi(async ({ runJob, api }) => {
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    assertEquals((await runJob(["import", SRC_DESC])).exitCode, 0);
    assertEquals((await runJob(["scan"])).exitCode, 0);
    assertEquals((await runJob(["dest", "set", "ecx", ECX_DEST])).exitCode, 0);
    const plan = await runJob(["plan", "--chains", "ecx", "--fee-rate", "ecx=2"], [true]);
    assertEquals(plan.exitCode, 0, plan.text);
    const { plans } = await (await api("/api/plans")).json();
    const p = plans[0];
    const t = p.transactions[0];
    // Download the unsigned PSBT as a binary file, sign it like any wallet would, upload it.
    const dl = await api(
      `/api/plans/${p.id}/download?file=${encodeURIComponent(t.file)}&format=binary`,
    );
    assertEquals(dl.status, 200);
    const tx = Transaction.fromPSBT(new Uint8Array(await dl.arrayBuffer()));
    tx.signIdx(SOURCE.derive("m/84'/0'/0'/0/0").privateKey!, 0);
    const up = await api(`/api/plans/${p.id}/upload`, {
      method: "POST",
      body: JSON.stringify({ file: t.file, content: base64.encode(tx.toPSBT()) }),
    });
    assertEquals(up.status, 200, await up.clone().text());
    await up.body?.cancel();
    // The plans view reports that the signed file arrived, before anything is verified.
    const seen = (await (await api("/api/plans")).json()).plans[0].transactions[0];
    assert(seen.signedUpload?.name.includes(".signed."), JSON.stringify(seen.signedUpload));
    // The mining endpoints exist only in test environments.
    assertEquals(await (await api("/api/dev")).json(), { enabled: false });
    const noDev = await api("/api/dev/mine", {
      method: "POST",
      body: JSON.stringify({ chain: "ecx", blocks: 1 }),
    });
    assertEquals(noDev.status, 404);
    await noDev.body?.cancel();
    // Garbage uploads are refused.
    const bad = await api(`/api/plans/${p.id}/upload`, {
      method: "POST",
      body: JSON.stringify({
        file: t.file,
        content: base64.encode(new TextEncoder().encode("hello")),
      }),
    });
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
    // Only files that belong to the plan can be downloaded.
    const escape = await api(
      `/api/plans/${p.id}/download?file=${encodeURIComponent("../../forksplit.toml")}`,
    );
    assertEquals(escape.status, 404);
    await escape.body?.cancel();
    const verify = await runJob(["verify", p.id]);
    assertEquals(verify.exitCode, 0, verify.text);
    assert(verify.text.includes("VERIFIED"));
    const after = (await (await api("/api/plans")).json()).plans[0];
    assert(after.transactions[0].progress.verified);
    // Fee bump is reachable from the UI; nothing is broadcast, so there is nothing to replace.
    const bump = await runJob(["bump", p.id, "--yes"]);
    assertEquals(bump.exitCode, 1, bump.text);
  });
});
