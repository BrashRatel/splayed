/**
 * Local web UI. Loopback only, random port, and a random capability token delivered in the URL
 * fragment (never sent in requests except as a header). Every action runs through JobRunner, i.e.
 * the CLI itself; the read-only views below just read the data directory.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base64 } from "@scure/base";
import { type CliIO, describeTor } from "../cli/main.ts";
import { privacyLevel } from "../cli/format.ts";
import { type Config, loadConfig, networkConfirmed, routeForBackend } from "../core/config.ts";
import { networkForProfile, parseDescriptor } from "../core/descriptors.ts";
import { findSignedFiles, loadPlanDir, loadProgress, readSignedArtifact } from "../core/execute.ts";
import { type Plan, PLANS_DIR, XBT_SIGNERS } from "../core/planner.ts";
import { CHAIN_IDS, CHAIN_NAMES, type ChainId } from "../core/profiles.ts";
import { loadDonorScan } from "../core/donors.ts";
import { loadScan } from "../core/scan.ts";
import { classify } from "../core/state.ts";
import { ensureDir } from "../core/store.ts";
import { loadWallet } from "../core/wallet.ts";
import { describeRoute } from "../net/transport.ts";
import { torManager } from "../net/tor.ts";
import { JobError, JobRunner } from "./jobs.ts";

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const MAX_BODY = 4 * 1024 * 1024;

export function createToken(): string {
  return base64.encode(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/gu, "-").replace(
    /\//gu,
    "_",
  )
    .replace(/=+$/u, "");
}

export function constantTimeEqual(a: string | null, b: string): boolean {
  if (a === null || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < b.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY) throw new JobError("Request too large", 413);
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new JobError("Body must be JSON");
  }
}

// ---- Read-only views ----

async function overview(dataDir: string, env: Record<string, string | undefined>) {
  let config: Config;
  try {
    config = await loadConfig({ dataDir, env });
  } catch (error) {
    return { dataDir, configError: (error as Error).message };
  }
  const wallet = await loadWallet(dataDir);
  const scan = await loadScan(dataDir);
  const chains = CHAIN_IDS.map((chain) => {
    const cc = config.chains[chain];
    return {
      chain,
      name: CHAIN_NAMES[chain],
      confirmations: cc.confirmations,
      minConfirmations: config.profile.chains[chain].minConfirmations,
      clearnetOptIn: cc.clearnetOptIn,
      backends: cc.backends.map((b) => {
        const route = routeForBackend(config, chain, b);
        return {
          kind: b.kind,
          url: b.url,
          role: b.role,
          priority: b.priority,
          label: b.label,
          origin: b.origin,
          privacy: privacyLevel(b, route),
          privacyClass: route.via === "direct"
            ? (route.hostClass === "public" ? "clearnet" : "local")
            : "tor",
          route: describeRoute(route),
        };
      }),
      fallbacks: config.profile.chains[chain].defaultBackends
        .filter((d) => d.tier === "fallback" && !cc.backends.some((b) => b.url === d.url))
        .map((d) => d.url),
    };
  });
  const descriptors = wallet.descriptors.map((d, i) => {
    const parsed = parseDescriptor(d.descriptor, networkForProfile(config.profile));
    return {
      number: i + 1,
      label: d.label,
      descriptor: d.descriptor,
      firstAddresses: parsed.branches.map((b) => b.derive(0).address),
    };
  });
  const destinations: Record<string, unknown> = {};
  for (const chain of ["btc", "ecx", "xbt"] as const) {
    const d = wallet.destinations?.[chain];
    if (d) {
      destinations[chain] = {
        descriptor: d.descriptor,
        nextIndex: d.nextIndex,
        nextAddress: parseDescriptor(d.descriptor, networkForProfile(config.profile)).branches[0]
          .derive(d.nextIndex).address,
      };
    }
  }
  return {
    dataDir,
    profile: config.profile.id,
    confirmed: await networkConfirmed(config),
    tor: {
      mode: config.tor.mode,
      socks: config.tor.socks,
      description: describeTor(config),
      status: torManager.status,
    },
    chains,
    descriptors,
    destinations,
    xbtSigners: XBT_SIGNERS,
    scan: scan
      ? { scannedAt: scan.scannedAt, coins: scan.coins.length, warnings: scan.warnings }
      : null,
  };
}

async function statusView(dataDir: string, env: Record<string, string | undefined>) {
  const config = await loadConfig({ dataDir, env });
  const scan = await loadScan(dataDir);
  if (!scan) return { scan: null };
  const ctx = {
    tips: scan.tips,
    confirmations: Object.fromEntries(
      CHAIN_IDS.map((c) => [c, config.chains[c].confirmations]),
    ) as Record<
      ChainId,
      number
    >,
  };
  return {
    scan: {
      scannedAt: scan.scannedAt,
      tips: scan.tips,
      addressesRevealed: scan.addressesRevealed,
      warnings: scan.warnings,
      coins: scan.coins.map((c) => ({ ...c, classification: classify(c, ctx) })),
    },
  };
}

async function plansView(dataDir: string) {
  const dir = join(dataDir, PLANS_DIR);
  const ids: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isDirectory) ids.push(e.name);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  ids.sort().reverse();
  const out = [];
  for (const id of ids) {
    try {
      const { dir: planDir, plan } = await loadPlanDir(dataDir, id);
      const progress = await loadProgress(planDir);
      const signedFiles = await findSignedFiles(planDir);
      const uploaded = async (file: string) => {
        const stem = file.replace("/", "-").replace(/\.psbt$/u, "");
        for (const kind of ["psbt", "hex"]) {
          try {
            const st = await Deno.stat(join(planDir, "uploads", `${stem}.signed.${kind}`));
            return { name: `${stem}.signed.${kind}`, at: st.mtime?.toISOString() };
          } catch { /* not uploaded */ }
        }
        return undefined;
      };
      const uploads = new Map(
        await Promise.all(
          plan.transactions.map(async (t) => [t.file, await uploaded(t.file)] as const),
        ),
      );
      out.push({
        id,
        createdAt: plan.createdAt,
        route: plan.route,
        xbtSigner: plan.xbtSigner,
        warnings: plan.warnings,
        signedFiles: signedFiles.map((f) => f.slice(planDir.length + 1)),
        transactions: plan.transactions.map((t) => ({
          file: t.file,
          chain: t.chain,
          order: t.order,
          testFirst: t.testFirst,
          inputs: t.inputs.length,
          value: t.inputs.reduce((s, i) => s + i.value, 0),
          fee: t.fee,
          feeRate: t.feeRate,
          output: t.output,
          outputs: t.outputs?.length,
          donor: t.donor,
          gate: t.gate,
          signedUpload: uploads.get(t.file),
          progress: {
            verified: progress.txs[t.file]?.verified
              ? { at: progress.txs[t.file].verified!.at, txid: progress.txs[t.file].verified!.txid }
              : undefined,
            broadcast: progress.txs[t.file]?.broadcast,
            confirmations: progress.txs[t.file]?.confirmations,
            reorgs: progress.txs[t.file]?.reorgs,
            replacedBy: progress.txs[t.file]?.replacedBy,
          },
          replaces: t.replaces,
        })),
      });
    } catch { /* skip unreadable plan dirs */ }
  }
  return { plans: out };
}

