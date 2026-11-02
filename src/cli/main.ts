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
import type { ProgressSink } from "../core/progress.ts";
import {
  archivedAt,
  archivePlan,
  classifySpender,
  deletePlan,
  deletionNotes,
  followReplacement,
  ownTransactions,
  type OwnTx,
  PlanAdminError,
  planFolder,
  replacedByReferences,
  unarchivePlan,
  unsentReplacements,
  unsettledTransactions,
} from "../core/plan_admin.ts";
import {
  describeDonor,
  donorKey,
  evaluateDonors,
  loadDonorScan,
  protectedTxids,
  saveDonorScan,
} from "../core/donors.ts";
import { buildFanout, donorDescriptors } from "../core/fanout.ts";
import {
  loadScan,
  newSharedCoins,
  runScan,
  saveScan,
  scanRegressions,
  type ScanResult,
} from "../core/scan.ts";
import { classify } from "../core/state.ts";
import { defaultDataDir, ensureDir } from "../core/store.ts";
import {
  importDescriptor,
  importDonorDescriptor,
  loadWallet,
  parsedDescriptors,
  saveWallet,
} from "../core/wallet.ts";
import {
  describeRoute,
  PolicyError,
  type SocksEndpoint,
  TorUnavailableError,
} from "../net/transport.ts";
import { torManager, TorStartError } from "../net/tor.ts";
import { networkForProfile, parseDescriptor } from "../core/descriptors.ts";
import {
  buildPlan,
  parseBatchPolicy,
  type Plan,
  type PlanChain,
  PlanError,
  type PlannedTx,
  PLANS_DIR,
  writePlan,
  XBT_SIGNERS,
} from "../core/planner.ts";
import { join } from "node:path";
import { buildCpfp, buildReplacement, BumpError, bumpPlan, defaultBumpRate } from "../core/bump.ts";
import {
  alertTitle,
  applyReplaced,
  assessReorg,
  confirmationDepth,
  type DepthResult,
  ExecuteError,
  findSignedFiles,
  type GateCheck,
  gateProblems,
  lastSeenInBlock,
  loadPlanDir,
  loadProgress,
  matchArtifacts,
  mempoolChecks,
  type MempoolNode,
  nextConfirmations,
  nextUnmined,
  ownPsbt,
  recordReorg,
  resolveReorgs,
  retractConflicts,
  saveProgress,
  type SentContext,
  type TxProgress,
  verifySigned,
  withinDropGrace,
} from "../core/execute.ts";
import { SigCheckError } from "../core/sigcheck.ts";
import { describeTestFirst, type TestFirstStatus } from "../core/test_first.ts";
import { parseTx } from "../core/tx.ts";
import { BackendError } from "../backends/types.ts";
import { observationCell, privacyLevel, sats, shortOutpoint, table } from "./format.ts";

const USAGE =
  `splayed - separate BTC, XBT and ECX copies of the same coins (keyless: your wallet signs)

Usage: splayed [global options] <command> [args]

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
                                  auto (default): use a running Tor, else start splayed's own.
                                  system: only a Tor you run (e.g. 127.0.0.1:9150 for Tor
                                  Browser). managed: always start splayed's own Tor.
  config confirmations <chain> N  Depth required before a spend counts as final
  config scan [--gap-limit N] [--jitter MIN-MAX]
                                  Unused addresses checked past the last used one (1-1000,
                                  default 20), and the random pause in ms between lookups on
                                  remote backends (default 150-900). More addresses and less
                                  jitter reveal more to a public backend.

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
  plan --xbt-signer NAME | --donor txid:vout ... [--chains ecx,xbt] [--batch coin|address|all|N]
       [--fee-rate ecx=2,xbt=3] [--coin txid:vout ...] [--yes]
                                  Write unsigned, replay-protected PSBTs for shared coins.
                                  XBT signers: ${Object.keys(XBT_SIGNERS).join(", ")}
  donor import <descriptor> [--label L] | donor list | donor forget <number>
  donor scan [--rpc-range N] | donor show
  donor fanout --donor txid:vout ... --outputs N [--value SATS] [--fee-rate xbt=N] [--yes]
                                  Split each chosen donor into N smaller donors of your donor
                                  wallet (one transaction per donor, so donors stay unlinked)
                                  Advanced XBT donor route (opt-in): a donor wallet of coins that
                                  exist on XBT only lets a stock hardware wallet make the XBT
                                  split with plain SIGHASH_ALL signatures. Donors are checked
                                  absent on BTC and ECX and must come from an XBT coinbase or a
                                  split this tool verified. See docs/user/advanced-donor-routes.md.
  plans                           List written plans (archived ones separately)
  plans archive <plan>            Hide a plan from the list; nothing is deleted
  plans unarchive <plan>          Bring an archived plan back
  plans delete <plan> [--yes]     Delete a plan's folder for good. Refused while any of its
                                  transactions was sent and isn't confirmed yet
  verify <plan> [signed files...] [--no-mempool]
                                  Check signed PSBTs/transactions: same tx as planned, replay
                                  marker (ECX) or 0x21 on every signature (XBT), every signature
                                  valid, fee as planned. With your own RPC nodes configured, also
                                  asks each one (testmempoolaccept) - the target chain must accept
                                  and the other chains must reject.
  broadcast <plan> [--all] [--yes]
                                  Send verified transactions, each only to its own chain, each
                                  over its own Tor circuit. On each chain the TEST FIRST
                                  transaction goes alone first; the next run says where it is and
                                  asks before sending the rest (--yes answers yes, --all sends
                                  everything at once). Sends again a split that dropped out of the
                                  mempool. Says why for each transaction it doesn't send.
  track <plan>                    Confirmations of broadcast transactions. Warns loudly (exit 1)
                                  if a split that was confirmed leaves the chain or is re-mined in
                                  another block, a sent split drops out of the mempool, or its
                                  input is spent by a transaction that isn't one of your plans;
                                  and while any such alert is open.
  bump <plan> [--chains ecx,xbt] [--tx N ...] [--fee-rate ecx=5,xbt=8] [--another] [--yes]
                                  Stuck split? Write a new plan that spends the same inputs at a
                                  higher fee (RBF, BIP125). Sign, verify and broadcast it like any
                                  plan; nodes replace the original with it. Refused while a bump
                                  of the same transaction is written and not sent (--another: anyway).
  bump <plan> --tx N --drop txid:vout [--drop ...]
                                  Replace one transaction of a batch without some of its coins; the
                                  dropped coins stay unspent and can go in a later plan.
  bump <plan> --cpfp [--chains ecx,xbt] [--tx N ...] --fee-rate ecx=20
                                  Can't replace the original? Write a child that spends its output
                                  so the pair pays that rate. The rate is for the PAIR; the child
                                  goes to a fresh address of the same destination.

Web UI:
  ui [--port N] [--open]          Local web interface (127.0.0.1 only) that runs these same
                                  commands, prompts included

Global options:
  --data-dir DIR    (env SPLAYED_DATA_DIR)   --tor-socks HOST:PORT (env SPLAYED_TOR_SOCKS)
  --profile ID      (env SPLAYED_PROFILE)    --json   -h, --help
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
  /** Structured progress for the web UI. Unset in the terminal, which has its log lines. */
  progress?: ProgressSink;
}

const defaultIO: CliIO = {
  out: (t) => console.log(t),
  err: (t) => console.error(t),
  confirm: (q) => confirm(q),
  env: Deno.env.toObject(),
};

class UsageError extends Error {}
/** A command refused for a reason that has nothing to do with how it was typed: no USAGE dump. */
class RefusedError extends Error {}

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
        "gap-limit": { type: "string" },
        jitter: { type: "string" },
        "start-index": { type: "string" },
        "xbt-signer": { type: "string" },
        donor: { type: "string", multiple: true },
        outputs: { type: "string" },
        value: { type: "string" },
        chains: { type: "string" },
        batch: { type: "string" },
        "fee-rate": { type: "string" },
        coin: { type: "string", multiple: true },
        all: { type: "boolean" },
        port: { type: "string" },
        open: { type: "boolean" },
        "no-mempool": { type: "boolean" },
        "btc-first": { type: "boolean" },
        cpfp: { type: "boolean" },
        another: { type: "boolean" },
        drop: { type: "string", multiple: true },
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
  const dataDir = flags["data-dir"] ?? io.env.SPLAYED_DATA_DIR ?? defaultDataDir();
  try {
    await ensureDir(dataDir);
    if (command === "config" && args[0] !== "show") {
      await editConfig(dataDir, args, flags, io);
      io.out("Saved. Network settings changed: run `splayed init` to review and confirm them.");
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
          donors: flags.donor as string[] | undefined,
          btcFirst: flags["btc-first"] === true,
          yes: flags.yes === true,
        });
      case "donor":
        return await cmdDonor(config, io, args, flags.label, flags["rpc-range"], {
          donors: flags.donor as string[] | undefined,
          outputs: flags.outputs,
          value: flags.value,
          feeRate: flags["fee-rate"],
          yes: flags.yes === true,
        });
      case "plans":
        return await cmdPlans(config, io, args, flags.yes === true);
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
          drop: flags.drop as string[] | undefined,
          cpfp: flags.cpfp === true,
          another: flags.another === true,
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
      error instanceof ExecuteError || error instanceof PlanAdminError ||
      error instanceof RefusedError ||
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
      return `auto (use a running Tor at ${where}, else start splayed's own)`;
    case "system":
      return `system (only the Tor running at ${t.socks ? where : "127.0.0.1:9050"})`;
    case "managed":
      return `managed (splayed starts its own Tor${t.binary ? `: ${t.binary}` : ""})`;
  }
}

