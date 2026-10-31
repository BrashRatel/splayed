import { parseArgs } from "node:util";
import { createBackend, type StreamFactory, type TransportFactory } from "../backends/factory.ts";
import type { ChainBackend } from "../backends/types.ts";
import {
  type BackendConfig,
  backendToToml,
  type Config,
  ConfigError,
  GateClosedError,
  loadConfig,
  networkConfirmed,
  parseProxy,
  parseSocks,
  readConfigFile,
  requireNetworkConfirmed,
  routeForBackend,
  writeConfigFile,
  writeGate,
} from "../core/config.ts";
import { DescriptorError } from "../core/descriptors.ts";
import { verifyIdentity } from "../core/identity.ts";
import { CHAIN_IDS, CHAIN_NAMES, type ChainId, isChainId } from "../core/profiles.ts";
import { loadScan, runScan, saveScan, scanRegressions } from "../core/scan.ts";
import { classify } from "../core/state.ts";
import { defaultDataDir, ensureDir } from "../core/store.ts";
import { importDescriptor, loadWallet, parsedDescriptors, saveWallet } from "../core/wallet.ts";
import {
  describeRoute,
  PolicyError,
  type SocksEndpoint,
  TorUnavailableError,
} from "../net/transport.ts";
import { torManager, TorStartError } from "../net/tor.ts";
import { parseDescriptor } from "../core/descriptors.ts";
import {
  buildPlan,
  type ForkChain,
  parseBatchPolicy,
  PlanError,
  type PlannedTx,
  PLANS_DIR,
  writePlan,
  XBT_SIGNERS,
} from "../core/planner.ts";
import { join } from "node:path";
import { buildReplacement, BumpError, bumpPlan, defaultBumpRate } from "../core/bump.ts";
import {
  assessReorg,
  confirmationDepth,
  type DepthResult,
  ExecuteError,
  findSignedFiles,
  loadPlanDir,
  loadProgress,
  matchArtifacts,
  mempoolChecks,
  type MempoolNode,
  ownPsbt,
  saveProgress,
  verifySigned,
} from "../core/execute.ts";
import { SigCheckError } from "../core/sigcheck.ts";
import { parseTx } from "../core/tx.ts";
import { BackendError } from "../backends/types.ts";
import { observationCell, privacyLevel, sats, shortOutpoint, table } from "./format.ts";

const USAGE =
  `forksplit - separate BTC, XBT and ECX copies of the same coins (keyless: your wallet signs)

Usage: forksplit [global options] <command> [args]

Setup (nothing about your coins is sent anywhere until you confirm):
  init [--yes]                    Review network settings, check each backend is on the right
                                  chain, and confirm. Required before import/scan.
  config show                     Show the effective network settings
  config backend add <chain> --kind esplora|rpc|electrum --url URL
                     [--proxy tor|none|socks5://h:p] [--ca-file PEM]
                     [--role read|broadcast|both] [--priority N]
                     (Electrum URLs: ssl://host:50002 or tcp://host:50001)
                     [--cookie-file PATH | --user U --password-env VAR] [--label TEXT]
  config backend remove <chain> <url>
  config backend reset <chain>    Go back to the profile's default backend
  config backend fallback <chain> Add the profile's fallback backend to the list
  config clearnet <chain> on|off  Allow direct (non-Tor) connections to public hosts
  config tor auto|managed|system [host:port]
                                  auto (default): use a running Tor, else start forksplit's own.
                                  system: only a Tor you run (e.g. 127.0.0.1:9150 for Tor
                                  Browser). managed: always start forksplit's own Tor.
  config confirmations <chain> N  Depth required before a spend counts as final

Coins:
  import <descriptor> [--label L] Add a watch-only output descriptor (xpub-based)
  descriptors                     List imported descriptors
  forget <number>                 Remove an imported descriptor
  scan [--rpc-range N]            Find your coins on all three chains and cross-check them
  status [--json]                 Show per-coin state from the last scan (no network)

Splitting (guided route: forks first, BTC untouched):
  dest set <xbt|ecx> <descriptor> [--start-index N]
                                  Where split coins go on that fork (best: a new seed per fork)
  dest show
  plan --xbt-signer NAME [--chains ecx,xbt] [--batch coin|address|all|N]
       [--fee-rate ecx=2,xbt=3] [--coin txid:vout ...] [--yes]
                                  Write unsigned, replay-protected PSBTs for shared coins.
                                  XBT signers: ${Object.keys(XBT_SIGNERS).join(", ")}
  plans                           List written plans
  verify <plan> [signed files...] [--no-mempool]
                                  Check signed PSBTs/transactions: same tx as planned, replay
                                  marker (ECX) or 0x21 on every signature (XBT), every signature
                                  valid, fee as planned. With your own RPC nodes configured, also
                                  asks each one (testmempoolaccept) - the target chain must accept
                                  and the other chains must reject.
  broadcast <plan> [--all] [--yes]
                                  Send verified transactions, each only to its own chain, each
                                  over its own Tor circuit. Sends the TEST FIRST transaction alone
                                  until it confirms (--all overrides).
  track <plan>                    Confirmations of broadcast transactions. Warns loudly if a split
                                  that was confirmed leaves the chain, is re-mined in another
                                  block, or has its input spent by a different transaction.
  bump <plan> [--chains ecx,xbt] [--tx N ...] [--fee-rate ecx=5,xbt=8] [--yes]
                                  Stuck split? Write a new plan that spends the same inputs at a
                                  higher fee (RBF, BIP125). Sign, verify and broadcast it like any
                                  plan; nodes replace the original with it.

Web UI:
  ui [--port N] [--open]          Local web interface (127.0.0.1 only) that runs these same
                                  commands, prompts included

Global options:
  --data-dir DIR    (env FORKSPLIT_DATA_DIR)   --tor-socks HOST:PORT (env FORKSPLIT_TOR_SOCKS)
  --profile ID      (env FORKSPLIT_PROFILE)    --json   -h, --help
`;

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
  confirm: (question: string) => boolean | Promise<boolean>;
  /** Locates/starts Tor and returns its SOCKS endpoint. Tests replace it. */
  tor?: (config: Config, log: (m: string) => void) => Promise<SocksEndpoint>;
  env: Record<string, string | undefined>;
  transportFactory?: TransportFactory;
  streamFactory?: StreamFactory;
}

const defaultIO: CliIO = {
  out: (t) => console.log(t),
  err: (t) => console.error(t),
  confirm: (q) => confirm(q),
  env: Deno.env.toObject(),
};

class UsageError extends Error {}

function requireChain(value: string | undefined): ChainId {
  if (!value || !isChainId(value)) {
    throw new UsageError(`Expected a chain: ${CHAIN_IDS.join(", ")}`);
  }
  return value;
}