function planTx(plan: Plan, file: string | null) {
  const t = plan.transactions.find((t) => t.file === file);
  if (!t) throw new JobError("No such transaction in this plan", 404);
  return t;
}

// ---- Server ----

export interface UiOptions {
  dataDir: string;
  port?: number;
  run: (argv: string[], io: CliIO) => Promise<number>;
  baseIO: Omit<CliIO, "out" | "err" | "confirm">;
  staticDir?: string;
  token?: string;
  /**
   * TEST ENVIRONMENTS ONLY (the regtest playground). Listens on every interface and answers any
   * Host name on our port, so another machine on the LAN can open it. The token is still required
   * and is sent over plain HTTP. The real `forksplit ui` never sets this.
   */
  listenOnAllInterfaces?: boolean;
  /** TEST ENVIRONMENTS ONLY: lets the page mine blocks on regtest nodes. Never set by `ui`. */
  devTools?: {
    heights(): Promise<Record<string, number>>;
    mine(chain: string, blocks: number): Promise<Record<string, number>>;
  };
}

export function startUi(
  options: UiOptions,
): { url: string; token: string; port: number; server: Deno.HttpServer } {
  const token = options.token ?? createToken();
  const staticDir = options.staticDir ?? fileURLToPath(new URL("./static/", import.meta.url));
  const jobs = new JobRunner(options.run, options.baseIO, options.dataDir);
  let port = 0;
  const env = options.baseIO.env;

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const host = req.headers.get("host");
    // DNS-rebinding defence: only our own loopback host names are answered.
    const loopbackHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    if (!loopbackHost && !(options.listenOnAllInterfaces && host?.endsWith(`:${port}`))) {
      return new Response("Forbidden", { status: 403, headers: SECURITY_HEADERS });
    }
    if (!url.pathname.startsWith("/api/")) {
      const asset = STATIC[url.pathname];
      if (!asset || req.method !== "GET") {
        return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
      }
      return new Response(await Deno.readFile(join(staticDir, asset.file)), {
        headers: { ...SECURITY_HEADERS, "Content-Type": asset.type },
      });
    }
    const auth = req.headers.get("authorization");
    if (!constantTimeEqual(auth?.replace(/^Bearer /u, "") ?? null, token)) {
      return json(
        { error: "Missing or wrong token. Open the URL printed by `forksplit ui`." },
        401,
      );
    }
    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      if (
        origin !== null && origin !== `http://127.0.0.1:${port}` &&
        origin !== `http://localhost:${port}` &&
        !(options.listenOnAllInterfaces && origin === `http://${host}`)
      ) {
        return json({ error: "Cross-origin request refused" }, 403);
      }
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
        return json({ error: "Content-Type must be application/json" }, 415);
      }
    }
    try {
      const path = url.pathname;
      let m: RegExpExecArray | null;
      if (req.method === "GET" && path === "/api/overview") {
        return json(await overview(options.dataDir, env));
      }
      if (req.method === "GET" && path === "/api/status") {
        return json(await statusView(options.dataDir, env));
      }
      if (req.method === "GET" && path === "/api/donors") {
        const wallet = await loadWallet(options.dataDir);
        return json({
          descriptors: (wallet.donors ?? []).map((d) => ({
            descriptor: d.descriptor,
            label: d.label,
            nextIndex: d.nextIndex ?? 0,
          })),
          scan: (await loadDonorScan(options.dataDir)) ?? null,
        });
      }
      if (req.method === "GET" && path === "/api/plans") {
        return json(await plansView(options.dataDir));
      }
      if (req.method === "GET" && path === "/api/tor") return json(torManager.status);
      if (path === "/api/dev" && req.method === "GET") {
        return json(
          options.devTools ? { enabled: true, heights: await options.devTools.heights() } : {
            enabled: false,
          },
        );
      }
      if (path === "/api/dev/mine" && req.method === "POST" && options.devTools) {
        const body = await readBody(req) as { chain?: unknown; blocks?: unknown };
        const blocks = Number(body.blocks);
        if (!Number.isInteger(blocks) || blocks < 1 || blocks > 200) {
          throw new JobError("blocks must be a whole number from 1 to 200");
        }
        return json({ heights: await options.devTools.mine(String(body.chain), blocks) });
      }
      if (req.method === "POST" && path === "/api/run") {
        const body = await readBody(req) as { args?: unknown };
        return json(jobs.start(body.args));
      }
      if (req.method === "GET" && path === "/api/jobs/current") return json(jobs.current());
      if ((m = /^\/api\/jobs\/([0-9a-f-]{36})$/u.exec(path)) && req.method === "GET") {
        return json(jobs.get(m[1], Number(url.searchParams.get("after") ?? 0)));
      }
      if ((m = /^\/api\/jobs\/([0-9a-f-]{36})\/answer$/u.exec(path)) && req.method === "POST") {
        const body = await readBody(req) as { questionId?: string; yes?: boolean };
        jobs.answer(m[1], String(body.questionId), body.yes === true);
        return json({ ok: true });
      }
      if ((m = /^\/api\/plans\/([\w-]+)\/download$/u.exec(path)) && req.method === "GET") {
        const { dir, plan } = await loadPlanDir(options.dataDir, m[1]);
        const t = planTx(plan, url.searchParams.get("file"));
        const b64 = (await Deno.readTextFile(join(dir, t.file))).trim();
        const binary = url.searchParams.get("format") === "binary";
        const name = `${m[1]}-${t.file.replace("/", "-")}`;
        return new Response(binary ? Uint8Array.from(base64.decode(b64)) : b64 + "\n", {
          headers: {
            ...SECURITY_HEADERS,
            "Content-Type": binary ? "application/octet-stream" : "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${name}${binary ? "" : ".txt"}"`,
          },
        });
      }
      if ((m = /^\/api\/plans\/([\w-]+)\/upload$/u.exec(path)) && req.method === "POST") {
        const { dir, plan } = await loadPlanDir(options.dataDir, m[1]);
        const body = await readBody(req) as { file?: string; content?: string };
        const t = planTx(plan, body.file ?? null);
        let bytes: Uint8Array;
        try {
          bytes = base64.decode(String(body.content ?? ""));
        } catch {
          throw new JobError("content must be base64");
        }
        let kind: "psbt" | "hex";
        try {
          kind = readSignedArtifact(bytes).psbt ? "psbt" : "hex";
        } catch {
          throw new JobError("That file isn't a PSBT or a raw transaction");
        }
        await ensureDir(join(dir, "uploads"));
        const name = `${t.file.replace("/", "-").replace(/\.psbt$/u, "")}.signed.${kind}`;
        await Deno.writeFile(join(dir, "uploads", name), bytes, { mode: 0o600 });
        return json({ ok: true, saved: `uploads/${name}` });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof JobError) return json({ error: error.message }, error.status);
      return json({ error: (error as Error).message }, 500);
    }
  };

  const server = Deno.serve({
    hostname: options.listenOnAllInterfaces ? "0.0.0.0" : "127.0.0.1",
    port: options.port ?? 0,
    onListen: () => {},
  }, handler);
  port = (server.addr as Deno.NetAddr).port;
  return { url: `http://127.0.0.1:${port}/#token=${token}`, token, port, server };
}
