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
import { loadScan, runScan, saveScan } from "../core/scan.ts";
import { classify } from "../core/state.ts";
import { defaultDataDir, ensureDir } from "../core/store.ts";
import { importDescriptor, loadWallet, parsedDescriptors, saveWallet } from "../core/wallet.ts";
import { describeRoute, PolicyError, TorUnavailableError } from "../net/transport.ts";
import { parseDescriptor } from "../core/descriptors.ts";
import {
  buildPlan,
  type ForkChain,
  parseBatchPolicy,
  PlanError,
  PLANS_DIR,
  writePlan,
  XBT_SIGNERS,
} from "../core/planner.ts";
import { join } from "node:path";
import { observationCell, privacyLevel, sats, shortOutpoint, table } from "./format.ts";

const USAGE = `forksplit - separate BTC, XBT and ECX copies of the same coins (watch-only)

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
  config tor <host:port>          Tor SOCKS address (default 127.0.0.1:9050)
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

Global options:
  --data-dir DIR    (env FORKSPLIT_DATA_DIR)   --tor-socks HOST:PORT (env FORKSPLIT_TOR_SOCKS)
  --profile ID      (env FORKSPLIT_PROFILE)    --json   -h, --help
`;

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
  confirm: (question: string) => boolean;
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
      error instanceof PlanError ||
      error instanceof DescriptorError || error instanceof PolicyError ||
      error instanceof TorUnavailableError
    ) {
      io.err(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

// ---- config ----

function showConfig(config: Config, io: CliIO, confirmed: boolean): void {
  io.out(
    `Profile: ${config.profile.id}    Tor SOCKS: ${config.torSocks.host}:${config.torSocks.port}`,
  );
  io.out(`Data directory: ${config.dataDir}`);
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
  const explicit = (chain: ChainId): Record<string, unknown>[] => {
    chains[chain] ??= {};
    if (!Array.isArray(chains[chain].backends)) {
      // Keep the profile default as a lower-priority backend so the one being added is tried first.
      chains[chain].backends = effective
        ? effective.chains[chain].backends.map((b) =>
          backendToToml(b.origin === "profile-default" ? { ...b, priority: 10 } : b)
        )
        : [];
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
      const list = explicit(chain).filter((b) => b.url !== backend.url);
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
    if (!rest[0]) throw new UsageError("config tor <host:port>");
    parseSocks(rest[0]);
    file.tor = { socks: rest[0] };
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

async function verifiedBackendsFor(
  config: Config,
  chain: ChainId,
  io: CliIO,
  quiet = false,
): Promise<{ backend?: ChainBackend; results: { url: string; ok: boolean; detail: string }[] }> {
  const results: { url: string; ok: boolean; detail: string }[] = [];
  let chosen: ChainBackend | undefined;
  for (const b of config.chains[chain].backends.filter((b) => b.role !== "broadcast")) {
    let ok = false;
    let detail: string;
    try {
      const backend = await createBackend(config, chain, b, {
        transportFactory: io.transportFactory,
        streamFactory: io.streamFactory,
        env: io.env,
      });
      const r = await verifyIdentity(backend, config.profile.chains[chain]);
      ok = r.ok;
      detail = r.detail;
      if (ok && !chosen) chosen = backend;
      else await backend.close?.();
    } catch (error) {
      detail = (error as Error).message;
    }
    results.push({ url: b.url, ok, detail });
    if (!quiet) io.out(`  ${ok ? "OK  " : "FAIL"} ${b.url}\n       ${detail}`);
  }
  return { backend: chosen, results };
}

async function cmdInit(config: Config, io: CliIO, yes: boolean): Promise<number> {
  showConfig(config, io, await networkConfirmed(config));
  io.out(
    "Checking each backend is reachable and on the right chain. These checks ask only for the\n" +
      "chain tip and a few fixed block hashes; nothing about your coins is sent.\n",
  );
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
  if (!yes && !io.confirm("Use these network settings for importing and scanning your coins?")) {
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
    if (!opts.yes && !io.confirm("Write these PSBTs (and reserve their destination addresses)?")) {
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

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
