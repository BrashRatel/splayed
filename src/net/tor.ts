/**
 * Locates or starts Tor.
 *
 * auto:    use a Tor already listening (configured address, then 127.0.0.1:9050, 127.0.0.1:9150);
 *          otherwise start our own.
 * system:  only use a running Tor at the configured address (default 127.0.0.1:9050).
 * managed: always start our own Tor.
 *
 * A managed Tor is a child process with its own data directory under the forksplit data dir,
 * SOCKS on a random loopback port with IsolateSOCKSAuth (per-chain / per-broadcast circuits) and
 * SafeSocks (no IP-address requests: all names resolve inside Tor). It's tied to this process with
 * __OwningControllerProcess so it exits if forksplit dies, and stopped explicitly on normal exit.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TorSettings } from "../core/config.ts";
import { ensureDir } from "../core/store.ts";
import { type SocksEndpoint, TorUnavailableError } from "./transport.ts";

export const SYSTEM_TOR_CANDIDATES: SocksEndpoint[] = [
  { host: "127.0.0.1", port: 9050 }, // tor daemon
  { host: "127.0.0.1", port: 9150 }, // Tor Browser
];

export class TorStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TorStartError";
  }
}

/** True if a SOCKS5 server answers the method-negotiation greeting (nothing else is sent). */
export async function probeSocks(endpoint: SocksEndpoint, timeoutMs = 1500): Promise<boolean> {
  let conn: Deno.Conn | undefined;
  const timer = setTimeout(() => {
    try {
      conn?.close();
    } catch { /* closed */ }
  }, timeoutMs);
  try {
    conn = await Deno.connect({ hostname: endpoint.host, port: endpoint.port });
    await conn.write(Uint8Array.of(0x05, 0x01, 0x02));
    const reply = new Uint8Array(2);
    let got = 0;
    while (got < 2) {
      const n = await conn.read(reply.subarray(got));
      if (n === null) return false;
      got += n;
    }
    return reply[0] === 0x05 && reply[1] === 0x02;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    try {
      conn?.close();
    } catch { /* closed */ }
  }
}

function platformDir(): string {
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  return `${Deno.build.os}-${arch}`;
}

