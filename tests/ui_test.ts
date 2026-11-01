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
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-ui-" });
  await Deno.writeTextFile(
    `${dataDir}/splayed.toml`,
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
    const missing = await fetch(`${base}/../splayed.toml`);
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
    // The donor view starts empty, and a donor wallet imported from the UI shows up in it.
    assertEquals(await (await api("/api/donors")).json(), { descriptors: [], scan: null });
    // The main wallet's own descriptor is refused as a donor wallet.
    const same = await runJob(["donor", "import", SRC_DESC]);
    assertEquals(same.exitCode, 2, same.text);
    const donorJob = await runJob(["donor", "import", ECX_DEST]);
    assertEquals(donorJob.exitCode, 0, donorJob.text);
    const donorView = await (await api("/api/donors")).json();
    assertEquals(donorView.descriptors.length, 1);
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
      `/api/plans/${p.id}/download?file=${encodeURIComponent("../../splayed.toml")}`,
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

Deno.test("UI QR: the PSBT goes out as UR frames and the signed one comes back by scanning", async () => {
  const { URDecoder, psbtFromUr, psbtToUr } = await import("../src/core/ur.ts");
  await withUi(async ({ runJob, api, base }) => {
    for (const path of ["/qr.js", "/vendor/qrcode.js", "/vendor/jsQR.js"]) {
      const res = await fetch(`${base}${path}`);
      assertEquals(res.status, 200, path);
      assert(res.headers.get("content-type")?.startsWith("text/javascript"), path);
      await res.body?.cancel();
    }
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    assertEquals((await runJob(["import", SRC_DESC])).exitCode, 0);
    assertEquals((await runJob(["scan"])).exitCode, 0);
    assertEquals((await runJob(["dest", "set", "ecx", ECX_DEST])).exitCode, 0);
    assertEquals(
      (await runJob(["plan", "--chains", "ecx", "--fee-rate", "ecx=2"], [true])).exitCode,
      0,
    );
    const p = (await (await api("/api/plans")).json()).plans[0];
    const t = p.transactions[0];
    const qrUrl = `/api/plans/${p.id}/qr`;

    // Export: the frames decode (as the signer would) to exactly the plan's PSBT.
    const out = await (await api(`${qrUrl}?file=${encodeURIComponent(t.file)}&size=60`)).json();
    assertEquals(out.type, "crypto-psbt");
    assert(out.frames.length > 1, "a PSBT with a previous transaction needs several frames");
    const signerSide = new URDecoder();
    for (const f of out.frames) if (!signerSide.isComplete) signerSide.receive(f);
    const unsigned = psbtFromUr(signerSide);
    const planned = base64.decode(
      (await (await api(`/api/plans/${p.id}/download?file=${encodeURIComponent(t.file)}`)).text())
        .trim(),
    );
    assertEquals(base64.encode(unsigned), base64.encode(planned));

    // The signer signs and plays its own animation back; the camera misses frames and sees one
    // twice, reads one wrongly, and starts in the middle.
    const tx = Transaction.fromPSBT(unsigned);
    tx.signIdx(SOURCE.derive("m/84'/0'/0'/0/0").privateKey!, 0);
    const signed = tx.toPSBT();
    const animation = psbtToUr(signed, 70).frames;
    assert(animation.length > 2);
    const scanned = [
      ...animation.slice(2),
      animation[3],
      animation[1].replace(/.{2}$/u, "zz"), // a misread frame fails its checksum
      ...animation.slice(0, 2),
    ];
    let done: { complete: boolean; saved?: string; rejected?: number } = { complete: false };
    for (let i = 0; i < scanned.length && !done.complete; i += 3) {
      const r = await api(qrUrl, {
        method: "POST",
        body: JSON.stringify({ file: t.file, frames: scanned.slice(i, i + 3) }),
      });
      assertEquals(r.status, 200);
      done = await r.json();
    }
    assert(done.complete, JSON.stringify(done));
    assert(done.saved?.includes("uploads/") && done.saved.endsWith(".signed.psbt"));

    // The scanned file is the signed PSBT and verifies like an uploaded one.
    const verify = await runJob(["verify", p.id]);
    assertEquals(verify.exitCode, 0, verify.text);
    assert(verify.text.includes("VERIFIED"));

    // Garbage and wrong transfers don't save anything or crash.
    const junk = await (await api(qrUrl, {
      method: "POST",
      body: JSON.stringify({ file: t.file, reset: true, frames: ["hello", "ur:crypto-psbt/zzzz"] }),
    })).json();
    assertEquals(junk.complete, false);
    assertEquals(junk.rejected, 2);
    const tooMany = await api(qrUrl, {
      method: "POST",
      body: JSON.stringify({ file: t.file, frames: new Array(300).fill("x") }),
    });
    assertEquals(tooMany.status, 400);
    await tooMany.body?.cancel();
    const notOurs = await api(`${qrUrl}?file=${encodeURIComponent("../../etc/passwd")}`);
    assertEquals(notOurs.status, 404);
    await notOurs.body?.cancel();
  });
});

Deno.test("UI QR: the vendored libraries are the pinned ones and a drawn frame reads back", async () => {
  const dir = "src/ui/static/vendor";
  for (const line of (await Deno.readTextFile(`${dir}/SHA256SUMS`)).trim().split("\n")) {
    const [sum, name] = line.split(/\s+/u);
    const bytes = await Deno.readFile(`${dir}/${name}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    assertEquals(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""), sum, name);
  }
  // Draw a UR frame exactly as qr.js does, then read it like the camera path does.
  const load = async (name: string) => {
    const module = { exports: {} as unknown };
    new Function("module", "exports", await Deno.readTextFile(`${dir}/${name}`))(
      module,
      module.exports,
    );
    return module.exports as never;
  };
  type QrFactory = (type: number, level: string) => {
    addData(s: string, mode: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(r: number, c: number): boolean;
  };
  const qrcode = await load("qrcode.js") as QrFactory;
  const jsQR = await load("jsQR.js") as (
    data: Uint8ClampedArray,
    w: number,
    h: number,
  ) => { data: string } | null;
  const { psbtToUr } = await import("../src/core/ur.ts");
  const frame = psbtToUr(new Uint8Array(400).map((_, i) => i & 255), 100).frames[1];
  const qr = qrcode(0, "L");
  qr.addData(frame.toUpperCase(), "Alphanumeric");
  qr.make();
  const n = qr.getModuleCount();
  const cell = 4;
  const quiet = 4;
  const size = (n + quiet * 2) * cell;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const at = ((r + quiet) * cell + y) * size * 4 + ((c + quiet) * cell + x) * 4;
          rgba[at] = rgba[at + 1] = rgba[at + 2] = 0;
        }
      }
    }
  }
  assertEquals(jsQR(rgba, size, size)?.data, frame.toUpperCase());
});