function showConfig(config: Config, io: CliIO, confirmed: boolean): void {
  io.out(
    `Profile: ${config.profile.id}    Tor SOCKS: ${config.torSocks.host}:${config.torSocks.port}`,
  );
  io.out(`Data directory: ${config.dataDir}`);
  io.out(`Tor: ${describeTor(config)}`);
  io.out(`Network settings confirmed: ${confirmed ? "yes" : "NO (run `splayed init`)"}\n`);
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
  } else if (sub === "scan") {
    // config scan [--gap-limit N] [--jitter MIN-MAX]; ranges are checked by loadConfig below.
    const scan = (file.scan ?? {}) as Record<string, unknown>;
    if (rest.length) throw new UsageError("config scan [--gap-limit N] [--jitter MIN-MAX]");
    if (flags["gap-limit"] === undefined && flags.jitter === undefined) {
      throw new UsageError("config scan needs --gap-limit N and/or --jitter MIN-MAX");
    }
    if (flags["gap-limit"] !== undefined) {
      const n = Number(flags["gap-limit"]);
      if (!Number.isSafeInteger(n)) throw new UsageError("--gap-limit must be a whole number");
      scan.gap_limit = n;
    }
    if (flags.jitter !== undefined) {
      const m = /^(\d+)-(\d+)$/u.exec(String(flags.jitter));
      if (!m) throw new UsageError("--jitter must look like MIN-MAX in milliseconds, e.g. 150-900");
      scan.jitter_min_ms = Number(m[1]);
      scan.jitter_max_ms = Number(m[2]);
    }
    file.scan = scan;
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
  io.progress?.({ phase: "tor", chain, detail: "connecting through Tor" });
  // The manager is shared by every command in this process; report its state only while this
  // command is waiting on it.
  const unsubscribe = io.progress
    ? torManager.onChange((s) => {
      if (s.state === "starting") {
        io.progress?.({ phase: "tor", chain, done: s.progress, total: 100, detail: s.summary });
      }
    })
    : undefined;
  try {
    config.torSocks = await provider(config, (m) => io.out(m));
  } finally {
    unsubscribe?.();
  }
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
      io.progress?.({
        phase: "identity",
        chain,
        done: i + 1,
        total: candidates.length,
        detail: "checking server",
      });
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
      "Nothing was contacted. Change settings with `splayed config ...`, then run init again.",
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
        "Fix the settings (`splayed config ...`) or start Tor, then run `splayed init` again.",
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
    "Network settings confirmed. Next: `splayed import '<descriptor>'`, then `splayed scan`.",
  );
  return 0;
}

// ---- descriptors ----

async function cmdImport(config: Config, args: string[], label: string | undefined, io: CliIO) {
  await requireNetworkConfirmed(config);
  if (!args[0]) throw new UsageError("import <descriptor>");
  const { parsed, added } = await importDescriptor(
    config.dataDir,
    args[0],
    label,
    networkForProfile(config.profile),
  );
  io.out(added ? "Imported (watch-only):" : "Already imported:");
  io.out(`  ${parsed.normalized}`);
  if (!parsed.hadChecksum) io.out("  (no checksum was given; one has been added)");
  if (/\b[tuvyzTUVYZ]pub/u.test(args[0])) {
    io.out("  (your extended key is stored as the equivalent xpub; addresses are unchanged)");
  }
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
    throw new UsageError("forget <number from `splayed descriptors`>");
  }
  const [removed] = wallet.descriptors.splice(n - 1, 1);
  await saveWallet(config.dataDir, wallet);
  io.out(`Removed ${removed.descriptor}`);
  return 0;
}

// ---- scan / status ----

/** Identity-checked read backends for all three chains (a chain may be missing if none passed). */
async function openAllBackends(config: Config, io: CliIO) {
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
  return backends;
}

async function cmdScan(config: Config, io: CliIO, rpcRangeFlag?: string) {
  await requireNetworkConfirmed(config);
  const wallet = await loadWallet(config.dataDir);
  if (!wallet.descriptors.length) throw new RefusedError("Import a descriptor first");
  const rpcRange = rpcRangeFlag ? Number(rpcRangeFlag) : undefined;
  if (
    rpcRange !== undefined &&
    (!Number.isSafeInteger(rpcRange) || rpcRange < 1 || rpcRange > 100_000)
  ) {
    throw new UsageError("--rpc-range must be between 1 and 100000");
  }
  const backends = await openAllBackends(config, io);
  let result;
  try {
    result = await runScan(config, parsedDescriptors(wallet, networkForProfile(config.profile)), {
      backends,
      log: (m) => io.out(m),
      progress: io.progress,
      rpcRange,
    });
  } finally {
    for (const b of Object.values(backends)) await b?.close?.();
  }
  const previous = await loadScan(config.dataDir);
  result.warnings.push(...scanRegressions(previous, result));
  result.newShared = newSharedCoins(previous, result, confirmationsOf(config));
  await saveScan(config.dataDir, result);
  for (const w of result.warnings) io.err(`Warning: ${w}`);
  io.out("");
  printStatus(config, result, io);
  printNewShared(result, io);
  // New shared coins aren't a scan failure (exit 1 stays for warnings): they are listed in
  // scan.json under `newShared` for scripts and the web UI.
  return result.warnings.length ? 1 : 0;
}

function confirmationsOf(config: Config): Record<ChainId, number> {
  return Object.fromEntries(
    CHAIN_IDS.map((c) => [c, config.chains[c].confirmations]),
  ) as Record<ChainId, number>;
}

const PREVIOUSLY: Record<string, string> = {
  absent: "not in the previous scan",
  separated: "was separated at the previous scan (a split left the chain?)",
  pending: "was pending at the previous scan (a split left the chain?)",
  spent: "was spent everywhere at the previous scan",
  unverified: "was unverified at the previous scan (a chain couldn't be asked)",
};

/** The "coins that turn up later" warning, on stderr so it stands out from the table. */
function printNewShared(result: ScanResult, io: CliIO) {
  const coins = result.newShared ?? [];
  if (!coins.length) return;
  const lines = [
    "",
    `!! NEW SHARED COINS: ${coins.length} coin${
      coins.length === 1 ? "" : "s"
    } turned up since an earlier scan`,
    ...coins.map((c) =>
      `   ${c.txid}:${c.vout}\n     ${sats(c.value)}, unspent on ${
        c.unspentOn.join("+").toUpperCase()
      }, ${PREVIOUSLY[c.previously] ?? c.previously}; first seen ${c.firstSeen}`
    ),
    "   These coins are still shared: one transaction spending them is valid on every chain",
    "   listed. Don't spend them on BTC until they are split, even if your other coins are",
    "   done: that spend would replay onto the forks and you could lose those copies.",
    "   Plan them like the others: `splayed plan ...` (add `--coin txid:vout` to plan only these),",
    "   then sign, verify and broadcast. Expected after importing another wallet or raising the",
    "   gap limit; a deposit to an old address or a split that left the chain also shows up here.",
  ];
  for (const line of lines) io.err(line);
}

