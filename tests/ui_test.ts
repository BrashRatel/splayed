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
    dataDir: string;
  }) => Promise<void>,
  fundedDescriptor = SRC_DESC,
) {
  const btc = fakeChain("btc", 975_000);
  const xbt = fakeChain("xbt", 970_000);
  const ecx = fakeChain("ecx", 974_500);
  const a = parseDescriptor(fundedDescriptor).branches[0].derive(0);
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
    await fn({ base, token: ui.token, port: ui.port, api, runJob, chains, dataDir });
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
    // It is a refusal, not a typing mistake: exit 1 and just the reason, no usage text.
    const same = await runJob(["donor", "import", SRC_DESC]);
    assertEquals(same.exitCode, 1, same.text);
    assert(same.text.includes("already in your main wallet"), same.text);
    assert(!same.text.includes("Usage:"), same.text);
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

Deno.test("UI plans: a written, unsent fee bump shows on the original, and no second one is written", async () => {
  await withUi(async ({ runJob, api }) => {
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
    const dl = await api(
      `/api/plans/${p.id}/download?file=${encodeURIComponent(t.file)}&format=binary`,
    );
    const tx = Transaction.fromPSBT(new Uint8Array(await dl.arrayBuffer()));
    tx.signIdx(SOURCE.derive("m/84'/0'/0'/0/0").privateKey!, 0);
    const up = await api(`/api/plans/${p.id}/upload`, {
      method: "POST",
      body: JSON.stringify({ file: t.file, content: base64.encode(tx.toPSBT()) }),
    });
    await up.body?.cancel();
    assertEquals((await runJob(["verify", p.id])).exitCode, 0);
    assertEquals((await runJob(["broadcast", p.id], [true])).exitCode, 0);
    const bump = await runJob(["bump", p.id, "--fee-rate", "ecx=6"], [true]);
    assertEquals(bump.exitCode, 0, bump.text);
    const original = (await (await api("/api/plans")).json()).plans
      .find((x: { id: string }) => x.id === p.id).transactions[0];
    assertEquals(original.progress.pendingBump?.plan, `${p.id}-bump1`);
    assert(original.vsize > 0, "vsize for the bump prompt's minimum");
    const again = await runJob(["bump", p.id, "--fee-rate", "ecx=8"], [true]);
    assertEquals(again.exitCode, 1, again.text);
    assert(again.text.includes("already replaces it and is not sent yet"), again.text);
    const ids = (await (await api("/api/plans")).json()).plans.map((x: { id: string }) => x.id);
    assert(!ids.includes(`${p.id}-bump2`), ids.join(" "));
  });
});

Deno.test("UI status: shared coins that turn up on a rescan are exposed, with their plans", async () => {
  await withUi(async ({ runJob, api, chains }) => {
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    assertEquals((await runJob(["import", SRC_DESC])).exitCode, 0);
    assertEquals((await runJob(["scan"])).exitCode, 0);
    const status = async () => (await (await api("/api/status")).json()).scan;
    assertEquals((await status()).newShared, []);
    // A pre-fork coin turns up on a second address, on all three chains.
    const b = parseDescriptor(SRC_DESC).branches[0].derive(1);
    const id = fund([chains.btc, chains.xbt, chains.ecx], [{ ...b, value: 50_000 }], 900_000, 2);
    const rescan = await runJob(["scan"]);
    assertEquals(rescan.exitCode, 0, rescan.text);
    assert(rescan.text.includes("NEW SHARED COINS"), rescan.text);
    const s = await status();
    assertEquals(s.newShared.length, 1);
    const fresh = s.newShared[0];
    assertEquals([fresh.txid, fresh.vout, fresh.value], [id, 0, 50_000]);
    assertEquals(fresh.unspentOn, ["btc", "xbt", "ecx"]);
    assertEquals(fresh.previously, "absent");
    assertEquals(fresh.firstSeen, s.scannedAt);
    assertEquals(fresh.plannedIn, []);
    // Once a plan spends it, the status says which one (the coin is still shared until broadcast).
    assertEquals((await runJob(["dest", "set", "ecx", ECX_DEST])).exitCode, 0);
    const plan = await runJob(["plan", "--chains", "ecx", "--fee-rate", "ecx=2"], [true]);
    assertEquals(plan.exitCode, 0, plan.text);
    const planId = (await (await api("/api/plans")).json()).plans[0].id;
    assertEquals((await status()).newShared[0].plannedIn, [planId]);
    assertEquals((await status()).newShared[0].broadcastIn, []);
    // Archived plans don't count.
    assertEquals((await runJob(["plans", "archive", planId])).exitCode, 0);
    assertEquals((await status()).newShared[0].plannedIn, []);
  });
});

Deno.test("UI plan form: --coin plans only the picked coins; status says which plan has each", async () => {
  const { saveProgress } = await import("../src/core/execute.ts");
  await withUi(async ({ runJob, api, chains, dataDir }) => {
    const all = [chains.btc, chains.xbt, chains.ecx];
    const branch = parseDescriptor(SRC_DESC).branches[0];
    const b = fund(all, [{ ...branch.derive(1), value: 50_000 }], 900_000, 2);
    const c = fund(all, [{ ...branch.derive(2), value: 70_000 }], 900_000, 3);
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    assertEquals((await runJob(["import", SRC_DESC])).exitCode, 0);
    assertEquals((await runJob(["scan"])).exitCode, 0);
    assertEquals((await runJob(["dest", "set", "ecx", ECX_DEST])).exitCode, 0);
    const status = async () => {
      const s = (await (await api("/api/status")).json()).scan;
      return new Map<string, { plannedIn: string[]; broadcastIn: string[]; value: number }>(
        s.coins.map((x: { txid: string; vout: number }) => [`${x.txid}:${x.vout}`, x]),
      );
    };
    const before = await status();
    assertEquals(before.size, 3);
    for (const coin of before.values()) {
      assertEquals([coin.plannedIn, coin.broadcastIn], [[], []]);
    }
    const first = [...before.keys()].find((k) => ![`${b}:0`, `${c}:0`].includes(k))!;
    const inputsOf = async (id: string) => {
      const plan = JSON.parse(await Deno.readTextFile(`${dataDir}/plans/${id}/plan.json`));
      return plan.transactions.flatMap((t: { inputs: { txid: string; vout: number }[] }) =>
        t.inputs.map((i) => `${i.txid}:${i.vout}`)
      ).sort();
    };

    // One picked coin: the plan spends only it.
    const one = await runJob(
      ["plan", "--chains", "ecx", "--fee-rate", "ecx=2", "--coin", `${b}:0`],
      [true],
    );
    assertEquals(one.exitCode, 0, one.text);
    const id1 = (await (await api("/api/plans")).json()).plans[0].id;
    assertEquals(await inputsOf(id1), [`${b}:0`]);
    let s = await status();
    assertEquals(s.get(`${b}:0`)!.plannedIn, [id1]);
    assertEquals(s.get(`${b}:0`)!.broadcastIn, []);
    assertEquals(s.get(`${c}:0`)!.plannedIn, []);
    assertEquals(s.get(first)!.plannedIn, []);

    // Two picked coins, batched together: exactly those two, never the planned one.
    const two = await runJob(
      [
        "plan",
        "--chains",
        "ecx",
        "--batch",
        "all",
        "--fee-rate",
        "ecx=2",
        "--coin",
        first,
        "--coin",
        `${c}:0`,
      ],
      [true],
    );
    assertEquals(two.exitCode, 0, two.text);
    const id2 = (await (await api("/api/plans")).json()).plans[0].id;
    assert(id2 !== id1);
    assertEquals(await inputsOf(id2), [first, `${c}:0`].sort());
    s = await status();
    assertEquals(s.get(first)!.plannedIn, [id2]);
    assertEquals(s.get(`${c}:0`)!.plannedIn, [id2]);
    assertEquals(s.get(`${b}:0`)!.plannedIn, [id1]);
    // The same coin in two plans: newest first.
    const again = await runJob(
      ["plan", "--chains", "ecx", "--fee-rate", "ecx=3", "--coin", `${b}:0`],
      [true],
    );
    assertEquals(again.exitCode, 0, again.text);
    const id3 = (await (await api("/api/plans")).json()).plans[0].id;
    assertEquals((await status()).get(`${b}:0`)!.plannedIn, [id3, id1]);

    // A sent transaction marks its plan as broadcast for that coin.
    const plan1 = JSON.parse(await Deno.readTextFile(`${dataDir}/plans/${id1}/plan.json`));
    await saveProgress(`${dataDir}/plans/${id1}`, {
      version: 1,
      txs: {
        [plan1.transactions[0].file]: {
          broadcast: { status: "accepted", at: "2026-11-02T00:00:00Z", backend: "x", attempts: 1 },
        },
      },
    });
    s = await status();
    assertEquals(s.get(`${b}:0`)!.plannedIn, [id3, id1]);
    assertEquals(s.get(`${b}:0`)!.broadcastIn, [id1]);
    assertEquals(s.get(`${c}:0`)!.broadcastIn, []);

    // Archived plans don't count.
    assertEquals((await runJob(["plans", "archive", id2])).exitCode, 0);
    s = await status();
    assertEquals(s.get(first)!.plannedIn, []);
    assertEquals(s.get(`${c}:0`)!.plannedIn, []);
  });
});

Deno.test("UI jobs: room for one --coin per picked coin, but still a limit", async () => {
  await withUi(async ({ api, runJob }) => {
    const coins = (n: number) =>
      Array.from({ length: n }, (_, i) => ["--coin", `${"ab".repeat(32)}:${i}`]).flat();
    const tooMany = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ args: ["plan", ...coins(256)] }),
    });
    assertEquals(tooMany.status, 400);
    assert((await tooMany.json()).error.includes("at most 512"));
    // 250 coins fit (the form's own cap): the command runs, and stops only for lack of setup.
    const fits = await runJob([
      "plan",
      "--chains",
      "ecx,xbt",
      "--xbt-signer",
      "knots",
      ...coins(250),
    ]);
    assert(fits.exitCode !== 0);
    assert(!fits.text.includes("at most"), fits.text);
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

const THIRD = seed("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong");
const cosigner = (k: HDKey) =>
  `[${fp(k)}/48h/0h/0h/2h]${k.derive("m/48'/0'/0'/2'").publicExtendedKey}/<0;1>/*`;
const MULTISIG_DESC = `wsh(sortedmulti(2,${cosigner(SOURCE)},${cosigner(OTHER)},${
  cosigner(THIRD)
}))`;

Deno.test("UI multisig: each cosigner uploads their own signature; they are merged, then verify", async () => {
  await withUi(async ({ runJob, api }) => {
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    assertEquals((await runJob(["import", MULTISIG_DESC])).exitCode, 0);
    assertEquals((await runJob(["scan"])).exitCode, 0);
    assertEquals((await runJob(["dest", "set", "ecx", ECX_DEST])).exitCode, 0);
    const plan = await runJob(["plan", "--chains", "ecx", "--fee-rate", "ecx=2"], [true]);
    assertEquals(plan.exitCode, 0, plan.text);
    const p = (await (await api("/api/plans")).json()).plans[0];
    const t = p.transactions[0];
    // Every cosigner signs the SAME unsigned PSBT, separately, and uploads only their own file.
    const signWith = async (k: HDKey) => {
      const dl = await api(
        `/api/plans/${p.id}/download?file=${encodeURIComponent(t.file)}&format=binary`,
      );
      const tx = Transaction.fromPSBT(new Uint8Array(await dl.arrayBuffer()));
      tx.signIdx(k.derive("m/48'/0'/0'/2'/0/0").privateKey!, 0);
      return base64.encode(tx.toPSBT());
    };
    const upload = async (content: string) => {
      const r = await api(`/api/plans/${p.id}/upload`, {
        method: "POST",
        body: JSON.stringify({ file: t.file, content }),
      });
      assertEquals(r.status, 200);
      return await r.json();
    };
    const first = await upload(await signWith(SOURCE));
    assertEquals(first.signatures, { have: 1, need: 2 });
    // One of two is not enough: verify refuses and says so.
    const early = await runJob(["verify", p.id]);
    assertEquals(early.exitCode, 1, early.text);
    assert(early.text.includes("1 of 2 required signature"), early.text);
    let seen = (await (await api("/api/plans")).json()).plans[0].transactions[0];
    assertEquals(seen.signedUpload.signatures, { have: 1, need: 2 });
    // The same cosigner again changes nothing; the second cosigner completes it.
    assertEquals((await upload(await signWith(SOURCE))).signatures, { have: 1, need: 2 });
    assertEquals((await upload(await signWith(THIRD))).signatures, { have: 2, need: 2 });
    seen = (await (await api("/api/plans")).json()).plans[0].transactions[0];
    assertEquals(seen.signedUpload.signatures, { have: 2, need: 2 });
    const done = await runJob(["verify", p.id]);
    assertEquals(done.exitCode, 0, done.text);
  }, MULTISIG_DESC);
});

Deno.test("CLI multisig: two cosigners' separate signed files for one transaction verify together", async () => {
  await withUi(async ({ runJob, api, dataDir }) => {
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    assertEquals((await runJob(["import", MULTISIG_DESC])).exitCode, 0);
    assertEquals((await runJob(["scan"])).exitCode, 0);
    assertEquals((await runJob(["dest", "set", "ecx", ECX_DEST])).exitCode, 0);
    assertEquals(
      (await runJob(["plan", "--chains", "ecx", "--fee-rate", "ecx=2"], [true])).exitCode,
      0,
    );
    const p = (await (await api("/api/plans")).json()).plans[0];
    const t = p.transactions[0];
    const unsigned = base64.decode(
      (await Deno.readTextFile(`${dataDir}/plans/${p.id}/${t.file}`)).trim(),
    );
    const signTo = async (name: string, k: HDKey) => {
      const tx = Transaction.fromPSBT(unsigned);
      tx.signIdx(k.derive("m/48'/0'/0'/2'/0/0").privateKey!, 0);
      await Deno.writeFile(`${dataDir}/plans/${p.id}/ecx/${name}.signed.psbt`, tx.toPSBT());
    };
    await signTo("cosigner-a", SOURCE);
    const one = await runJob(["verify", p.id]);
    assertEquals(one.exitCode, 1, one.text);
    await signTo("cosigner-b", OTHER);
    const both = await runJob(["verify", p.id]);
    assertEquals(both.exitCode, 0, both.text);
  }, MULTISIG_DESC);
});

Deno.test("UI multisig 3-of-5: built from five cosigner keys, detected as 3 of 5, signed by cosigners 2, 4 and 5", async () => {
  const keys = [1, 2, 3, 4, 5].map((n) => HDKey.fromMasterSeed(new Uint8Array(32).fill(n)));
  const walletKey = (k: HDKey) => ({
    fingerprint: fp(k),
    path: "48h/0h/0h/2h",
    xpub: k.derive("m/48'/0'/0'/2'").publicExtendedKey,
  });
  // The wallet builder the QR import uses (threshold and keys), not a pasted descriptor.
  let built = "";
  await withUi(async ({ api }) => {
    const preview = await api("/api/wallet/preview", {
      method: "POST",
      body: JSON.stringify({
        mode: "multisig",
        script: "wsh",
        threshold: 3,
        sorted: true,
        keys: keys.map(walletKey),
      }),
    });
    assertEquals(preview.status, 200, await preview.clone().text());
    const pv = await preview.json();
    assert(pv.descriptor.startsWith("wsh(sortedmulti(3,"), pv.descriptor);
    assertEquals(pv.branches, 2);
    built = pv.descriptor;
  });
  await withUi(async ({ runJob, api }) => {
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    assertEquals((await runJob(["import", built])).exitCode, 0);
    assertEquals((await runJob(["scan"])).exitCode, 0);
    assertEquals((await runJob(["dest", "set", "ecx", ECX_DEST])).exitCode, 0);
    assertEquals(
      (await runJob(["plan", "--chains", "ecx", "--fee-rate", "ecx=2"], [true])).exitCode,
      0,
    );
    const p = (await (await api("/api/plans")).json()).plans[0];
    const t = p.transactions[0];
    const signAndUpload = async (k: HDKey) => {
      const dl = await api(
        `/api/plans/${p.id}/download?file=${encodeURIComponent(t.file)}&format=binary`,
      );
      const tx = Transaction.fromPSBT(new Uint8Array(await dl.arrayBuffer()));
      tx.signIdx(k.derive("m/48'/0'/0'/2'/0/0").privateKey!, 0);
      const r = await api(`/api/plans/${p.id}/upload`, {
        method: "POST",
        body: JSON.stringify({ file: t.file, content: base64.encode(tx.toPSBT()) }),
      });
      assertEquals(r.status, 200);
      return (await r.json()).signatures;
    };
    // Cosigners 5, 2, then 4: out of script order, and the count never reaches 3 before the third.
    assertEquals(await signAndUpload(keys[4]), { have: 1, need: 3 });
    const one = await runJob(["verify", p.id]);
    assertEquals(one.exitCode, 1, one.text);
    assert(one.text.includes("1 of 3 required signature"), one.text);
    assertEquals(await signAndUpload(keys[1]), { have: 2, need: 3 });
    const two = await runJob(["verify", p.id]);
    assertEquals(two.exitCode, 1, two.text);
    assert(two.text.includes("2 of 3 required signature"), two.text);
    assertEquals(await signAndUpload(keys[3]), { have: 3, need: 3 });
    const seen = (await (await api("/api/plans")).json()).plans[0].transactions[0];
    assertEquals(seen.signedUpload.signatures, { have: 3, need: 3 });
    const done = await runJob(["verify", p.id]);
    assertEquals(done.exitCode, 0, done.text);
  }, built);
});

Deno.test("wipe: forgets wallet, scan, plans and the confirmation; keeps servers; asks first", async () => {
  await withUi(async ({ runJob, api, dataDir }) => {
    // A server the user added themselves must survive.
    assertEquals(
      (await runJob([
        "config",
        "backend",
        "add",
        "btc",
        "--kind",
        "esplora",
        "--url",
        "https://my-own-server.example/api",
      ])).exitCode,
      0,
    );
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    assertEquals((await runJob(["import", SRC_DESC])).exitCode, 0);
    assertEquals((await runJob(["scan"])).exitCode, 0);
    assertEquals((await runJob(["dest", "set", "ecx", ECX_DEST])).exitCode, 0);
    assertEquals(
      (await runJob(["plan", "--chains", "ecx", "--fee-rate", "ecx=2"], [true])).exitCode,
      0,
    );
    const before = await Deno.readTextFile(`${dataDir}/splayed.toml`);
    assert(before.includes("my-own-server.example"));
    // Saying no wipes nothing.
    const declined = await runJob(["wipe"], [false]);
    assertEquals(declined.exitCode, 1, declined.text);
    assert(declined.questions[0].includes("start over"), declined.questions[0]);
    assertEquals((await (await api("/api/overview")).json()).descriptors.length, 1);
    // Yes wipes it all.
    const done = await runJob(["wipe"], [true]);
    assertEquals(done.exitCode, 0, done.text);
    assert(done.text.includes("1 plan"), done.text);
    const overview = await (await api("/api/overview")).json();
    assertEquals(overview.descriptors.length, 0);
    assertEquals(overview.confirmed, false);
    assertEquals((await (await api("/api/plans")).json()).plans.length, 0);
    for (const f of ["watch-only.json", "scan.json", "network-confirmation.json", "plans"]) {
      let gone = false;
      try {
        await Deno.stat(`${dataDir}/${f}`);
      } catch {
        gone = true;
      }
      assert(gone, `${f} should be gone`);
    }
    // The servers and settings stay exactly as they were.
    assertEquals(await Deno.readTextFile(`${dataDir}/splayed.toml`), before);
    // Starting over works, and a second wipe finds nothing.
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    assertEquals((await runJob(["wipe"], [true])).exitCode, 0);
    assert((await runJob(["wipe"])).text.includes("Nothing to wipe"));
  });
});

Deno.test("wipe: with --yes it refuses while a sent transaction is unconfirmed, unless --force", async () => {
  await withUi(async ({ runJob, dataDir }) => {
    assertEquals((await runJob(["init"], [true, true])).exitCode, 0);
    // A plan with one transaction that was sent and has no confirmations yet.
    const dir = `${dataDir}/plans/20260101T000000000-aaaaaa`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/plan.json`,
      JSON.stringify({
        id: "20260101T000000000-aaaaaa",
        transactions: [{ file: "ecx/001-aa.psbt", chain: "ecx", order: 1, inputs: [] }],
      }),
    );
    await Deno.writeTextFile(
      `${dir}/progress.json`,
      JSON.stringify({
        version: 1,
        txs: {
          "ecx/001-aa.psbt": { broadcast: { status: "accepted", at: "2026-01-01T00:00:00Z" } },
        },
      }),
    );
    const refused = await runJob(["wipe", "--yes"]);
    assertEquals(refused.exitCode, 1, refused.text);
    assert(refused.text.includes("not confirmed yet"), refused.text);
    assert(refused.text.includes("Refusing to wipe"), refused.text);
    // Without --yes there is a second, separate question about it, and No keeps everything.
    const asked = await runJob(["wipe"], [true, false]);
    assertEquals(asked.exitCode, 1, asked.text);
    assertEquals(asked.questions.length, 2);
    await Deno.stat(`${dir}/plan.json`);
    // --force --yes goes ahead.
    const forced = await runJob(["wipe", "--yes", "--force"]);
    assertEquals(forced.exitCode, 0, forced.text);
  });
});