export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "data-dir": { type: "string" },
        "tor-socks": { type: "string" },
        profile: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        yes: { type: "boolean", short: "y" },
        label: { type: "string" },
        kind: { type: "string" },
        url: { type: "string" },
        proxy: { type: "string" },
        role: { type: "string" },
        priority: { type: "string" },
        "cookie-file": { type: "string" },
        user: { type: "string" },
        "password-env": { type: "string" },
        "ca-file": { type: "string" },
        "rpc-range": { type: "string" },
        "start-index": { type: "string" },
        "xbt-signer": { type: "string" },
        chains: { type: "string" },
        batch: { type: "string" },
        "fee-rate": { type: "string" },
        coin: { type: "string", multiple: true },
        all: { type: "boolean" },
        port: { type: "string" },
        open: { type: "boolean" },
        "no-mempool": { type: "boolean" },
        tx: { type: "string", multiple: true },
      },
    });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: flags, positionals } = parsed;
  const [command, ...args] = positionals;
  if (flags.help || !command) {
    io.out(USAGE);
    return command || flags.help ? 0 : 2;
  }
  const dataDir = flags["data-dir"] ?? io.env.FORKSPLIT_DATA_DIR ?? defaultDataDir();
  try {
    await ensureDir(dataDir);
    if (command === "config" && args[0] !== "show") {
      await editConfig(dataDir, args, flags, io);
      io.out("Saved. Network settings changed: run `forksplit init` to review and confirm them.");
      return 0;
    }
    const config = await loadConfig({
      dataDir,
      torSocks: flags["tor-socks"],
      profile: flags.profile,
      env: io.env,
    });
    switch (command) {
      case "init":
        return await cmdInit(config, io, flags.yes === true);
      case "config":
        showConfig(config, io, await networkConfirmed(config));
        return 0;
      case "import":
        return await cmdImport(config, args, flags.label, io);
      case "descriptors":
        return await cmdDescriptors(config, io);
      case "forget":
        return await cmdForget(config, args, io);
      case "scan":
        return await cmdScan(config, io, flags["rpc-range"]);
      case "status":
        return await cmdStatus(config, io, flags.json === true);
      case "dest":
        return await cmdDest(config, args, flags["start-index"], io);
      case "plan":
        return await cmdPlan(config, io, {
          xbtSigner: flags["xbt-signer"],
          chains: flags.chains,
          batch: flags.batch,
          feeRate: flags["fee-rate"],
          coins: flags.coin as string[] | undefined,
          yes: flags.yes === true,
        });
      case "plans":
        return await cmdPlans(config, io);
      case "verify":
        return await cmdVerify(config, io, args, flags["no-mempool"] === true);
      case "broadcast":
        return await cmdBroadcast(config, io, args[0], flags.all === true, flags.yes === true);
      case "track":
        return await cmdTrack(config, io, args[0]);
      case "bump":
        return await cmdBump(config, io, args[0], {
          feeRate: flags["fee-rate"],
          chains: flags.chains,
          tx: flags.tx as string[] | undefined,
          yes: flags.yes === true,
        });
      case "ui":
        return await cmdUi(dataDir, io, flags.port, flags.open === true);
      default:
        throw new UsageError(`Unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (
      error instanceof ConfigError || error instanceof GateClosedError ||
      error instanceof PlanError || error instanceof BumpError ||
      error instanceof ExecuteError ||
      error instanceof DescriptorError || error instanceof PolicyError ||
      error instanceof TorUnavailableError || error instanceof TorStartError
    ) {
      io.err(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

// ---- config ----

export function describeTor(config: Config): string {
  const t = config.tor;
  const where = t.socks ? `${t.socks.host}:${t.socks.port}` : "127.0.0.1:9050 or :9150";
  switch (t.mode) {
    case "auto":
      return `auto (use a running Tor at ${where}, else start forksplit's own)`;
    case "system":
      return `system (only the Tor running at ${t.socks ? where : "127.0.0.1:9050"})`;
    case "managed":
      return `managed (forksplit starts its own Tor${t.binary ? `: ${t.binary}` : ""})`;
  }
}

function showConfig(config: Config, io: CliIO, confirmed: boolean): void {
  io.out(
    `Profile: ${config.profile.id}    Tor SOCKS: ${config.torSocks.host}:${config.torSocks.port}`,
  );
  io.out(`Data directory: ${config.dataDir}`);
  io.out(`Tor: ${describeTor(config)}`);
  io.out(`Network settings confirmed: ${confirmed ? "yes" : "NO (run `forksplit init`)"}\n`);
  for (const chain of CHAIN_IDS) {
    const cc = config.chains[chain];
    io.out(
      `${CHAIN_NAMES[chain]}  (confirmations: ${cc.confirmations}` +
        `${cc.clearnetOptIn ? ", CLEARNET ALLOWED" : ""})`,
    );
    for (const b of cc.backends) {
      const route = routeForBackend(config, chain, b);
      io.out(`  [${b.priority}] ${b.kind.padEnd(7)} ${b.url}`);
      io.out(
        `        role: ${b.role}; ${privacyLevel(b, route)}; route: ${describeRoute(route)}` +
          `${b.origin === "profile-default" ? "; profile default" : ""}`,
      );
    }
    const fallbacks = config.profile.chains[chain].defaultBackends.filter((d) =>
      d.tier === "fallback"
    );
    for (const f of fallbacks) {
      if (!cc.backends.some((b) => b.url === f.url)) {
        io.out(
          `  (fallback available, not enabled: ${f.url} - \`config backend fallback ${chain}\`)`,
        );
      }
    }
    io.out("");
  }
}

async function editConfig(
  dataDir: string,
  args: string[],
  flags: Record<string, unknown>,
  io: CliIO,
): Promise<void> {
  const file = await readConfigFile(dataDir);
  file.chains ??= {};
  const chains = file.chains as Record<string, Record<string, unknown>>;
  const [sub, ...rest] = args;
  // Load the effective config so "add" on a chain still using defaults starts from them.
  const effective = await loadConfig({ dataDir, env: io.env }).catch(() => undefined);
  const explicit = (chain: ChainId, keepDefaults = true): Record<string, unknown>[] => {
    chains[chain] ??= {};
    if (!Array.isArray(chains[chain].backends)) {
      // Adding your own backend REPLACES the profile default: it will never be contacted.
      // (`config backend fallback` / `reset` bring defaults back explicitly.)
      const kept = effective
        ? effective.chains[chain].backends.filter((b) =>
          keepDefaults || b.origin !== "profile-default"
        )
        : [];
      if (effective && kept.length < effective.chains[chain].backends.length) {
        io.err(
          `${chain.toUpperCase()}: the profile default backend is removed and won't be contacted.`,
        );
      }
      chains[chain].backends = kept.map(backendToToml);
    }
    return chains[chain].backends as Record<string, unknown>[];
  };

  if (sub === "backend") {
    const [action, chainArg, urlArg] = rest;
    const chain = requireChain(chainArg);
    if (action === "add") {
      if (typeof flags.kind !== "string" || typeof flags.url !== "string") {
        throw new UsageError("config backend add needs --kind and --url");
      }
      const backend: BackendConfig = {
        kind: flags.kind as BackendConfig["kind"],
        url: String(flags.url).replace(/\/+$/u, ""),
        proxy: parseProxy(flags.proxy),
        role: (flags.role as BackendConfig["role"]) ?? "both",
        priority: flags.priority ? Number(flags.priority) : 0,
        label: flags.label as string | undefined,
        auth: flags["cookie-file"] || flags.user
          ? {
            cookieFile: flags["cookie-file"] as string | undefined,
            user: flags.user as string | undefined,
            passwordEnv: flags["password-env"] as string | undefined,
          }
          : undefined,
        caFile: flags["ca-file"] as string | undefined,
        origin: "user",
      };
      const list = explicit(chain, false).filter((b) => b.url !== backend.url);
      list.push(backendToToml(backend));
      chains[chain].backends = list;
    } else if (action === "remove") {
      if (!urlArg) throw new UsageError("config backend remove <chain> <url>");
      const list = explicit(chain);
      const next = list.filter((b) => b.url !== urlArg.replace(/\/+$/u, ""));
      if (next.length === list.length) {
        throw new UsageError(`No ${chain} backend with URL ${urlArg}`);
      }
      chains[chain].backends = next;
    } else if (action === "reset") {
      if (chains[chain]) delete chains[chain].backends;
    } else if (action === "fallback") {
      const profileId = typeof file.profile === "string" ? file.profile : "mainnet";
      const profile = effective?.profile ??
        (await import("../core/profiles.ts")).getProfile(profileId);
      const fallbacks = profile.chains[chain].defaultBackends.filter((d) => d.tier === "fallback");
      if (!fallbacks.length) throw new UsageError(`No fallback backend defined for ${chain}`);
      const list = explicit(chain);
      for (const f of fallbacks) {
        if (!list.some((b) => b.url === f.url)) {
          list.push({
            kind: f.kind,
            url: f.url,
            proxy: "tor",
            role: "both",
            priority: 10,
            label: f.label,
          });
        }
      }
    } else {
      throw new UsageError("config backend add|remove|reset|fallback");
    }
  } else if (sub === "clearnet") {
    const chain = requireChain(rest[0]);
    if (rest[1] !== "on" && rest[1] !== "off") {
      throw new UsageError("config clearnet <chain> on|off");
    }
    chains[chain] ??= {};
    chains[chain].clearnet_opt_in = rest[1] === "on";
    if (rest[1] === "on") {
      io.err(
        `WARNING: ${chain.toUpperCase()} backends with proxy "none" will now see your IP address ` +
          "alongside every address and coin you look up.",
      );
    }
  } else if (sub === "tor") {
    // config tor auto|managed|system [host:port]   (or the shorthand: config tor host:port)
    const tor = (file.tor ?? {}) as Record<string, unknown>;
    const [first, second] = rest;
    if (!first) throw new UsageError("config tor auto|managed|system [host:port]");
    if (first === "auto" || first === "managed" || first === "system") {
      tor.mode = first;
      if (second) {
        parseSocks(second);
        tor.socks = second;
      } else if (first === "managed") delete tor.socks;
    } else {
      parseSocks(first);
      tor.mode = "system";
      tor.socks = first;
    }
    file.tor = tor;
  } else if (sub === "confirmations") {
    const chain = requireChain(rest[0]);
    const n = Number(rest[1]);
    if (!Number.isSafeInteger(n)) throw new UsageError("config confirmations <chain> <number>");
    chains[chain] ??= {};
    chains[chain].confirmations = n;
  } else {
    throw new UsageError(`Unknown config command "${sub ?? ""}"`);
  }
  // Validate before writing so a bad edit never lands on disk.
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeConfigFile(tmpDir, file);
    await loadConfig({ dataDir: tmpDir, env: io.env });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
  await writeConfigFile(dataDir, file);
}

// ---- init ----

/**
 * Starts or locates Tor only when a backend that is about to be contacted needs it, and points
 * the config at the endpoint in use. Local backends never cause Tor to start.
 */
async function torFor(
  config: Config,
  chain: ChainId,
  backend: BackendConfig,
  io: CliIO,
): Promise<void> {
  const route = routeForBackend(config, chain, backend);
  if (route.via !== "socks" || !route.tor) return;
  const provider = io.tor ??
    ((c: Config, log: (m: string) => void) => torManager.ensure(c.tor, c.dataDir, log));
  config.torSocks = await provider(config, (m) => io.out(m));
}

/**
 * Tries backends in priority order and STOPS at the first one that passes, so lower-priority
 * backends (and any profile defaults still configured) are contacted only if every backend
 * above them failed. `role` picks read backends (scan/plan) or broadcast backends.
 */
async function verifiedBackendsFor(
  config: Config,
  chain: ChainId,
  io: CliIO,
  quiet = false,
  role: "read" | "broadcast" = "read",
): Promise<{ backend?: ChainBackend; results: { url: string; ok: boolean; detail: string }[] }> {
  const results: { url: string; ok: boolean; detail: string }[] = [];
  const candidates = config.chains[chain].backends.filter((b) =>
    role === "read" ? b.role !== "broadcast" : b.role !== "read"
  );
  for (const [i, b] of candidates.entries()) {
    let detail: string;
    try {
      await torFor(config, chain, b, io);
      const backend = await createBackend(config, chain, b, {
        transportFactory: io.transportFactory,
        streamFactory: io.streamFactory,
        env: io.env,
      });
      const r = await verifyIdentity(backend, config.profile.chains[chain]);
      detail = r.detail;
      if (r.ok) {
        results.push({ url: b.url, ok: true, detail });
        if (!quiet) io.out(`  OK   ${b.url}\n       ${detail}`);
        for (const rest of candidates.slice(i + 1)) {
          if (!quiet) {
            io.out(`  --   ${rest.url}\n       not contacted (a higher-priority backend passed)`);
          }
        }
        return { backend, results };
      }
      await backend.close?.();
    } catch (error) {
      detail = (error as Error).message;
    }
    results.push({ url: b.url, ok: false, detail });
    if (!quiet) io.out(`  FAIL ${b.url}\n       ${detail}`);
  }
  return { results };
}

async function cmdInit(config: Config, io: CliIO, yes: boolean): Promise<number> {
  showConfig(config, io, await networkConfirmed(config));
  io.out(
    "Next: check each chain's backend is reachable and on the right chain. Only the chain tip\n" +
      "and a few fixed block hashes are requested; nothing about your coins is sent. Backends\n" +
      "are tried in priority order and checking stops at the first that passes, so lower ones\n" +
      "aren't contacted.\n",
  );
  if (
    !yes && !(await io.confirm("Contact these servers now? (Answer no to change settings first.)"))
  ) {
    io.out(
      "Nothing was contacted. Change settings with `forksplit config ...`, then run init again.",
    );
    return 1;
  }
  const identity: Record<string, { ok: boolean; detail: string }> = {};
  let allChainsOk = true;
  for (const chain of CHAIN_IDS) {
    io.out(CHAIN_NAMES[chain]);
    const { backend, results } = await verifiedBackendsFor(config, chain, io);
    await backend?.close?.();
    for (const r of results) identity[`${chain} ${r.url}`] = { ok: r.ok, detail: r.detail };
    if (!backend) allChainsOk = false;
  }
  io.out("");
  if (!allChainsOk) {
    io.err(
      "At least one chain has no backend that passed. Nothing was confirmed.\n" +
        "Fix the settings (`forksplit config ...`) or start Tor, then run `forksplit init` again.",
    );
    return 1;
  }
  if (
    !yes && !(await io.confirm("Use these network settings for importing and scanning your coins?"))
  ) {
    io.out("Not confirmed. Nothing was saved.");
    return 1;
  }
  await writeGate(config, identity);
  io.out(
    "Network settings confirmed. Next: `forksplit import '<descriptor>'`, then `forksplit scan`.",
  );
  return 0;
}

// ---- descriptors ----

async function cmdImport(config: Config, args: string[], label: string | undefined, io: CliIO) {
  await requireNetworkConfirmed(config);
  if (!args[0]) throw new UsageError("import <descriptor>");
  const { parsed, added } = await importDescriptor(config.dataDir, args[0], label);
  io.out(added ? "Imported (watch-only):" : "Already imported:");
  io.out(`  ${parsed.normalized}`);
  if (!parsed.hadChecksum) io.out("  (no checksum was given; one has been added)");
  io.out("Check these first addresses match your wallet before scanning:");
  for (const branch of parsed.branches) {
    io.out(`  branch ${branch.branch}: ${branch.derive(0).address}`);
  }
  return 0;
}

async function cmdDescriptors(config: Config, io: CliIO) {
  const wallet = await loadWallet(config.dataDir);
  if (!wallet.descriptors.length) {
    io.out("No descriptors imported yet.");
    return 0;
  }
  wallet.descriptors.forEach((d, i) =>
    io.out(`${i + 1}. ${d.label ? `[${d.label}] ` : ""}${d.descriptor}`)
  );
  return 0;
}

async function cmdForget(config: Config, args: string[], io: CliIO) {
  const n = Number(args[0]);
  const wallet = await loadWallet(config.dataDir);
  if (!Number.isInteger(n) || n < 1 || n > wallet.descriptors.length) {
    throw new UsageError("forget <number from `forksplit descriptors`>");
  }
  const [removed] = wallet.descriptors.splice(n - 1, 1);
  await saveWallet(config.dataDir, wallet);
  io.out(`Removed ${removed.descriptor}`);
  return 0;
}

// ---- scan / status ----

async function cmdScan(config: Config, io: CliIO, rpcRangeFlag?: string) {
  await requireNetworkConfirmed(config);
  const wallet = await loadWallet(config.dataDir);
  if (!wallet.descriptors.length) throw new UsageError("Import a descriptor first");
  const rpcRange = rpcRangeFlag ? Number(rpcRangeFlag) : undefined;
  if (
    rpcRange !== undefined &&
    (!Number.isSafeInteger(rpcRange) || rpcRange < 1 || rpcRange > 100_000)
  ) {
    throw new UsageError("--rpc-range must be between 1 and 100000");
  }
  io.out("Re-checking backend identity before sending anything about your coins…");
  const backends: Partial<Record<ChainId, ChainBackend>> = {};
  for (const chain of CHAIN_IDS) {
    const { backend, results } = await verifiedBackendsFor(config, chain, io, true);
    const first = config.chains[chain].backends.find((b) => b.role !== "broadcast");
    if (backend) {
      backends[chain] = backend;
      if (backend.config.url !== first?.url) {
        io.err(
          `  ${chain.toUpperCase()}: first backend failed; using ${backend.config.url} instead`,
        );
      }
      io.out(`  ${chain.toUpperCase()}: ${backend.config.url} (${describeRoute(backend.route)})`);
    } else {
      io.err(
        `  ${chain.toUpperCase()}: no backend passed: ${results.map((r) => r.detail).join("; ")}`,
      );
    }
  }
  let result;
  try {
    result = await runScan(config, parsedDescriptors(wallet), {
      backends,
      log: (m) => io.out(m),
      rpcRange,
    });
  } finally {
    for (const b of Object.values(backends)) await b?.close?.();
  }
  result.warnings.push(...scanRegressions(await loadScan(config.dataDir), result));
  await saveScan(config.dataDir, result);
  for (const w of result.warnings) io.err(`Warning: ${w}`);
  io.out("");
  printStatus(config, result, io);
  return result.warnings.length ? 1 : 0;
}

async function cmdStatus(config: Config, io: CliIO, json: boolean) {
  const result = await loadScan(config.dataDir);
  if (!result) {
    io.out("No scan yet. Run `forksplit scan`.");
    return 0;
  }
  if (json) {
    const ctx = {
      tips: result.tips,
      confirmations: Object.fromEntries(
        CHAIN_IDS.map((c) => [c, config.chains[c].confirmations]),
      ) as Record<ChainId, number>,
    };
    io.out(JSON.stringify(
      {
        ...result,
        coins: result.coins.map((coin) => ({ ...coin, classification: classify(coin, ctx) })),
      },
      null,
      2,
    ));
    return 0;
  }
  printStatus(config, result, io);
  return 0;
}

function printStatus(
  config: Config,
  result: Awaited<ReturnType<typeof loadScan>> & object,
  io: CliIO,
) {
  const ctx = {
    tips: result.tips,
    confirmations: Object.fromEntries(
      CHAIN_IDS.map((c) => [c, config.chains[c].confirmations]),
    ) as Record<ChainId, number>,
  };
  io.out(
    `Scan from ${result.scannedAt}; tips: ${
      CHAIN_IDS.map((c) => `${c.toUpperCase()} ${result.tips[c] ?? "?"}`).join(", ")
    }`,
  );
  const revealed = CHAIN_IDS.filter((c) => (result.addressesRevealed[c] ?? 0) > 0)
    .map((c) => `${c.toUpperCase()} ${result.addressesRevealed[c]}`);
  if (revealed.length) io.out(`Addresses looked up on remote servers: ${revealed.join(", ")}`);
  if (!result.coins.length) {
    io.out("No coins found.");
    return;
  }
  const rows = [["Coin", "Value", "BTC", "XBT", "ECX", "Status"]];
  const counts: Record<string, number> = {};
  const details: string[] = [];
  for (const coin of result.coins) {
    const c = classify(coin, ctx);
    counts[c.status] = (counts[c.status] ?? 0) + 1;
    rows.push([
      shortOutpoint(coin.txid, coin.vout),
      sats(coin.value),
      ...CHAIN_IDS.map((chain) => observationCell(coin.observations[chain], result.tips[chain])),
      c.status === "shared" ? `SHARED (${c.unspentOn.join("+").toUpperCase()})` : c.status,
    ]);
    if (c.reasons.length || c.nextSteps.length) {
      details.push(
        `${shortOutpoint(coin.txid, coin.vout)}${coin.address ? ` ${coin.address}` : ""}\n` +
          [
            ...c.reasons.map((r) => `    - ${r}`),
            ...c.nextSteps.map((s, i) => `    ${i + 1}. ${s}`),
          ]
            .join("\n"),
      );
    }
  }
  io.out(table(rows));
  io.out(`\n${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  if (details.length) io.out(`\nDetails:\n${details.join("\n")}`);
}

// ---- destinations and planning ----

async function cmdDest(config: Config, args: string[], startIndex: string | undefined, io: CliIO) {
  const [action, chainArg, descriptor] = args;
  const wallet = await loadWallet(config.dataDir);
  if (action === "show" || !action) {
    for (const chain of ["ecx", "xbt"] as const) {
      const d = wallet.destinations?.[chain];
      io.out(
        `${chain.toUpperCase()}: ${
          d ? `${d.descriptor}\n     next index ${d.nextIndex}` : "(not set)"
        }`,
      );
    }
    return 0;
  }
  if (action !== "set") throw new UsageError("dest set <xbt|ecx> <descriptor> | dest show");
  await requireNetworkConfirmed(config);
  if (chainArg !== "xbt" && chainArg !== "ecx") {
    throw new UsageError("Destinations are per fork: xbt or ecx");
  }
  if (!descriptor) throw new UsageError("dest set <xbt|ecx> <descriptor>");
  const parsed = parseDescriptor(descriptor);
  if (!parsed.branches[0].ranged) {
    throw new UsageError("Destination descriptor must be ranged (end in /*)");
  }
  const start = startIndex === undefined ? 0 : Number(startIndex);
  if (!Number.isSafeInteger(start) || start < 0) throw new UsageError("--start-index must be >= 0");
  wallet.destinations = {
    ...wallet.destinations,
    [chainArg]: { descriptor: parsed.normalized, nextIndex: start },
  };
  await saveWallet(config.dataDir, wallet);
  io.out(
    `${chainArg.toUpperCase()} destination set. First address: ${
      parsed.branches[0].derive(start).address
    }`,
  );
  io.out("Check it belongs to the wallet you'll use for this fork.");
  return 0;
}

function parseFeeRates(value: string | undefined): Partial<Record<ForkChain, number>> {
  const out: Partial<Record<ForkChain, number>> = {};
  if (!value) return out;
  for (const part of value.split(",")) {
    const [chain, rate] = part.split("=");
    const n = Number(rate);
    if ((chain !== "ecx" && chain !== "xbt") || !(n > 0)) {
      throw new UsageError("--fee-rate looks like ecx=2,xbt=3 (sat/vB)");
    }
    out[chain] = n;
  }
  return out;
}

async function cmdPlan(
  config: Config,
  io: CliIO,
  opts: {
    xbtSigner?: string;
    chains?: string;
    batch?: string;
    feeRate?: string;
    coins?: string[];
    yes: boolean;
  },
) {
  await requireNetworkConfirmed(config);
  const scan = await loadScan(config.dataDir);
  if (!scan) throw new UsageError("Run `forksplit scan` first");
  const chains = (opts.chains ?? "ecx,xbt").split(",").map((c) => c.trim());
  if (!chains.every((c) => c === "ecx" || c === "xbt") || !chains.length) {
    throw new UsageError("--chains takes ecx, xbt or ecx,xbt");
  }
  const wallet = await loadWallet(config.dataDir);
  const backends: Partial<Record<ForkChain, ChainBackend>> = {};
  try {
    io.out("Re-checking backend identity…");
    for (const chain of chains as ForkChain[]) {
      const { backend, results } = await verifiedBackendsFor(config, chain, io, true);
      if (!backend) {
        throw new PlanError(
          `${chain.toUpperCase()}: no backend passed: ${results.map((r) => r.detail).join("; ")}`,
        );
      }
      backends[chain] = backend;
    }
    const plan = await buildPlan(config, scan, wallet, {
      chains: chains as ForkChain[],
      batch: parseBatchPolicy(opts.batch),
      feeRates: parseFeeRates(opts.feeRate),
      xbtSigner: opts.xbtSigner,
      coins: opts.coins,
    }, { backends, log: (m) => io.out(m) });
    for (const w of plan.warnings) io.err(`Warning: ${w}`);
    if (!plan.transactions.length) {
      io.out("Nothing to plan: no shared coins left on the selected forks.");
      return 0;
    }
    const rows = [["Chain", "#", "Inputs", "Value in", "Fee", "sat/vB", "To", ""]];
    for (const tx of plan.transactions) {
      rows.push([
        tx.chain.toUpperCase(),
        String(tx.order),
        String(tx.inputs.length),
        sats(tx.inputs.reduce((s, i) => s + i.value, 0)),
        String(tx.fee),
        String(tx.feeRate),
        tx.output.address,
        tx.testFirst ? "TEST FIRST" : "",
      ]);
    }
    io.out(table(rows));
    for (const chain of ["ecx", "xbt"] as const) {
      const txs = plan.transactions.filter((t) => t.chain === chain);
      if (!txs.length) continue;
      const linked = txs.filter((t) => t.inputs.length > 1).length;
      io.out(
        `${chain.toUpperCase()}: ${txs.length} transaction(s), ${
          txs.reduce((s, t) => s + t.fee, 0)
        } sats in fees` +
          (linked
            ? `; ${linked} of them combine coins, publicly linking those addresses on ${chain.toUpperCase()}`
            : "; no coins combined"),
      );
    }
    if (
      !opts.yes &&
      !(await io.confirm("Write these PSBTs (and reserve their destination addresses)?"))
    ) {
      io.out("Nothing written.");
      return 1;
    }
    const dir = await writePlan(config.dataDir, plan);
    const fresh = await loadWallet(config.dataDir);
    for (const [chain, next] of Object.entries(plan.reserved) as [ForkChain, number][]) {
      const d = fresh.destinations?.[chain];
      if (d && next > d.nextIndex) d.nextIndex = next;
    }
    await saveWallet(config.dataDir, fresh);
    io.out(`\nWrote ${plan.transactions.length} PSBT(s) to ${dir}`);
    io.out(
      "Read README.txt there before signing. Sign the TEST FIRST transaction on each chain first.",
    );
    return 0;
  } finally {
    for (const b of Object.values(backends)) await b?.close?.();
  }
}

async function cmdPlans(config: Config, io: CliIO) {
  const dir = join(config.dataDir, PLANS_DIR);
  const ids: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isDirectory) ids.push(e.name);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (!ids.length) {
    io.out("No plans yet.");
    return 0;
  }
  for (const id of ids.sort()) io.out(`${id}  ${join(dir, id)}`);
  return 0;
}

// ---- verify / broadcast / track ----

/** The user's own nodes (kind "rpc"), one per chain, first that passes identity. */
async function ownNodes(config: Config, io: CliIO): Promise<MempoolNode[]> {
  const nodes: MempoolNode[] = [];
  for (const chain of CHAIN_IDS) {
    for (const b of config.chains[chain].backends.filter((b) => b.kind === "rpc")) {
      try {
        await torFor(config, chain, b, io);
        const backend = await createBackend(config, chain, b, {
          transportFactory: io.transportFactory,
          streamFactory: io.streamFactory,
          env: io.env,
        });
        if ((await verifyIdentity(backend, config.profile.chains[chain])).ok) {
          nodes.push({ chain, backend });
          break;
        }
      } catch { /* try the next */ }
    }
  }
  return nodes;
}

async function cmdVerify(config: Config, io: CliIO, args: string[], noMempool: boolean) {
  await requireNetworkConfirmed(config);
  const [id, ...given] = args;
  if (!id) throw new UsageError("verify <plan> [signed files...]");
  const { dir, plan } = await loadPlanDir(config.dataDir, id);
  const progress = await loadProgress(dir);
  const files = given.length ? given : await findSignedFiles(dir);
  if (!files.length) {
    io.out(
      `No signed files found. Save signed PSBTs next to the originals as <name>.signed.psbt in ${dir}`,
    );
    return 1;
  }
  const { matched, unmatched } = await matchArtifacts(dir, plan, files);
  for (const f of unmatched) io.err(`Warning: ${f} doesn't match any transaction in this plan`);
  const nodes = noMempool ? [] : await ownNodes(config, io);
  if (!noMempool && nodes.length) {
    io.out(`Mempool checks on your nodes: ${nodes.map((n) => n.chain.toUpperCase()).join(", ")}`);
  }
  let failures = 0;
  const rows = [["Chain", "#", "File", "Result"]];
  try {
    for (const t of plan.transactions) {
      const m = matched.get(t.file);
      if (!m) {
        rows.push([
          t.chain.toUpperCase(),
          String(t.order),
          t.file,
          progress.txs[t.file]?.verified ? "verified earlier" : "not signed yet",
        ]);
        continue;
      }
      try {
        const v = verifySigned(t, await ownPsbt(dir, t), m.signed);
        const mempool = nodes.length ? await mempoolChecks(t, v.finalHex, nodes) : undefined;
        progress.txs[t.file] = {
          ...progress.txs[t.file],
          verified: {
            at: new Date().toISOString(),
            txid: v.txid,
            finalHex: v.finalHex,
            checks: v.checks,
            mempool,
          },
        };
        rows.push([
          t.chain.toUpperCase(),
          String(t.order),
          t.file,
          `VERIFIED ${v.txid.slice(0, 16)}…`,
        ]);
        for (const c of v.checks) io.out(`  ${t.file}: ${c}`);
        for (const [chain, r] of Object.entries(mempool ?? {})) {
          io.out(`  ${t.file}: ${chain.toUpperCase()} node: ${r}`);
        }
      } catch (error) {
        if (
          !(error instanceof SigCheckError || error instanceof BackendError ||
            error instanceof ExecuteError)
        ) throw error;
        failures++;
        rows.push([
          t.chain.toUpperCase(),
          String(t.order),
          t.file,
          `FAILED: ${(error as Error).message}`,
        ]);
      }
    }
  } finally {
    for (const n of nodes) await n.backend.close?.();
  }
  await saveProgress(dir, progress);
  io.out(table(rows));
  if (failures) io.err(`${failures} transaction(s) failed verification. Do not broadcast them.`);
  return failures ? 1 : 0;
}

async function cmdBroadcast(
  config: Config,
  io: CliIO,
  id: string | undefined,
  all: boolean,
  yes: boolean,
) {
  await requireNetworkConfirmed(config);
  if (!id) throw new UsageError("broadcast <plan>");
  const { dir, plan } = await loadPlanDir(config.dataDir, id);
  const progress = await loadProgress(dir);
  const opened: ChainBackend[] = [];
  try {
    const queue: {
      t: (typeof plan.transactions)[number];
      hex: string;
      txid: string;
      send: ChainBackend;
    }[] = [];
    for (const chain of ["ecx", "xbt"] as const) {
      const txs = plan.transactions.filter((t) =>
        t.chain === chain && progress.txs[t.file]?.verified
      );
      const pending = txs.filter((t) => {
        const st = progress.txs[t.file]?.broadcast?.status;
        return st !== "accepted" && st !== "rejected" && st !== "conflict" && st !== "replaced";
      });
      if (!pending.length) continue;
      const { backend: send, results } = await verifiedBackendsFor(
        config,
        chain,
        io,
        true,
        "broadcast",
      );
      if (!send) {
        io.err(
          `${chain.toUpperCase()}: no broadcast backend passed: ${
            results.map((r) => r.detail).join("; ")
          }`,
        );
        continue;
      }
      opened.push(send);
      if (send.chain !== chain) throw new ExecuteError("Internal error: backend chain mismatch");
      let allowed = pending;
      const test = txs.find((t) => t.testFirst);
      if (test && !all) {
        const st = progress.txs[test.file]?.broadcast?.status;
        if (st !== "accepted") {
          allowed = pending.filter((t) => t === test);
          if (allowed.length) {
            io.out(
              `${chain.toUpperCase()}: sending only the TEST FIRST transaction (${test.file}).`,
            );
          }
        } else {
          const tip = await send.tipHeight();
          const d = await confirmationDepth(
            send,
            test,
            progress.txs[test.file].verified!.txid,
            tip,
          );
          if (d.state !== "confirmed") {
            io.out(
              `${chain.toUpperCase()}: waiting for the TEST FIRST transaction to confirm (${d.state}). ` +
                "Run `forksplit track` and try again, or pass --all.",
            );
            allowed = [];
          }
        }
      }
      for (const t of allowed) {
        const v = progress.txs[t.file].verified!;
        // Re-verify the exact bytes about to be sent.
        const again = verifySigned(t, await ownPsbt(dir, t), { tx: parseTx(v.finalHex) });
        if (again.finalHex !== v.finalHex) {
          throw new ExecuteError(`${t.file}: stored transaction changed`);
        }
        if (t.replaces) {
          // A fee bump: its inputs are legitimately spent by the original while that one sits in
          // the mempool, so judge by the two transactions instead of the inputs.
          const tip = await send.tipHeight();
          const mine = await confirmationDepth(send, t, v.txid, tip);
          const at = new Date().toISOString();
          if (mine.state === "confirmed" || mine.state === "mempool") {
            progress.txs[t.file].broadcast = {
              status: "accepted",
              at,
              backend: send.config.url,
              attempts: progress.txs[t.file].broadcast?.attempts ?? 0,
              detail: `already ${mine.state === "confirmed" ? "on chain" : "in the mempool"}`,
            };
            continue;
          }
          const original = await confirmationDepth(send, t, t.replaces.txid, tip);
          if (original.state === "confirmed" || original.state === "conflict") {
            progress.txs[t.file].broadcast = {
              status: "conflict",
              at,
              backend: send.config.url,
              attempts: 0,
              detail: original.state === "confirmed"
                ? "the original transaction confirmed first; nothing left to replace"
                : `the inputs were spent by ${original.by ?? "another transaction"}`,
            };
            io.err(`${t.file}: ${progress.txs[t.file].broadcast!.detail}; not sending`);
            continue;
          }
          queue.push({ t, hex: v.finalHex, txid: v.txid, send });
          continue;
        }
        // Inputs must still be unspent on this chain (or spent by this very transaction).
        let skip = false;
        for (const input of t.inputs) {
          const obs = await send.observeOutput(input.txid, input.vout);
          if (obs.state === "spent" && obs.spendTxid === v.txid) {
            progress.txs[t.file].broadcast = {
              status: "accepted",
              at: new Date().toISOString(),
              backend: send.config.url,
              attempts: progress.txs[t.file].broadcast?.attempts ?? 0,
              detail: "already on chain",
            };
            skip = true;
            break;
          }
          if (obs.state !== "unspent") {
            progress.txs[t.file].broadcast = {
              status: "conflict",
              at: new Date().toISOString(),
              backend: send.config.url,
              attempts: 0,
              detail: `input ${input.txid.slice(0, 8)}:${input.vout} is ${obs.state}`,
            };
            io.err(
              `${t.file}: an input is no longer unspent on ${chain.toUpperCase()}; not sending`,
            );
            skip = true;
            break;
          }
        }
        if (!skip) queue.push({ t, hex: v.finalHex, txid: v.txid, send });
      }
    }
    await saveProgress(dir, progress);
    if (!queue.length) {
      io.out("Nothing to broadcast right now.");
      return 0;
    }
    for (const chain of ["ecx", "xbt"] as const) {
      const items = queue.filter((q) => q.t.chain === chain);
      if (items.length) {
        io.out(
          `${chain.toUpperCase()}: ${items.length} transaction(s) -> ${items[0].send.config.url} (${
            describeRoute(items[0].send.route)
          })`,
        );
      }
    }
    if (!yes && !(await io.confirm("Broadcast these now? Each goes only to its own chain."))) {
      io.out("Nothing sent.");
      return 1;
    }
    let failed = 0;
    for (const q of queue) {
      const entry = progress.txs[q.t.file];
      entry.broadcast = {
        status: "sending",
        at: new Date().toISOString(),
        backend: q.send.config.url,
        attempts: (entry.broadcast?.attempts ?? 0) + 1,
      };
      await saveProgress(dir, progress); // persisted BEFORE sending
      try {
        const got = await q.send.broadcast(q.hex, `broadcast:${q.txid}`);
        if (got !== q.txid) throw new BackendError(`Server answered with a different txid ${got}`);
        entry.broadcast.status = "accepted";
        io.out(`  sent ${q.t.chain.toUpperCase()} ${q.txid}`);
        if (q.t.replaces) await markReplaced(config, q.t, dir, plan.id);
      } catch (error) {
        const explicit = error instanceof BackendError && error.status !== undefined &&
          error.status !== 429;
        entry.broadcast.status = explicit ? "rejected" : "unknown";
        entry.broadcast.detail = (error as Error).message;
        failed++;
        io.err(
          `  ${q.t.file}: ${explicit ? "REJECTED" : "result unknown (will be retried)"}: ${
            (error as Error).message
          }`,
        );
      }
      await saveProgress(dir, progress);
    }
    io.out("Run `forksplit track <plan>` to follow confirmations.");
    return failed ? 1 : 0;
  } finally {
    for (const b of opened) await b.close?.();
  }
}

/** After a fee bump is accepted: record on the original plan that it has been replaced. */
async function markReplaced(
  config: Config,
  replacement: PlannedTx,
  _dir: string,
  newPlanId: string,
) {
  const from = replacement.replaces!;
  try {
    const oldDir = join(config.dataDir, PLANS_DIR, from.plan);
    const oldProgress = await loadProgress(oldDir);
    const entry = oldProgress.txs[from.file];
    if (!entry) return;
    entry.replacedBy = { plan: newPlanId, file: replacement.file };
    if (entry.broadcast) {
      entry.broadcast = { ...entry.broadcast, status: "replaced", detail: `by plan ${newPlanId}` };
    }
    await saveProgress(oldDir, oldProgress);
  } catch { /* the replacement is on the network either way; track still explains the conflict */ }
}

function describeDepth(d: DepthResult, required: number): string {
  switch (d.state) {
    case "confirmed":
      return `${d.depth} of ${required}`;
    case "conflict":
      return `CONFLICT: input spent by ${d.by ?? "another transaction"}`;
    case "unknown":
      return "unknown (this backend can't say; use txindex or an Esplora backend)";
    default:
      return d.state;
  }
}

async function cmdTrack(config: Config, io: CliIO, id: string | undefined) {
  await requireNetworkConfirmed(config);
  if (!id) throw new UsageError("track <plan>");
  const { dir, plan } = await loadPlanDir(config.dataDir, id);
  const progress = await loadProgress(dir);
  const rows = [["Chain", "#", "Txid", "Broadcast", "Confirmations"]];
  const alerts: string[] = [];
  for (const chain of ["ecx", "xbt"] as const) {
    const txs = plan.transactions.filter((t) =>
      t.chain === chain && progress.txs[t.file]?.broadcast
    );
    if (!txs.length) continue;
    const { backend } = await verifiedBackendsFor(config, chain, io, true);
    try {
      const tip = backend ? await backend.tipHeight() : undefined;
      for (const t of txs) {
        const p = progress.txs[t.file];
        let conf = "?";
        if (backend && tip !== undefined && p.verified) {
          const d = await confirmationDepth(backend, t, p.verified.txid, tip);
          const at = new Date().toISOString();
          conf = describeDepth(d, config.chains[chain].confirmations);
          if (p.replacedBy && d.state === "confirmed") {
            // The original won the race: the fee bump can no longer apply.
            conf += "  (the ORIGINAL confirmed)";
            alerts.push(
              `${chain.toUpperCase()} ${t.file}: the original confirmed even though plan ` +
                `${p.replacedBy.plan} was broadcast to replace it. The replacement is now invalid.`,
            );
          } else if (p.replacedBy) {
            // Expected to be gone from the chain: ask about the replacement instead.
            const rp = (await loadProgress(join(config.dataDir, PLANS_DIR, p.replacedBy.plan)))
              .txs[p.replacedBy.file]?.verified?.txid;
            const r = rp ? await confirmationDepth(backend, t, rp, tip) : undefined;
            if (r?.state === "confirmed" || r?.state === "mempool") {
              conf = `REPLACED by plan ${p.replacedBy.plan} (${
                r.state === "confirmed" ? `confirmed, ${r.depth} deep` : "in the mempool"
              })`;
            } else {
              conf += `  (replacement plan ${p.replacedBy.plan} is not on the network)`;
              alerts.push(
                `${chain.toUpperCase()} ${t.file}: plan ${p.replacedBy.plan} replaced this ` +
                  "transaction but the replacement is no longer on the network either. " +
                  "Run `forksplit broadcast` for whichever plan you want to go through.",
              );
            }
          } else {
            const alert = assessReorg(chain, p.confirmations, d);
            if (alert) {
              alerts.push(`${chain.toUpperCase()} ${t.file}: ${alert.detail}`);
              const last = p.reorgs?.[p.reorgs.length - 1];
              if (last?.kind !== alert.kind || last.detail !== alert.detail) {
                p.reorgs = [...(p.reorgs ?? []), { at, kind: alert.kind, detail: alert.detail }];
              }
              if (alert.kind === "dropped" && p.broadcast) {
                // Let `broadcast` send it again (it re-verifies and re-checks the inputs first).
                p.broadcast = {
                  ...p.broadcast,
                  status: "unknown",
                  detail: "left the chain in a reorg",
                };
              }
              if (alert.kind === "conflict" && p.broadcast) {
                p.broadcast = { ...p.broadcast, status: "conflict", detail: alert.detail };
              }
            }
          }
          if (d.state === "confirmed") {
            p.confirmations = { depth: d.depth!, at, height: d.height, blockHash: d.blockHash };
          }
        }
        rows.push([
          chain.toUpperCase(),
          String(t.order),
          p.verified?.txid ?? "-",
          p.broadcast!.status,
          conf,
        ]);
      }
    } finally {
      await backend?.close?.();
    }
  }
  await saveProgress(dir, progress);
  if (rows.length === 1) {
    io.out("Nothing broadcast yet.");
    return 0;
  }
  io.out(table(rows));
  if (alerts.length) {
    io.err("");
    io.err("!!! WARNING: a split did not stay where it was put !!!");
    for (const a of alerts) io.err(`  ${a}`);
    io.err("Until every split is confirmed again, leave the BTC copies alone.");
    return 1;
  }
  io.out(
    "When every split is deep enough, run `forksplit scan`: those coins' BTC copies then show as separated.",
  );
  return 0;
}

async function cmdBump(
  config: Config,
  io: CliIO,
  id: string | undefined,
  opts: { feeRate?: string; chains?: string; tx?: string[]; yes: boolean },
) {
  await requireNetworkConfirmed(config);
  if (!id) throw new UsageError("bump <plan> [--chains ecx,xbt] [--tx N ...] [--fee-rate ecx=5]");
  const { dir, plan } = await loadPlanDir(config.dataDir, id);
  const progress = await loadProgress(dir);
  const rates = parseFeeRates(opts.feeRate);
  const chainFilter = opts.chains?.split(",").map((c) => c.trim());
  if (chainFilter && !chainFilter.every((c) => c === "ecx" || c === "xbt")) {
    throw new UsageError("--chains takes ecx, xbt or ecx,xbt");
  }
  const replacements: PlannedTx[] = [];
  const rows = [["Chain", "#", "State", "Fee", "New fee", "sat/vB", "Result"]];
  let refused = 0;
  const opened: ChainBackend[] = [];
  try {
    for (const chain of ["ecx", "xbt"] as const) {
      if (chainFilter && !chainFilter.includes(chain)) continue;
      const txs = plan.transactions.filter((t) =>
        t.chain === chain && progress.txs[t.file]?.broadcast &&
        (!opts.tx?.length || opts.tx.includes(String(t.order)))
      );
      if (!txs.length) continue;
      const { backend } = await verifiedBackendsFor(config, chain, io, true);
      if (!backend) {
        io.err(`${chain.toUpperCase()}: no backend passed its identity check`);
        refused += txs.length;
        continue;
      }
      opened.push(backend);
      const tip = await backend.tipHeight();
      for (const t of txs) {
        const p = progress.txs[t.file];
        const row = (state: string, result: string, fee = "", rate = "") =>
          rows.push([
            chain.toUpperCase(),
            String(t.order),
            state,
            String(t.fee),
            fee,
            rate,
            result,
          ]);
        if (!p.verified) {
          refused++;
          row("-", "not verified, so not broadcast: nothing to replace");
          continue;
        }
        if (p.replacedBy) {
          refused++;
          row("replaced", `already replaced by plan ${p.replacedBy.plan}; bump that plan instead`);
          continue;
        }
        const d = await confirmationDepth(backend, t, p.verified.txid, tip);
        if (d.state === "confirmed" || d.state === "conflict") {
          refused++;
          row(
            d.state,
            d.state === "confirmed"
              ? `already confirmed (${d.depth} deep): nothing to bump`
              : `its input was spent by ${d.by ?? "another transaction"}: cannot be bumped`,
          );
          continue;
        }
        if (d.state === "unknown") {
          io.err(
            `Warning: ${t.file}: this backend can't tell whether it confirmed; your node will ` +
              "refuse the replacement if it did.",
          );
        }
        const estimate = rates[chain] === undefined ? await backend.feeRate?.(2) : undefined;
        const feeRate = rates[chain] ?? defaultBumpRate(t, estimate);
        try {
          const r = buildReplacement({
            oldPlanId: plan.id,
            old: t,
            oldTxid: p.verified.txid,
            own: await ownPsbt(dir, t),
            feeRate,
            order: replacements.filter((x) => x.chain === chain).length + 1,
          });
          replacements.push(r);
          row(d.state, "replacement", String(r.fee), String(r.feeRate));
        } catch (error) {
          if (!(error instanceof BumpError)) throw error;
          refused++;
          row(d.state, error.message);
        }
      }
    }
  } finally {
    for (const b of opened) await b.close?.();
  }
  if (rows.length === 1) {
    io.out("No broadcast transactions match.");
    return 1;
  }
  io.out(table(rows));
  if (!replacements.length) {
    io.out("Nothing to bump.");
    return refused ? 1 : 0;
  }
  if (!opts.yes && !(await io.confirm(`Write ${replacements.length} replacement PSBT(s)?`))) {
    io.out("Nothing written.");
    return 1;
  }
  const taken = new Set<string>();
  try {
    for await (const e of Deno.readDir(join(config.dataDir, PLANS_DIR))) taken.add(e.name);
  } catch { /* none yet */ }
  let n = 1;
  while (taken.has(`${plan.id}-bump${n}`)) n++;
  const bumped = bumpPlan(plan, `${plan.id}-bump${n}`, replacements, new Date());
  const newDir = await writePlan(config.dataDir, bumped);
  io.out(`\nWrote ${replacements.length} replacement PSBT(s) to ${newDir}`);
  io.out(
    `Sign them in your wallet exactly like the originals, then:\n` +
      `  forksplit verify ${bumped.id}\n  forksplit broadcast ${bumped.id}\n  forksplit track ${bumped.id}\n` +
      "If the original confirms first, the replacement is simply refused.",
  );
  return refused ? 1 : 0;
}

async function cmdUi(
  dataDir: string,
  io: CliIO,
  portFlag: string | undefined,
  open: boolean,
): Promise<number> {
  const port = portFlag === undefined ? 0 : Number(portFlag);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError("--port must be 0-65535");
  }
  const { startUi } = await import("../ui/server.ts");
  const { out: _o, err: _e, confirm: _c, ...baseIO } = io;
  const ui = startUi({ dataDir, port, run: main, baseIO });
  io.out(`forksplit UI: ${ui.url}`);
  io.out(
    "Open that exact URL (it carries a one-time access token). Only this machine can reach it.",
  );
  io.out("Press Ctrl+C to stop; a Tor started by forksplit stops with it.");
  if (open) {
    const opener = Deno.build.os === "darwin"
      ? "open"
      : Deno.build.os === "windows"
      ? "explorer"
      : "xdg-open";
    try {
      new Deno.Command(opener, { args: [ui.url], stdout: "null", stderr: "null" }).spawn();
    } catch {
      io.err("Couldn't open a browser; copy the URL above.");
    }
  }
  await ui.server.finished;
  return 0;
}

/** Process entry point: runs a command, then always stops a Tor this process started. */
export async function run(argv: string[]): Promise<never> {
  const onSignal = async () => {
    await torManager.stop();
    Deno.exit(130);
  };
  Deno.addSignalListener("SIGINT", onSignal);
  if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", onSignal);
  let code = 1;
  try {
    code = await main(argv);
  } finally {
    await torManager.stop();
  }
  Deno.exit(code);
}

if (import.meta.main) await run(Deno.args);