async function cmdStatus(config: Config, io: CliIO, json: boolean) {
  const result = await loadScan(config.dataDir);
  if (!result) {
    io.out("No scan yet. Run `splayed scan`.");
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
  printNewShared(result, io);
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
    for (const chain of ["btc", "ecx", "xbt"] as const) {
      const d = wallet.destinations?.[chain];
      if (chain === "btc" && !d) continue; // only the BTC-first route uses a BTC destination
      io.out(
        `${chain.toUpperCase()}: ${
          d ? `${d.descriptor}\n     next index ${d.nextIndex}` : "(not set)"
        }`,
      );
    }
    return 0;
  }
  if (action !== "set") throw new UsageError("dest set <xbt|ecx|btc> <descriptor> | dest show");
  await requireNetworkConfirmed(config);
  if (chainArg !== "xbt" && chainArg !== "ecx" && chainArg !== "btc") {
    throw new UsageError(
      "Destinations are per chain: xbt or ecx (btc only for the BTC-first route)",
    );
  }
  if (!descriptor) throw new UsageError("dest set <xbt|ecx|btc> <descriptor>");
  const parsed = parseDescriptor(descriptor, networkForProfile(config.profile));
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

function parseFeeRates(value: string | undefined): Partial<Record<PlanChain, number>> {
  const out: Partial<Record<PlanChain, number>> = {};
  if (!value) return out;
  for (const part of value.split(",")) {
    const [chain, rate] = part.split("=");
    const n = Number(rate);
    if ((chain !== "ecx" && chain !== "xbt" && chain !== "btc") || !(n > 0)) {
      throw new UsageError(
        "--fee-rate looks like ecx=2,xbt=3 (sat/vB; btc=N on the BTC-first route)",
      );
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
    donors?: string[];
    btcFirst?: boolean;
    yes: boolean;
  },
) {
  await requireNetworkConfirmed(config);
  const scan = await loadScan(config.dataDir);
  if (!scan) throw new RefusedError("Run `splayed scan` first");
  const chains = (opts.chains ?? (opts.btcFirst ? "btc,ecx,xbt" : "ecx,xbt")).split(",").map((c) =>
    c.trim()
  );
  const allowed = opts.btcFirst ? ["btc", "ecx", "xbt"] : ["ecx", "xbt"];
  if (!chains.every((c) => allowed.includes(c)) || !chains.length) {
    throw new UsageError(
      opts.btcFirst
        ? "--chains takes btc, ecx, xbt (any of them)"
        : "--chains takes ecx, xbt or ecx,xbt",
    );
  }
  if (opts.btcFirst && !chains.includes("btc")) {
    throw new UsageError("The BTC-first route splits BTC: --chains must include btc");
  }
  // BTC first, then ECX, then XBT: the order the gate depends on.
  chains.sort((a, b) => ["btc", "ecx", "xbt"].indexOf(a) - ["btc", "ecx", "xbt"].indexOf(b));
  const wallet = await loadWallet(config.dataDir);
  const backends: Partial<Record<PlanChain, ChainBackend>> = {};
  try {
    io.out("Re-checking backend identity…");
    for (const chain of chains as PlanChain[]) {
      const { backend, results } = await verifiedBackendsFor(config, chain, io, true);
      if (!backend) {
        throw new PlanError(
          `${chain.toUpperCase()}: no backend passed: ${results.map((r) => r.detail).join("; ")}`,
        );
      }
      backends[chain] = backend;
    }
    const plan = await buildPlan(config, scan, wallet, {
      chains: chains as PlanChain[],
      btcFirst: opts.btcFirst,
      batch: parseBatchPolicy(opts.batch),
      feeRates: parseFeeRates(opts.feeRate),
      xbtSigner: opts.xbtSigner,
      coins: opts.coins,
      donors: opts.donors,
    }, {
      backends,
      log: (m) => io.out(m),
      donors: opts.donors?.length
        ? {
          coins: (await loadDonorScan(config.dataDir))?.coins ?? [],
          descriptors: (wallet.donors ?? []).map((d) =>
            parseDescriptor(d.descriptor, networkForProfile(config.profile))
          ),
        }
        : undefined,
    });
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
    for (const chain of ["btc", "ecx", "xbt"] as const) {
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
    for (const [chain, next] of Object.entries(plan.reserved) as [PlanChain, number][]) {
      const d = fresh.destinations?.[chain];
      if (d && next > d.nextIndex) d.nextIndex = next;
    }
    await saveWallet(config.dataDir, fresh);
    io.out(`\nWrote ${plan.transactions.length} PSBT(s) to ${dir}`);
    io.out(
      plan.transactions.some((t) => t.testFirst)
        ? "Read README.txt there before signing. Sign the TEST FIRST transaction on each chain first."
        : "Read README.txt there before signing.",
    );
    return 0;
  } finally {
    for (const b of Object.values(backends)) await b?.close?.();
  }
}

async function cmdDonor(
  config: Config,
  io: CliIO,
  args: string[],
  label: string | undefined,
  rpcRangeFlag: string | undefined,
  fan: { donors?: string[]; outputs?: string; value?: string; feeRate?: string; yes: boolean } = {
    yes: false,
  },
) {
  const [action, arg] = args;
  const network = networkForProfile(config.profile);
  const wallet = await loadWallet(config.dataDir);
  const donors = wallet.donors ?? [];
  const usage =
    "donor import <descriptor> | list | forget <number> | scan | show | fanout --donor txid:vout --outputs N";
  switch (action) {
    case "import": {
      await requireNetworkConfirmed(config);
      if (!arg) throw new UsageError(usage);
      if (
        wallet.descriptors.some((d) => d.descriptor === parseDescriptor(arg, network).normalized)
      ) {
        throw new RefusedError(
          "That descriptor is already in your main wallet. A donor wallet must hold coins that " +
            "exist on XBT only: use a separate wallet for donors.",
        );
      }
      const { parsed, added } = await importDonorDescriptor(config.dataDir, arg, label, network);
      io.out(added ? "Donor wallet imported (watch-only):" : "Already imported as a donor wallet:");
      io.out(`  ${parsed.normalized}`);
      io.out("First addresses (fund these on XBT only):");
      for (const branch of parsed.branches) {
        io.out(`  branch ${branch.branch}: ${branch.derive(0).address}`);
      }
      return 0;
    }
    case "list":
    case undefined: {
      if (!donors.length) {
        io.out("No donor wallets imported. `splayed donor import <descriptor>`");
      }
      donors.forEach((d, i) =>
        io.out(`${i + 1}. ${d.label ? `[${d.label}] ` : ""}${d.descriptor}`)
      );
      return 0;
    }
    case "forget": {
      const n = Number(arg);
      if (!Number.isSafeInteger(n) || n < 1 || n > donors.length) {
        throw new UsageError("donor forget <number from `donor list`>");
      }
      donors.splice(n - 1, 1);
      wallet.donors = donors;
      await saveWallet(config.dataDir, wallet);
      io.out("Removed. Run `donor scan` again: donor numbers in the last scan are now stale.");
      return 0;
    }
    case "scan": {
      await requireNetworkConfirmed(config);
      if (!donors.length) throw new RefusedError("Import a donor wallet first: donor import");
      const rpcRange = rpcRangeFlag ? Number(rpcRangeFlag) : undefined;
      const backends = await openAllBackends(config, io);
      try {
        const result = await runScan(
          config,
          donors.map((d) => parseDescriptor(d.descriptor, network)),
          {
            backends,
            log: (m) => io.out(m),
            rpcRange,
          },
        );
        const evaluated = await evaluateDonors(
          result,
          backends,
          { xbt: config.chains.xbt.confirmations, btc: config.chains.btc.confirmations },
          {
            xbt: await protectedTxids(config.dataDir, "xbt"),
            btc: await protectedTxids(config.dataDir, "btc"),
          },
        );
        await saveDonorScan(config.dataDir, evaluated);
      } finally {
        for (const b of Object.values(backends)) await b?.close?.();
      }
      return await cmdDonor(config, io, ["show"], undefined, undefined);
    }
    case "fanout": {
      await requireNetworkConfirmed(config);
      if (!fan.donors?.length || !fan.outputs) {
        throw new UsageError(
          "donor fanout --donor txid:vout [--donor ...] --outputs N [--value SATS]",
        );
      }
      const scan = await loadDonorScan(config.dataDir);
      if (!scan) throw new RefusedError("Run `splayed donor scan` first");
      const outputCount = Number(fan.outputs);
      if (!Number.isSafeInteger(outputCount) || outputCount < 2 || outputCount > 100) {
        throw new PlanError("--outputs must be a whole number from 2 to 100");
      }
      // The donors' chain: all must live on the same one.
      const homes = new Set(fan.donors.map((key) => {
        const coin = scan.coins.find((c) => donorKey(c) === key);
        return (coin?.home ?? "xbt") as "xbt" | "btc";
      }));
      if (homes.size !== 1) {
        throw new PlanError("Fan out donors of one chain at a time (XBT donors, or BTC donors)");
      }
      const chain = [...homes][0];
      const H = chain.toUpperCase();
      const { backend, results } = await verifiedBackendsFor(config, chain, io, true);
      if (!backend) {
        throw new PlanError(`${H}: no backend passed: ${results.map((r) => r.detail).join("; ")}`);
      }
      try {
        let feeRate = parseFeeRates(fan.feeRate)[chain];
        if (feeRate === undefined) {
          feeRate = await backend.feeRate?.(6).catch(() => undefined);
          if (feeRate === undefined) {
            throw new PlanError(
              `No fee estimate from the ${H} backend; pass --fee-rate ${chain}=N`,
            );
          }
          feeRate = Math.max(1, Math.ceil(feeRate * 100) / 100);
        }
        const value = fan.value === undefined ? undefined : Number(fan.value);
        if (value !== undefined && !(Number.isSafeInteger(value) && value > 0)) {
          throw new UsageError("--value is a whole number of sats");
        }
        const { plan, nextIndex } = await buildFanout(config, wallet, {
          donors: fan.donors,
          outputs: Number(fan.outputs),
          value,
          feeRate,
        }, {
          chain,
          backend,
          donors: { coins: scan.coins, descriptors: donorDescriptors(wallet, config) },
        });
        for (const w of plan.warnings) io.err(`Warning: ${w}`);
        const rows = [["#", "Donor", "Value in", "New donors", "Fee", "sat/vB"]];
        for (const tx of plan.transactions) {
          rows.push([
            String(tx.order),
            shortOutpoint(tx.inputs[0].txid, tx.inputs[0].vout),
            sats(tx.inputs[0].value),
            `${tx.outputs!.length} × ${tx.outputs!.map((o) => o.value).join(", ")}`,
            String(tx.fee),
            String(tx.feeRate),
          ]);
        }
        io.out(table(rows));
        if (!fan.yes && !(await io.confirm("Write these fan-out PSBTs?"))) {
          io.out("Nothing written.");
          return 1;
        }
        const dir = await writePlan(config.dataDir, plan);
        const fresh = await loadWallet(config.dataDir);
        for (const [di, next] of nextIndex) {
          const d = fresh.donors?.[di];
          if (d && next > (d.nextIndex ?? 0)) d.nextIndex = next;
        }
        await saveWallet(config.dataDir, fresh);
        io.out(`\nWrote ${plan.transactions.length} PSBT(s) to ${dir}`);
        io.out(
          "Sign with the donor wallet (plain SIGHASH_ALL), then verify and broadcast this plan. " +
            "Once it is broadcast, run `donor scan` to see the new donors.",
        );
        return 0;
      } finally {
        await backend.close?.();
      }
    }
    case "show": {
      const scan = await loadDonorScan(config.dataDir);
      if (!scan) {
        io.out("No donor scan yet. Run `splayed donor scan`.");
        return 0;
      }
      for (const w of scan.warnings) io.err(`Warning: ${w}`);
      if (!scan.coins.length) {
        io.out("No donor coins found.");
        return 0;
      }
      const rows = [["Donor", "Value", "Origin / verdict"]];
      for (const c of scan.coins) rows.push([donorKey(c), sats(c.value), describeDonor(c)]);
      io.out(table(rows));
      const usable = scan.coins.filter((c) => c.eligible).length;
      io.out(
        `${usable} usable donor(s). Use them with: plan --donor txid:vout (one per XBT transaction).`,
      );
      return 0;
    }
    default:
      throw new UsageError(usage);
  }
}

async function cmdPlans(config: Config, io: CliIO, args: string[], yes: boolean) {
  const [action, id, ...extra] = args;
  if (action !== undefined) {
    if (!id || extra.length) throw new UsageError("plans archive|unarchive|delete <plan>");
    if (action === "archive") {
      await archivePlan(config.dataDir, id);
      io.out(
        `Archived plan ${id}. Its folder is kept; \`splayed plans unarchive ${id}\` undoes it.`,
      );
      return 0;
    }
    if (action === "unarchive") {
      await unarchivePlan(config.dataDir, id);
      io.out(`Plan ${id} is back in the list.`);
      return 0;
    }
    if (action === "delete") {
      const { dir, plan } = await planFolder(config.dataDir, id);
      const unsettled = await unsettledTransactions(config, dir, plan);
      if (unsettled.length || (await replacedByReferences(config.dataDir, plan.id)).length) {
        // deletePlan refuses too; say it before asking anything.
        await deletePlan(config, id);
      }
      for (const note of await deletionNotes(dir, plan)) io.out(`Note: ${note}`);
      if (!yes && !(await io.confirm(`Delete plan ${id} and all its files for good?`))) {
        io.out("Nothing deleted.");
        return 1;
      }
      await deletePlan(config, id);
      io.out(`Deleted plan ${id}.`);
      return 0;
    }
    throw new UsageError("plans archive|unarchive|delete <plan>");
  }
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
  const archived: string[] = [];
  for (const id of ids.sort()) {
    if (await archivedAt(join(dir, id))) archived.push(id);
    else io.out(`${id}  ${join(dir, id)}`);
  }
  if (archived.length) {
    io.out(`Archived (${archived.length}):`);
    for (const id of archived) io.out(`  ${id}  ${join(dir, id)}`);
  }
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

/**
 * A donor transaction is replay-protected only while its donor is absent from every other chain. Ask
 * them again right before sending; refuse if any can't be asked or has the donor.
 */
async function donorPreflight(
  config: Config,
  io: CliIO,
  donor: { txid: string; vout: number },
  home: "xbt" | "btc",
  opened: ChainBackend[],
) {
  for (const chain of (["btc", "xbt", "ecx"] as const).filter((c) => c !== home)) {
    const { backend, results } = await verifiedBackendsFor(config, chain, io, true);
    if (!backend) {
      throw new ExecuteError(
        `Can't confirm the donor is absent from ${chain.toUpperCase()}: no backend passed ` +
          `(${results.map((r) => r.detail).join("; ")}). Not broadcasting.`,
      );
    }
    opened.push(backend);
    const obs = await backend.observeOutput(donor.txid, donor.vout);
    if (obs.state !== "absent") {
      throw new ExecuteError(
        `The donor ${donor.txid}:${donor.vout} is ${obs.state} on ${chain.toUpperCase()}. It is ` +
          `no longer ${home.toUpperCase()}-only, so this transaction could replay there. Not broadcasting.`,
      );
    }
  }
}

/** Node answers to a send of a transaction it already has (Core, Knots, eCash, Electrum). */
const ALREADY_KNOWN =
  /txn-already-(in-mempool|known)|already in (the )?(block ?chain|mempool)|already have transaction/i;

/** Where a split that was sent before is now, for "not sent this time". */
function sentWhere(d: DepthResult): string {
  switch (d.state) {
    case "confirmed":
      return `confirmed (${d.depth} deep)`;
    case "mempool":
      return "in the mempool";
    case "conflict":
      return `its input was spent by ${
        d.by ?? "another transaction"
      }, not by this split. Run \`splayed track\` and see docs/user/recovery.md`;
    case "unknown":
      return "this backend can't tell whether it is still on the network, so it isn't sent again";
    default:
      return d.state;
  }
}

/** Why a transaction that was sent once is not sent again, or undefined if it may be. */
function sentAlready(p: TxProgress): string | undefined {
  const b = p.broadcast!;
  const detail = b.detail ? ` (${b.detail})` : "";
  switch (b.status) {
    case "accepted":
      return `already sent${detail}`;
    case "replaced":
      return `replaced by plan ${p.replacedBy?.plan ?? "?"}: broadcast that plan instead`;
    case "rejected":
      return `rejected by the server${detail}. Fix the cause or replace it with \`splayed bump\``;
    case "conflict":
      return `conflict${detail}: not sent again. See docs/user/recovery.md`;
    case "superseded":
      return `superseded${detail}: that plan already spent this coin; nothing to send`;
    default:
      // "sending" or "unknown": the result of an earlier attempt is unknown, or `track` saw it
      // leave the chain. Send again (the bytes and the inputs are checked first).
      return undefined;
  }
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
    /** Why a transaction is not being sent this time, for the summary. */
    const held = new Map<PlannedTx, string>();
    let ownIndex: Map<string, OwnTx> | undefined;
    /** Chains whose TEST FIRST transaction went out before: its status, for the question. */
    const asks = new Map<ChainId, TestFirstStatus>();
    /** Sent only if the user says yes to that question (or passes --yes). */
    const gated = new Set<PlannedTx>();
    for (const chain of ["btc", "ecx", "xbt"] as const) {
      const ofChain = plan.transactions.filter((t) => t.chain === chain);
      /** Sent and accepted before: sent again only if the chain shows it dropped out. */
      const recheck: PlannedTx[] = [];
      for (const t of ofChain) {
        const p = progress.txs[t.file];
        if (!p?.verified) held.set(t, "not verified yet: upload the signed file and run verify");
        else if (p.broadcast?.status === "accepted" && !p.replacedBy) recheck.push(t);
        else if (p.broadcast) {
          const why = sentAlready(p);
          if (why) held.set(t, why);
        }
      }
      const sendable = () =>
        ofChain.filter((t) =>
          progress.txs[t.file]?.verified && !held.has(t) && !recheck.includes(t)
        );
      if (!sendable().length && !recheck.length) continue;
      const { backend: send, results } = await verifiedBackendsFor(
        config,
        chain,
        io,
        true,
        "broadcast",
      );
      if (!send) {
        const why = `no broadcast backend passed: ${results.map((r) => r.detail).join("; ")}`;
        io.err(`${chain.toUpperCase()}: ${why}`);
        for (const t of [...sendable(), ...recheck]) held.set(t, why);
        continue;
      }
      opened.push(send);
      if (send.chain !== chain) throw new ExecuteError("Internal error: backend chain mismatch");
      if (recheck.length) {
        const tip = await send.tipHeight();
        for (const t of recheck) {
          const p = progress.txs[t.file];
          let d: DepthResult;
          try {
            d = await confirmationDepth(send, t, p.verified!.txid, tip);
          } catch (error) {
            // Never send again on the strength of a failed lookup.
            held.set(
              t,
              `already sent; couldn't check whether it is still on the network: ${
                (error as Error).message
              }`,
            );
            continue;
          }
          if (d.state === "absent") {
            io.out(
              `${chain.toUpperCase()} #${t.order}: sent before but no longer in the mempool or on ` +
                "the chain, and its inputs are unspent: it can be sent again.",
            );
          } else held.set(t, `already sent: ${sentWhere(d)}`);
        }
        recheck.length = 0;
      }
      const pending = sendable();
      if (!pending.length) continue;
      let allowed = pending;
      const test = all ? undefined : ofChain.find((t) => t.testFirst);
      if (test && pending.includes(test)) {
        // The TEST FIRST transaction goes alone: its first send, or again after it dropped out.
        allowed = [test];
        const why = `the TEST FIRST transaction (${test.file}) goes first, in this run. Run ` +
          "broadcast again to send the rest (it says where the test is and asks), or pass --all";
        for (const t of pending) if (t !== test) held.set(t, why);
        if (pending.length > 1) {
          io.out(
            `${chain.toUpperCase()}: sending only the TEST FIRST transaction this time; the rest ` +
              "waits for the next broadcast.",
          );
        }
      } else if (test) {
        // Sent before (or it can't be sent): say where it is, and ask before sending the rest.
        const status = await describeTestFirst({
          dataDir: config.dataDir,
          plan,
          progress,
          chain,
          backend: send,
        });
        if (status) {
          asks.set(chain, status);
          for (const t of pending) gated.add(t);
        }
      }
      for (const t of allowed) held.delete(t);
      for (const t of allowed) {
        const v = progress.txs[t.file].verified!;
        // Re-verify the exact bytes about to be sent.
        const again = verifySigned(t, await ownPsbt(dir, t), { tx: parseTx(v.finalHex) });
        if (again.finalHex !== v.finalHex) {
          throw new ExecuteError(`${t.file}: stored transaction changed`);
        }
        if (t.donor && !t.replaces) {
          await donorPreflight(config, io, t.donor, t.chain as "xbt" | "btc", opened);
        }
        if (t.gate) {
          // No protection of its own: prove the coin is gone and deep everywhere else first.
          const chains: GateCheck["chains"] = {};
          for (const gc of t.gate.chains) {
            const { backend: gb } = await verifiedBackendsFor(config, gc, io, true);
            if (!gb) {
              throw new ExecuteError(
                `${t.file}: can't check ${gc.toUpperCase()} (no backend passed). Not broadcasting.`,
              );
            }
            opened.push(gb);
            chains[gc] = { backend: gb, confirmations: config.chains[gc].confirmations };
          }
          const problems = await gateProblems({ planTx: t, planDir: dir, plan, progress, chains });
          if (problems.length) {
            io.err(
              `${t.file}: held back until the coin is spent and deep on BTC and ECX:\n  ${
                problems.join("\n  ")
              }`,
            );
            held.set(t, `held back until the coin is spent and deep on BTC and ECX (see above)`);
            continue;
          }
          // Final replay check on the user's own nodes, now that BTC and ECX should reject it.
          const nodes = await ownNodes(config, io);
          try {
            await mempoolChecks(t, v.finalHex, nodes, true);
          } finally {
            for (const n of nodes) await n.backend.close?.();
          }
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
            held.set(t, `already ${mine.state === "confirmed" ? "on chain" : "in the mempool"}`);
            // An earlier send got through even if its reply was lost: the original is replaced.
            await markReplaced(config, t, plan.id, v.txid);
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
            held.set(t, progress.txs[t.file].broadcast!.detail!);
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
            held.set(t, "already on chain");
            skip = true;
            break;
          }
          if (obs.state !== "unspent") {
            const entry = progress.txs[t.file];
            const by = obs.state === "spent" ? obs.spendTxid : undefined;
            ownIndex ??= await ownTransactions(config.dataDir);
            const spender = await classifySpender(
              config.dataDir,
              { plan: plan.id, file: t.file, chain },
              by,
              ownIndex,
            );
            if (spender.kind === "replacement") {
              // Its own fee bump got there: never send the original again.
              applyReplaced(entry, spender.link);
              held.set(t, `replaced by plan ${spender.link.plan}, which is on the network`);
            } else if (spender.kind === "own") {
              entry.supersededBy = {
                plan: spender.spender.plan,
                file: spender.spender.file,
                txid: spender.spender.txid,
              };
              entry.broadcast = {
                status: "superseded",
                at: new Date().toISOString(),
                backend: send.config.url,
                attempts: entry.broadcast?.attempts ?? 0,
                detail: `by plan ${spender.spender.plan} (${spender.spender.file})`,
              };
              held.set(
                t,
                `superseded: plan ${spender.spender.plan} (${spender.spender.file}) already spent ` +
                  "this coin",
              );
            } else {
              entry.broadcast = {
                status: "conflict",
                at: new Date().toISOString(),
                backend: send.config.url,
                attempts: entry.broadcast?.attempts ?? 0,
                detail: `input ${input.txid.slice(0, 8)}:${input.vout} is ${obs.state}${
                  by ? ` (spent by ${by})` : ""
                }`,
              };
              io.err(
                `${t.file}: an input is no longer unspent on ${chain.toUpperCase()}; not sending`,
              );
              held.set(t, `conflict: ${entry.broadcast.detail}`);
            }
            skip = true;
            break;
          }
        }
        if (!skip) queue.push({ t, hex: v.finalHex, txid: v.txid, send });
      }
    }
    await saveProgress(dir, progress);
    // The TEST FIRST step: one question for every chain whose rest is ready to go.
    let agreed = false;
    let declined = false;
    const gatedQueue = queue.filter((q) => gated.has(q.t));
    if (gatedQueue.length) {
      const chains = [...new Set(gatedQueue.map((q) => q.t.chain as ChainId))];
      const lines = chains.map((c) => `${c.toUpperCase()}: ${asks.get(c)!.text}.`);
      const allConfirmed = chains.every((c) => asks.get(c)!.confirmed);
      const counts = chains.map((c) =>
        `${gatedQueue.filter((q) => q.t.chain === c).length} ${c.toUpperCase()}`
      ).join(" and ");
      io.out(allConfirmed ? "TEST FIRST: the test spend went through." : "TEST FIRST:");
      for (const l of lines) io.out(`  ${l}`);
      const question = [
        allConfirmed
          ? "The TEST FIRST spend went through:"
          : "The TEST FIRST step is there to prove the signer, the destination and the route " +
            "work before more coins move. Where it is now:",
        ...lines.map((l) => `  ${l}`),
        `Send the other ${counts} transaction(s) now? Each goes only to its own chain.`,
      ].join("\n");
      agreed = yes || await io.confirm(question);
      if (!agreed) {
        declined = true;
        for (const q of gatedQueue) {
          held.set(
            q.t,
            `not sent: you chose to wait (${asks.get(q.t.chain as ChainId)!.text}). Run ` +
              "broadcast again when you're ready",
          );
        }
        queue.splice(0, queue.length, ...queue.filter((q) => !gated.has(q.t)));
      }
    }
    const notNow = plan.transactions.filter((t) => held.has(t));
    if (!queue.length) {
      io.out(
        declined
          ? "Nothing sent:"
          : notNow.length
          ? "Nothing to broadcast right now:"
          : "Nothing to broadcast right now.",
      );
    } else if (notNow.length) io.out("Not sent this time:");
    for (const t of notNow) {
      io.out(`  ${t.chain.toUpperCase()} #${t.order} (${t.file}): ${held.get(t)}`);
    }
    if (!queue.length) return declined ? 1 : 0;
    for (const chain of ["btc", "ecx", "xbt"] as const) {
      const items = queue.filter((q) => q.t.chain === chain);
      if (items.length) {
        io.out(
          `${chain.toUpperCase()}: ${items.length} transaction(s) -> ${items[0].send.config.url} (${
            describeRoute(items[0].send.route)
          })`,
        );
      }
    }
    // Already asked about everything going out (the rest after a TEST FIRST): don't ask twice.
    const askedAll = agreed && queue.every((q) => gated.has(q.t));
    if (
      !yes && !askedAll &&
      !(await io.confirm("Broadcast these now? Each goes only to its own chain."))
    ) {
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
        delete entry.unmined; // a fresh send: what track saw of the last one no longer applies
        io.out(`  sent ${q.t.chain.toUpperCase()} ${q.txid}`);
        if (q.t.replaces) await markReplaced(config, q.t, plan.id, q.txid);
      } catch (error) {
        if (error instanceof BackendError && ALREADY_KNOWN.test(error.message)) {
          // The server has it already (another send got there first): that is not a refusal.
          entry.broadcast.status = "accepted";
          entry.broadcast.detail = "the server already had it";
          delete entry.unmined;
          io.out(`  ${q.t.chain.toUpperCase()} ${q.txid}: the server already has it`);
          if (q.t.replaces) await markReplaced(config, q.t, plan.id, q.txid);
          await saveProgress(dir, progress);
          continue;
        }
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
    io.out("Run `splayed track <plan>` to follow confirmations.");
    return failed ? 1 : 0;
  } finally {
    for (const b of opened) await b.close?.();
  }
}

/**
 * A fee bump is on the network (accepted now, or found there later): record on the original plan
 * that it has been replaced, with the replacement's txid so it can be followed even without its
 * plan.
 */
async function markReplaced(
  config: Config,
  replacement: PlannedTx,
  newPlanId: string,
  txid: string,
) {
  const from = replacement.replaces!;
  try {
    const { dir: oldDir } = await planFolder(config.dataDir, from.plan);
    const oldProgress = await loadProgress(oldDir);
    const entry = oldProgress.txs[from.file];
    if (!entry) return;
    applyReplaced(entry, {
      plan: newPlanId,
      file: replacement.file,
      txid,
      input: { txid: replacement.inputs[0].txid, vout: replacement.inputs[0].vout },
    });
    retractConflicts(entry, txid);
    await saveProgress(oldDir, oldProgress);
  } catch { /* the replacement is on the network either way; track recognises it by its txid */ }
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
  const infos: string[] = [];
  const failures: string[] = [];
  let ownIndex: Map<string, OwnTx> | undefined;
  for (const chain of ["btc", "ecx", "xbt"] as const) {
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
        let d: DepthResult | undefined;
        if (backend && tip !== undefined && p.verified) {
          try {
            d = await confirmationDepth(backend, t, p.verified.txid, tip);
          } catch (error) {
            // A failed lookup says nothing: the record stays as it was, and nothing is reported
            // as moved or dropped on the strength of it.
            conf = "? (lookup failed)";
            failures.push(
              `${chain.toUpperCase()} ${t.file}: couldn't check it: ${(error as Error).message}`,
            );
          }
        }
        const label = `${chain.toUpperCase()} ${t.file}`;
        const alertsBefore = alerts.length;
        if (d && backend && tip !== undefined && p.verified) {
          const at = new Date().toISOString();
          const required = config.chains[chain].confirmations;
          conf = describeDepth(d, required);
          if (p.supersededBy && !(d.state === "conflict" && d.by === p.supersededBy.txid)) {
            // The other plan's transaction no longer holds the coin: this split stands alone again.
            infos.push(`${label}: no longer superseded by plan ${p.supersededBy.plan}.`);
            delete p.supersededBy;
            if (p.broadcast?.status === "superseded") {
              p.broadcast = {
                ...p.broadcast,
                status: d.state === "confirmed" || d.state === "mempool" ? "accepted" : "unknown",
                detail: "no longer superseded",
              };
            }
          }
          if (d.state === "conflict" && !p.replacedBy && !p.supersededBy) {
            // Before alarming, recognise this tool's own spends of the coin.
            ownIndex ??= await ownTransactions(config.dataDir);
            const spender = await classifySpender(
              config.dataDir,
              { plan: plan.id, file: t.file, chain },
              d.by,
              ownIndex,
            );
            if (spender.kind === "replacement") {
              applyReplaced(p, spender.link);
              retractConflicts(p, d.by!);
              infos.push(
                `${label}: its input was spent by its own fee bump (plan ${spender.spender.plan}); ` +
                  "recorded as replaced.",
              );
            } else if (spender.kind === "own") {
              p.supersededBy = {
                plan: spender.spender.plan,
                file: spender.spender.file,
                txid: spender.spender.txid,
              };
              p.broadcast = {
                ...p.broadcast!,
                status: "superseded",
                detail: `by plan ${spender.spender.plan} (${spender.spender.file})`,
              };
              retractConflicts(p, d.by!);
            }
          }
          if (p.replacedBy && d.state === "confirmed") {
            // The original won the race: the fee bump can no longer apply.
            conf += "  (the ORIGINAL confirmed)";
            alerts.push(
              `${label}: the original confirmed even though plan ${p.replacedBy.plan} was ` +
                "broadcast to replace it. The replacement is now invalid.",
            );
          } else if (p.replacedBy) {
            // Expected to be gone from the chain: follow the fee bump(s) instead.
            const r = await followReplacement(config.dataDir, p.replacedBy, chain, backend, tip);
            const name = `plan ${r.link.plan}${
              r.plans.length > 1 ? ` (via ${r.plans.slice(0, -1).join(", ")})` : ""
            }`;
            const rd = r.depth;
            if (rd?.state === "confirmed" || rd?.state === "mempool") {
              conf = `REPLACED by ${name} (${
                rd.state === "confirmed" ? `confirmed, ${rd.depth} deep` : "in the mempool"
              })`;
              // A reorg this original went through is over once its replacement is deep.
              if (rd.state === "confirmed" && rd.depth! >= required) resolveReorgs(p, at);
            } else if (!rd) {
              conf = `REPLACED by ${name}, which can't be read`;
              alerts.push(
                `${label}: ${name} replaced this transaction, but that plan can't be read (was ` +
                  "it deleted?), so where the replacement went can't be checked. Leave the BTC " +
                  "copy alone until a replacement shows as confirmed.",
              );
            } else if (rd.state === "unknown") {
              conf = `REPLACED by ${name} (unknown: this backend can't say where it is)`;
            } else if (rd.state === "absent") {
              const rs = r.progress?.broadcast;
              const rsent: SentContext | undefined = rs
                ? {
                  status: rs.status === "sending" || rs.status === "unknown"
                    ? rs.status
                    : "accepted",
                  sentAt: rs.at,
                  lastInMempool: r.progress?.unmined?.lastInMempool,
                  nowMs: Date.now(),
                }
                : undefined;
              if (rsent && withinDropGrace(rsent)) {
                conf = `REPLACED by ${name} (not on the network yet: sent a few minutes ago)`;
              } else {
                conf = `REPLACED by ${name}, which is not on the network either`;
                const alert = {
                  kind: "evicted" as const,
                  detail: `This transaction was replaced by its fee bump (${name}), and that ` +
                    "replacement is no longer in the mempool or on the chain either. Its inputs " +
                    "are unspent, so the coin is still shared with BTC: do NOT spend the BTC " +
                    `copy. Send the replacement again (\`splayed broadcast ${r.link.plan}\`, ` +
                    "Broadcast verified on that plan), or, if its fee was too low, bump it again " +
                    `(\`splayed bump ${r.link.plan}\`).`,
                };
                alerts.push(`${label}: ${alertTitle(alert.kind)}: ${alert.detail}`);
                recordReorg(p, alert, at);
              }
            } else {
              ownIndex ??= await ownTransactions(config.dataDir);
              const spender = await classifySpender(
                config.dataDir,
                { ...r.link, chain },
                rd.by,
                ownIndex,
              );
              if (spender.kind === "own") {
                conf =
                  `REPLACED by ${name}; the coin was then spent by plan ${spender.spender.plan}`;
                infos.push(
                  `${label}: its replacement (${name}) was superseded by plan ` +
                    `${spender.spender.plan} (${spender.spender.file}), which spent the coin first.`,
                );
              } else {
                conf = `REPLACED by ${name}, whose input was spent by something else`;
                const alert = assessReorg(chain, undefined, rd)!;
                alerts.push(`${label}: its replacement (${name}): CONFLICT: ${alert.detail}`);
                recordReorg(p, alert, at);
              }
            }
          } else if (p.supersededBy) {
            // Another plan of this tool spent the coin first: information, not an alarm.
            const sup = p.supersededBy;
            ownIndex ??= await ownTransactions(config.dataDir);
            const input = ownIndex.get(sup.txid)?.input;
            let sd: DepthResult | undefined;
            try {
              sd = await confirmationDepth(
                backend,
                input ? ({ inputs: [input] } as unknown as PlannedTx) : t,
                sup.txid,
                tip,
              );
            } catch { /* shown as "?" below; its record stays */ }
            if (sd) {
              p.supersededBy = { ...sup, depth: sd.state === "confirmed" ? sd.depth : 0, at };
            }
            conf = `superseded by plan ${sup.plan} (${sd ? describeDepth(sd, required) : "?"})`;
            if (sd?.state === "confirmed" && sd.depth! >= required) resolveReorgs(p, at);
            infos.push(
              `${label}: superseded by plan ${sup.plan} (${sup.file}), which spent this coin ` +
                "first (the coin was in two plans). Nothing to do for this transaction; follow " +
                "that plan.",
            );
          } else {
            const st = p.broadcast?.status;
            const sent: SentContext | undefined =
              st === "accepted" || st === "sending" || st === "unknown"
                ? {
                  status: st,
                  sentAt: p.broadcast!.at,
                  lastInMempool: p.unmined?.lastInMempool,
                  nowMs: Date.now(),
                }
                : undefined;
            const neverInBlock = !lastSeenInBlock(p.confirmations);
            if (d.state === "absent" && neverInBlock && sent && withinDropGrace(sent)) {
              conf = "not on the network yet (sent a few minutes ago; run track again later)";
            } else if (d.state === "absent" && neverInBlock && sent) {
              conf = p.unmined?.lastInMempool
                ? "DROPPED from the mempool, never confirmed"
                : "not on the network, never confirmed";
            }
            const alert = assessReorg(chain, p.confirmations, d, sent);
            // Mempool sightings of a split that was never in a block, for the next look.
            p.unmined = neverInBlock ? nextUnmined(p.unmined, d, at) : undefined;
            if (alert) {
              alerts.push(`${label}: ${alertTitle(alert.kind)}: ${alert.detail}`);
              recordReorg(p, alert, at);
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
            } else if (
              (d.state === "confirmed" || d.state === "mempool") && p.broadcast &&
              (st === "unknown" || st === "sending" || st === "rejected")
            ) {
              // An earlier send whose result was unknown (or a split that left the chain, or one a
              // server refused that got out anyway) is on the network.
              p.broadcast = {
                ...p.broadcast,
                status: "accepted",
                detail: `seen ${
                  d.state === "confirmed" ? "in a block" : "in the mempool"
                } by track`,
              };
              // A fee bump on the network has replaced its original, whatever the lost reply said.
              if (t.replaces) await markReplaced(config, t, plan.id, p.verified.txid);
            } else if (
              d.state === "confirmed" && d.depth! >= required && st === "conflict"
            ) {
              // Its own bytes are deep in the chain: whatever conflicted is gone.
              p.broadcast = {
                ...p.broadcast!,
                status: "accepted",
                detail: `confirmed ${d.depth} deep after a conflict was reported`,
              };
            }
            if (d.state === "confirmed" && d.depth! >= required) resolveReorgs(p, at);
          }
          // The depth as it is now: 0 once it is out of its block, so nothing reads a stale one.
          p.confirmations = nextConfirmations(p.confirmations, d, at);
        }
        // An alert stays an alert until it is resolved (confirmed deep enough again), even on a
        // run where nothing new happened.
        const open = (p.reorgs ?? []).filter((r) => !r.resolved);
        if (alerts.length === alertsBefore && open.length) {
          const last = open[open.length - 1];
          alerts.push(
            `${label}: ${alertTitle(last.kind)} of ${last.at.slice(0, 16).replace("T", " ")} UTC ` +
              `is still open (now: ${conf}). It closes once the split${
                p.replacedBy ? " (or its replacement)" : ""
              } is ${config.chains[chain].confirmations} deep.`,
          );
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
  for (const n of infos) io.out(`Note: ${n}`);
  for (const f of failures) io.err(`Warning: ${f}`);
  if (alerts.length) {
    io.err("");
    io.err("!!! WARNING: a split did not stay where it was put !!!");
    for (const a of alerts) io.err(`  ${a}`);
    io.err("Until every split is confirmed again, leave the BTC copies alone.");
    return 1;
  }
  if (failures.length) {
    io.err("Some transactions couldn't be checked; their records are unchanged. Try again later.");
    return 1;
  }
  io.out(
    "When every split is deep enough, run `splayed scan`: those coins' BTC copies then show as separated.",
  );
  return 0;
}

async function cmdBump(
  config: Config,
  io: CliIO,
  id: string | undefined,
  opts: {
    feeRate?: string;
    chains?: string;
    tx?: string[];
    drop?: string[];
    cpfp?: boolean;
    /** Write a replacement even though one for the same transaction is written and not sent. */
    another?: boolean;
    yes: boolean;
  },
) {
  await requireNetworkConfirmed(config);
  if (!id) throw new UsageError("bump <plan> [--chains ecx,xbt] [--tx N ...] [--fee-rate ecx=5]");
  if (opts.another && opts.cpfp) throw new UsageError("--another is for RBF bumps, not --cpfp");
  if (opts.cpfp && opts.drop?.length) throw new UsageError("--cpfp and --drop don't combine");
  if (opts.drop?.length && opts.tx?.length !== 1) {
    throw new UsageError("--drop works on one transaction: add --tx N");
  }
  if (opts.cpfp) return await cmdCpfp(config, io, id, opts);
  const { dir, plan } = await loadPlanDir(config.dataDir, id);
  const progress = await loadProgress(dir);
  const rates = parseFeeRates(opts.feeRate);
  const chainFilter = opts.chains?.split(",").map((c) => c.trim());
  if (chainFilter && !chainFilter.every((c) => c === "ecx" || c === "xbt")) {
    throw new UsageError("--chains takes ecx, xbt or ecx,xbt");
  }
  const pendingBumps = await unsentReplacements(config.dataDir, plan.id);
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
        if (p.supersededBy) {
          refused++;
          row(
            "superseded",
            `plan ${p.supersededBy.plan} already spent this coin: nothing to bump here`,
          );
          continue;
        }
        // One replacement at a time: a second unsent one for the same transaction only leaves the
        // user with two plans of which at most one can ever go through.
        const unsent = pendingBumps.get(t.file);
        if (unsent?.length) {
          const names = unsent.map((u) => u.plan).join(", ");
          if (!opts.another) {
            refused++;
            row(
              "bump written",
              `plan ${names} already replaces it and is not sent yet. Sign, verify and broadcast ` +
                `that plan, or delete it (\`splayed plans delete ${unsent[0].plan}\`) first; ` +
                "--another writes another one anyway",
            );
            continue;
          }
          io.err(
            `Warning: ${t.file}: plan ${names} already replaces it and is not sent yet; writing ` +
              "another one (--another). Only one replacement can ever confirm.",
          );
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
            drop: opts.drop,
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
      `  splayed verify ${bumped.id}\n  splayed broadcast ${bumped.id}\n  splayed track ${bumped.id}\n` +
      "If the original confirms first, the replacement is simply refused.",
  );
  return refused ? 1 : 0;
}

/** `bump --cpfp`: a child that lifts a stuck split by paying for the pair. */
async function cmdCpfp(
  config: Config,
  io: CliIO,
  id: string,
  opts: { feeRate?: string; chains?: string; tx?: string[]; yes: boolean },
) {
  const { dir, plan } = await loadPlanDir(config.dataDir, id);
  const progress = await loadProgress(dir);
  const rates = parseFeeRates(opts.feeRate);
  const chainFilter = opts.chains?.split(",").map((c) => c.trim());
  const wallet = await loadWallet(config.dataDir);
  const network = networkForProfile(config.profile);
  const children: PlannedTx[] = [];
  const reserved: Partial<Record<PlanChain, number>> = {};
  const rows = [["Chain", "#", "Parent fee", "Child fee", "Pair sat/vB", "Result"]];
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
      const rate = rates[chain];
      if (rate === undefined) throw new UsageError(`--fee-rate ${chain}=N (the rate for the pair)`);
      const dest = wallet.destinations?.[chain];
      if (!dest) throw new PlanError(`No ${chain.toUpperCase()} destination set`);
      const descriptor = parseDescriptor(dest.descriptor, network);
      const { backend } = await verifiedBackendsFor(config, chain, io, true);
      if (!backend) {
        io.err(`${chain.toUpperCase()}: no backend passed its identity check`);
        refused += txs.length;
        continue;
      }
      opened.push(backend);
      const tip = await backend.tipHeight();
      let next = Math.max(dest.nextIndex, reserved[chain] ?? 0);
      for (const t of txs) {
        const p = progress.txs[t.file];
        const row = (child: string, result: string, pair = "") =>
          rows.push([chain.toUpperCase(), String(t.order), String(t.fee), child, pair, result]);
        if (!p.verified || p.replacedBy) {
          refused++;
          row("", p.replacedBy ? "already replaced by a fee bump" : "not verified or sent");
          continue;
        }
        const d = await confirmationDepth(backend, t, p.verified.txid, tip);
        if (d.state !== "mempool") {
          refused++;
          row(
            "",
            d.state === "confirmed" ? "already confirmed: nothing to lift" : `it is ${d.state}`,
          );
          continue;
        }
        try {
          if (t.output.value !== Number(parseTx(p.verified.finalHex).outputs[0].value)) {
            throw new BumpError("The sent transaction's output differs from the plan");
          }
          const derived = descriptor.branches[0].derive(t.output.destinationIndex);
          const to = descriptor.branches[0].derive(next);
          const received = {
            coin: {
              txid: p.verified.txid,
              vout: 0,
              value: t.output.value,
              address: t.output.address,
              scriptPubKey: derived.scriptPubKey,
              observations: {} as never,
            },
            derived,
            descriptor,
            prevRaw: p.verified.finalHex,
            prevTx: parseTx(p.verified.finalHex),
          };
          const child = buildCpfp({
            chain,
            parentPlanId: plan.id,
            parent: t,
            parentTxid: p.verified.txid,
            parentHex: p.verified.finalHex,
            received,
            to,
            toIndex: next,
            packageRate: rate,
          });
          children.push({ ...child, order: children.filter((c) => c.chain === chain).length + 1 });
          next++;
          reserved[chain] = next;
          row(String(child.fee), "child", String(rate));
        } catch (error) {
          if (!(error instanceof BumpError)) throw error;
          refused++;
          row("", error.message);
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
  if (!children.length) return 1;
  if (!opts.yes && !(await io.confirm(`Write ${children.length} child PSBT(s)?`))) {
    io.out("Nothing written.");
    return 1;
  }
  const taken = new Set<string>();
  try {
    for await (const e of Deno.readDir(join(config.dataDir, PLANS_DIR))) taken.add(e.name);
  } catch { /* none yet */ }
  let n = 1;
  while (taken.has(`${plan.id}-cpfp${n}`)) n++;
  const cpfpPlan: Plan = {
    ...plan,
    id: `${plan.id}-cpfp${n}`,
    createdAt: new Date().toISOString(),
    route: "cpfp",
    transactions: children,
    warnings: [],
    reserved,
  };
  const newDir = await writePlan(config.dataDir, cpfpPlan);
  const fresh = await loadWallet(config.dataDir);
  for (const [chain, nextIndex] of Object.entries(reserved) as [PlanChain, number][]) {
    const d = fresh.destinations?.[chain];
    if (d && nextIndex > d.nextIndex) d.nextIndex = nextIndex;
  }
  await saveWallet(config.dataDir, fresh);
  io.out(`\nWrote ${children.length} child PSBT(s) to ${newDir}`);
  io.out(
    "Sign them with the DESTINATION wallet (they spend the split's output), then verify and " +
      `broadcast ${cpfpPlan.id}. The parent keeps its place; miners take both together.`,
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
  io.out(`splayed UI: ${ui.url}`);
  io.out(
    "Open that exact URL (it carries a one-time access token). Only this machine can reach it.",
  );
  io.out("Press Ctrl+C to stop; a Tor started by splayed stops with it.");
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