/** Bundled binary location: vendor/tor/<os>-<arch>/tor[.exe], next to the app or the source. */
export function bundledTorCandidates(): string[] {
  const exe = Deno.build.os === "windows" ? "tor.exe" : "tor";
  const roots = new Set<string>();
  roots.add(dirname(Deno.execPath())); // `deno compile` output directory
  try {
    roots.add(join(dirname(fileURLToPath(import.meta.url)), "..", "..")); // source checkout
  } catch { /* not a file URL */ }
  return [...roots].map((root) => join(root, "vendor", "tor", platformDir(), exe));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function findOnPath(name: string): Promise<string | undefined> {
  const sep = Deno.build.os === "windows" ? ";" : ":";
  for (const dir of (Deno.env.get("PATH") ?? "").split(sep)) {
    if (!dir) continue;
    for (const candidate of Deno.build.os === "windows" ? [`${name}.exe`] : [name]) {
      const path = join(dir, candidate);
      if (await isFile(path)) return path;
    }
  }
  return undefined;
}

export async function findTorBinary(
  settings: TorSettings,
): Promise<{ path: string; source: string } | undefined> {
  if (settings.binary) {
    if (await isFile(settings.binary)) return { path: settings.binary, source: "configured" };
    throw new TorStartError(`Configured Tor binary not found: ${settings.binary}`);
  }
  for (const path of bundledTorCandidates()) {
    if (await isFile(path)) return { path, source: "bundled" };
  }
  const onPath = await findOnPath("tor");
  return onPath ? { path: onPath, source: "PATH" } : undefined;
}

function freeLoopbackPort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

export function torrc(dataDir: string, socksPort: number, ownerPid: number): string {
  return [
    "# Written by forksplit. Client-only Tor for this tool; do not edit.",
    `SocksPort 127.0.0.1:${socksPort} IsolateSOCKSAuth`,
    "SafeSocks 1",
    "ClientOnly 1",
    "AvoidDiskWrites 1",
    `DataDirectory ${dataDir}`,
    "Log notice stdout",
    `__OwningControllerProcess ${ownerPid}`,
    "",
  ].join("\n");
}

export type TorState =
  | { state: "idle" }
  | { state: "starting"; progress: number; summary: string }
  | { state: "ready"; endpoint: SocksEndpoint; source: "system" | "managed"; detail: string }
  | { state: "failed"; error: string };

export class TorManager {
  #proc?: Deno.ChildProcess;
  #ready?: Promise<SocksEndpoint>;
  #status: TorState = { state: "idle" };
  #listeners = new Set<(s: TorState) => void>();
  #lastFailure?: { at: number; error: Error };

  get status(): TorState {
    return this.#status;
  }

  onChange(fn: (s: TorState) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(status: TorState): void {
    this.#status = status;
    for (const fn of this.#listeners) fn(status);
  }

  /** Returns a ready SOCKS endpoint, starting Tor if the settings allow. Idempotent. */
  ensure(
    settings: TorSettings,
    appDataDir: string,
    log: (m: string) => void = () => {},
  ): Promise<SocksEndpoint> {
    if (this.#status.state === "ready") return Promise.resolve(this.#status.endpoint);
    // Don't make every chain wait out the same failed bootstrap within one command.
    if (!this.#ready && this.#lastFailure && Date.now() - this.#lastFailure.at < 30_000) {
      return Promise.reject(this.#lastFailure.error);
    }
    this.#ready ??= this.#locate(settings, appDataDir, log).catch((error) => {
      this.#ready = undefined;
      this.#lastFailure = { at: Date.now(), error: error as Error };
      this.#set({ state: "failed", error: (error as Error).message });
      throw error;
    });
    return this.#ready;
  }

  async #locate(
    settings: TorSettings,
    appDataDir: string,
    log: (m: string) => void,
  ): Promise<SocksEndpoint> {
    if (settings.mode !== "managed") {
      const candidates = settings.socks
        ? [settings.socks]
        : settings.mode === "system"
        ? [SYSTEM_TOR_CANDIDATES[0]]
        : [];
      if (settings.mode === "auto") candidates.push(...SYSTEM_TOR_CANDIDATES);
      for (const ep of candidates) {
        if (await probeSocks(ep)) {
          this.#set({
            state: "ready",
            endpoint: ep,
            source: "system",
            detail: `running Tor at ${ep.host}:${ep.port}`,
          });
          log(`Tor: using the Tor already running at ${ep.host}:${ep.port}`);
          return ep;
        }
      }
      if (settings.mode === "system") {
        throw new TorUnavailableError(settings.socks ?? SYSTEM_TOR_CANDIDATES[0]);
      }
    }
    return await this.#start(settings, appDataDir, log);
  }

  async #start(
    settings: TorSettings,
    appDataDir: string,
    log: (m: string) => void,
  ): Promise<SocksEndpoint> {
    const binary = await findTorBinary(settings);
    if (!binary) {
      throw new TorStartError(
        "No Tor found: nothing is listening on 127.0.0.1:9050/9150 and there's no bundled or " +
          "installed tor binary. Install Tor (or the Tor Browser and keep it open), or build " +
          "forksplit with the bundled Tor (`deno task fetch-tor`).",
      );
    }
    const torDir = join(appDataDir, "tor");
    const dataDir = join(torDir, "data");
    await ensureDir(dataDir);
    if (Deno.build.os !== "windows") await Deno.chmod(dataDir, 0o700);
    const port = freeLoopbackPort();
    const rcPath = join(torDir, "torrc");
    await Deno.writeTextFile(rcPath, torrc(dataDir, port, Deno.pid), { mode: 0o600 });
    // An empty defaults file so no system-wide torrc defaults leak into this instance.
    const defaultsPath = join(torDir, "torrc-defaults");
    await Deno.writeTextFile(defaultsPath, "", { mode: 0o600 });
    log(`Tor: starting ${binary.source} Tor (${binary.path})…`);
    this.#set({ state: "starting", progress: 0, summary: "launching" });
    // The Linux expert bundle ships its shared libraries next to the binary.
    const env: Record<string, string> = {};
    if (binary.source === "bundled" && Deno.build.os === "linux") {
      env.LD_LIBRARY_PATH = dirname(binary.path);
    }
    const proc = new Deno.Command(binary.path, {
      args: ["-f", rcPath, "--defaults-torrc", defaultsPath],
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      env,
    }).spawn();
    this.#proc = proc;
    const endpoint = { host: "127.0.0.1", port };
    try {
      await this.#waitForBootstrap(proc, settings.bootstrapTimeoutSec * 1000, log);
    } catch (error) {
      await this.stop();
      throw error;
    }
    if (!(await probeSocks(endpoint, 5000))) {
      await this.stop();
      throw new TorStartError("Tor reported bootstrap but its SOCKS port isn't answering");
    }
    this.#set({
      state: "ready",
      endpoint,
      source: "managed",
      detail: `${binary.source} Tor on 127.0.0.1:${port}`,
    });
    log(`Tor: ready (${binary.source} Tor on 127.0.0.1:${port})`);
    return endpoint;
  }

  async #waitForBootstrap(
    proc: Deno.ChildProcess,
    timeoutMs: number,
    log: (m: string) => void,
  ): Promise<void> {
    const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    const errLines: string[] = [];
    (async () => {
      for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
        errLines.push(chunk);
      }
    })().catch(() => {});
    let buffer = "";
    let lastLogged = -25;
    const deadline = Date.now() + timeoutMs;
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next === "timeout" || Date.now() > deadline) {
        reader.releaseLock();
        throw new TorStartError(
          `Tor didn't finish bootstrapping within ${Math.round(timeoutMs / 1000)}s ` +
            `(last: ${this.#status.state === "starting" ? this.#status.summary : "?"}). ` +
            "Is this network blocking Tor? You can use a bridge-enabled system Tor instead.",
        );
      }
      if (next.done) {
        throw new TorStartError(
          `Tor exited during startup. ${(errLines.join("") + buffer).trim().slice(-500)}`,
        );
      }
      buffer += next.value;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const m = /Bootstrapped (\d+)%[^:]*:?\s*(.*)$/u.exec(line);
        if (m) {
          const progress = Number(m[1]);
          this.#set({ state: "starting", progress, summary: m[2] || `${progress}%` });
          if (progress >= lastLogged + 25 || progress === 100) {
            log(`Tor: bootstrapped ${progress}%`);
            lastLogged = progress;
          }
          if (progress === 100) {
            reader.releaseLock();
            // Keep draining stdout so Tor never blocks on a full pipe.
            proc.stdout.pipeTo(new WritableStream()).catch(() => {});
            return;
          }
        } else if (/\[(err|warn)\]/u.test(line)) {
          errLines.push(line + "\n");
          if (/\[err\]/u.test(line)) throw new TorStartError(`Tor error: ${line}`);
        }
      }
    }
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    this.#proc = undefined;
    this.#ready = undefined;
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch { /* already exited */ }
      const exited = proc.status.then(() => true).catch(() => true);
      const timedOut = new Promise<boolean>((r) => setTimeout(() => r(false), 5000));
      if (!(await Promise.race([exited, timedOut]))) {
        try {
          proc.kill("SIGKILL");
        } catch { /* gone */ }
      }
    }
    if (this.#status.state !== "failed") this.#set({ state: "idle" });
  }
}

/** One Tor per forksplit process (the web UI keeps it running between commands). */
export const torManager = new TorManager();
