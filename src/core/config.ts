import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, utf8 } from "./bytes.ts";
import { CHAIN_IDS, type ChainId, getProfile, isChainId, type NetworkProfile } from "./profiles.ts";
import { readJson, readTextIfExists, writeJsonAtomic, writeTextAtomic } from "./store.ts";
import {
  PolicyError,
  type ProxySetting,
  resolveRoute,
  type Route,
  type SocksEndpoint,
} from "../net/transport.ts";

export type BackendKind = "esplora" | "electrum" | "rpc";
export type BackendRole = "read" | "broadcast" | "both";

export interface RpcAuth {
  cookieFile?: string;
  user?: string;
  /** Name of the environment variable holding the RPC password. Never the password itself. */
  passwordEnv?: string;
}

export interface BackendConfig {
  kind: BackendKind;
  url: string;
  proxy: ProxySetting;
  role: BackendRole;
  priority: number;
  label?: string;
  auth?: RpcAuth;
  /** PEM file to trust for this backend's TLS (pin a self-signed Electrum/Esplora server). */
  caFile?: string;
  origin: "profile-default" | "user";
}

export interface ChainConfig {
  backends: BackendConfig[];
  confirmations: number;
  clearnetOptIn: boolean;
}

export interface ScanSettings {
  gapLimit: number;
  /** Random delay between requests to remote (non-local) backends, in ms. */
  jitterMinMs: number;
  jitterMaxMs: number;
}

export type TorMode = "auto" | "system" | "managed";

export interface TorSettings {
  /**
   * auto: use a running Tor (configured address, then 127.0.0.1:9050 / 9150), else start our own.
   * system: only use the configured/running Tor; never start one.
   * managed: always start our own Tor (bundled binary, or `tor` from PATH).
   */
  mode: TorMode;
  /** Explicit SOCKS address of a Tor you run yourself. */
  socks?: SocksEndpoint;
  /** Path to a tor executable for managed mode (default: bundled, then PATH). */
  binary?: string;
  bootstrapTimeoutSec: number;
}

export interface Config {
  profile: NetworkProfile;
  dataDir: string;
  tor: TorSettings;
  /** The SOCKS endpoint in use. Updated at runtime once Tor is located or started. */
  torSocks: SocksEndpoint;
  scan: ScanSettings;
  chains: Record<ChainId, ChainConfig>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const CONFIG_FILE = "splayed.toml";
export const GATE_FILE = "network-confirmation.json";
export const DEFAULT_TOR_SOCKS: SocksEndpoint = { host: "127.0.0.1", port: 9050 };

export function parseSocks(value: string): SocksEndpoint {
  const text = value.replace(/^socks5h?:\/\//u, "");
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(text);
  if (!match) throw new ConfigError(`Invalid SOCKS address "${value}" (expected host:port)`);
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new ConfigError(`Invalid SOCKS port in "${value}"`);
  return { host: match[1].replace(/^\[|\]$/gu, ""), port };
}

export function parseProxy(value: unknown): ProxySetting {
  if (value === undefined || value === "tor") return { kind: "tor" };
  if (value === "none") return { kind: "none" };
  if (typeof value === "string" && /^socks5h?:\/\//u.test(value)) {
    return { kind: "socks5", ...parseSocks(value) };
  }
  throw new ConfigError(
    `Invalid proxy "${String(value)}" (use "tor", "none" or socks5://host:port)`,
  );
}

export function proxyToString(proxy: ProxySetting): string {
  if (proxy.kind === "socks5") return `socks5://${proxy.host}:${proxy.port}`;
  return proxy.kind;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${where} must be a table`);
  }
  return value as Record<string, unknown>;
}

function intIn(value: unknown, where: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${where} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function parseBackend(raw: unknown, where: string): BackendConfig {
  const b = asRecord(raw, where);
  const allowed = new Set([
    "kind",
    "url",
    "proxy",
    "role",
    "priority",
    "label",
    "cookie_file",
    "user",
    "password_env",
    "ca_file",
  ]);
  for (const key of Object.keys(b)) {
    if (key === "password") {
      throw new ConfigError(
        `${where}: don't store RPC passwords in the config file; use password_env or cookie_file`,
      );
    }
    if (!allowed.has(key)) throw new ConfigError(`${where}: unknown key "${key}"`);
  }
  const kind = b.kind;
  if (kind !== "esplora" && kind !== "electrum" && kind !== "rpc") {
    throw new ConfigError(`${where}.kind must be "esplora", "electrum" or "rpc"`);
  }
  if (typeof b.url !== "string") throw new ConfigError(`${where}.url is required`);
  const role = b.role ?? "both";
  if (role !== "read" && role !== "broadcast" && role !== "both") {
    throw new ConfigError(`${where}.role must be "read", "broadcast" or "both"`);
  }
  const auth: RpcAuth = {};
  if (b.cookie_file !== undefined) auth.cookieFile = String(b.cookie_file);
  if (b.user !== undefined) auth.user = String(b.user);
  if (b.password_env !== undefined) auth.passwordEnv = String(b.password_env);
  if (b.ca_file !== undefined && typeof b.ca_file !== "string") {
    throw new ConfigError(`${where}.ca_file must be a path`);
  }
  if (kind === "electrum" && !/^(ssl|tcp):\/\//u.test(String(b.url))) {
    throw new ConfigError(`${where}: Electrum URLs look like ssl://host:50002 or tcp://host:50001`);
  }
  if (kind !== "electrum" && /^(ssl|tcp):\/\//u.test(String(b.url))) {
    throw new ConfigError(`${where}: ssl:// and tcp:// URLs are for kind = "electrum"`);
  }
  if (kind !== "rpc" && Object.keys(auth).length > 0) {
    throw new ConfigError(`${where}: auth settings only apply to kind = "rpc"`);
  }
  return {
    kind,
    url: b.url.replace(/\/+$/u, ""),
    proxy: parseProxy(b.proxy),
    role,
    priority: intIn(b.priority, `${where}.priority`, 0, 1000, 0),
    label: typeof b.label === "string" ? b.label : undefined,
    auth: Object.keys(auth).length ? auth : undefined,
    caFile: typeof b.ca_file === "string" ? b.ca_file : undefined,
    origin: "user",
  };
}

export interface LoadOptions {
  dataDir: string;
  /** CLI flag overrides (highest precedence). */
  torSocks?: string;
  profile?: string;
  env?: Record<string, string | undefined>;
}

/** Precedence: CLI flags > environment > config file > profile defaults. */
export async function loadConfig(options: LoadOptions): Promise<Config> {
  const env = options.env ?? Deno.env.toObject();
  const text = await readTextIfExists(join(options.dataDir, CONFIG_FILE));
  let file: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      file = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      throw new ConfigError(`Could not parse ${CONFIG_FILE}: ${(error as Error).message}`);
    }
  }
  for (const key of Object.keys(file)) {
    if (!["profile", "tor", "scan", "chains"].includes(key)) {
      throw new ConfigError(`${CONFIG_FILE}: unknown top-level key "${key}"`);
    }
  }
  const profileId = options.profile ?? env.SPLAYED_PROFILE ??
    (typeof file.profile === "string" ? file.profile : "mainnet");
  const profile = getProfile(profileId);

  const tor = asRecord(file.tor, "[tor]");
  for (const key of Object.keys(tor)) {
    if (!["mode", "socks", "binary", "bootstrap_timeout_sec"].includes(key)) {
      throw new ConfigError(`[tor]: unknown key "${key}"`);
    }
  }
  const socksText = options.torSocks ?? env.SPLAYED_TOR_SOCKS ??
    (typeof tor.socks === "string" ? tor.socks : undefined);
  // SPLAYED_TOR_MODE lets a container fix the mode (e.g. "system" with a Tor sidecar).
  const mode = env.SPLAYED_TOR_MODE ?? tor.mode ?? "auto";
  if (mode !== "auto" && mode !== "system" && mode !== "managed") {
    throw new ConfigError('tor.mode must be "auto", "system" or "managed"');
  }
  const binary = env.SPLAYED_TOR_BINARY ??
    (typeof tor.binary === "string" ? tor.binary : undefined);
  const torSettings: TorSettings = {
    mode,
    socks: socksText ? parseSocks(socksText) : undefined,
    binary,
    bootstrapTimeoutSec: intIn(
      tor.bootstrap_timeout_sec,
      "tor.bootstrap_timeout_sec",
      10,
      3600,
      180,
    ),
  };
  const torSocks = torSettings.socks ?? DEFAULT_TOR_SOCKS;

  const scanRaw = asRecord(file.scan, "[scan]");
  const scan: ScanSettings = {
    gapLimit: intIn(scanRaw.gap_limit, "scan.gap_limit", 1, 1000, 20),
    jitterMinMs: intIn(scanRaw.jitter_min_ms, "scan.jitter_min_ms", 0, 60_000, 150),
    jitterMaxMs: intIn(scanRaw.jitter_max_ms, "scan.jitter_max_ms", 0, 60_000, 900),
  };
  if (scan.jitterMaxMs < scan.jitterMinMs) {
    throw new ConfigError("scan.jitter_max_ms must be >= scan.jitter_min_ms");
  }

  const chainsRaw = asRecord(file.chains, "[chains]");
  for (const key of Object.keys(chainsRaw)) {
    if (!isChainId(key)) throw new ConfigError(`[chains.${key}]: unknown chain`);
  }
  const chains = {} as Record<ChainId, ChainConfig>;
  for (const chain of CHAIN_IDS) {
    const raw = asRecord(chainsRaw[chain], `[chains.${chain}]`);
    for (const key of Object.keys(raw)) {
      if (!["backends", "confirmations", "clearnet_opt_in"].includes(key)) {
        throw new ConfigError(`[chains.${chain}]: unknown key "${key}"`);
      }
    }
    const cp = profile.chains[chain];
    const confirmations = intIn(
      raw.confirmations,
      `chains.${chain}.confirmations`,
      cp.minConfirmations,
      10_000,
      cp.defaultConfirmations,
    );
    if (raw.clearnet_opt_in !== undefined && typeof raw.clearnet_opt_in !== "boolean") {
      throw new ConfigError(`chains.${chain}.clearnet_opt_in must be true or false`);
    }
    let backends: BackendConfig[];
    if (raw.backends === undefined) {
      backends = cp.defaultBackends
        .filter((d) => d.tier === "primary")
        .map((d) => ({
          kind: d.kind,
          url: d.url,
          proxy: { kind: "tor" } as ProxySetting,
          role: "both" as BackendRole,
          priority: 0,
          label: d.label,
          origin: "profile-default" as const,
        }));
    } else {
      if (!Array.isArray(raw.backends)) {
        throw new ConfigError(`chains.${chain}.backends must be an array of tables`);
      }
      backends = raw.backends.map((b, i) => parseBackend(b, `chains.${chain}.backends[${i}]`));
    }
    chains[chain] = {
      backends: backends.sort((a, b) => a.priority - b.priority),
      confirmations,
      clearnetOptIn: raw.clearnet_opt_in === true,
    };
  }
  const config: Config = {
    profile,
    dataDir: options.dataDir,
    tor: torSettings,
    torSocks,
    scan,
    chains,
  };
  validateRoutes(config);
  return config;
}

export function routeForBackend(config: Config, chain: ChainId, backend: BackendConfig): Route {
  return resolveRoute(
    backend.url,
    backend.proxy,
    config.chains[chain].clearnetOptIn,
    config.torSocks,
  );
}

/** Every backend must have a legal route; each chain needs a read and a broadcast backend. */
export function validateRoutes(config: Config): void {
  for (const chain of CHAIN_IDS) {
    const cc = config.chains[chain];
    if (cc.backends.length === 0) throw new ConfigError(`chains.${chain}: no backends configured`);
    for (const backend of cc.backends) {
      try {
        routeForBackend(config, chain, backend);
      } catch (error) {
        if (error instanceof PolicyError) {
          throw new ConfigError(`chains.${chain} backend ${backend.url}: ${error.message}`);
        }
        throw error;
      }
    }
    if (!cc.backends.some((b) => b.role !== "broadcast")) {
      throw new ConfigError(`chains.${chain}: needs at least one backend with role read/both`);
    }
  }
}

/** Canonical description of everything that affects where data goes. Changing it re-gates. */
export function privacyRelevantConfig(config: Config): unknown {
  return {
    profile: config.profile.id,
    tor: {
      mode: config.tor.mode,
      socks: config.tor.socks ?? null,
      binary: config.tor.binary ?? null,
    },
    // Gap limit and jitter change how much a server learns, so they re-gate too.
    scan: config.scan,
    chains: Object.fromEntries(CHAIN_IDS.map((chain) => {
      const cc = config.chains[chain];
      return [chain, {
        clearnetOptIn: cc.clearnetOptIn,
        backends: cc.backends.map((b) => ({
          kind: b.kind,
          url: b.url,
          proxy: proxyToString(b.proxy),
          role: b.role,
          priority: b.priority,
        })),
      }];
    })),
  };
}

export function configFingerprint(config: Config): string {
  return toHex(sha256(utf8(JSON.stringify(privacyRelevantConfig(config)))));
}

export interface GateRecord {
  fingerprint: string;
  confirmedAt: string;
  identity: Record<string, { ok: boolean; detail: string }>;
}

export async function readGate(config: Config): Promise<GateRecord | undefined> {
  return await readJson<GateRecord>(join(config.dataDir, GATE_FILE));
}

/** True only if the user confirmed exactly the current network settings. */
export async function networkConfirmed(config: Config): Promise<boolean> {
  const gate = await readGate(config);
  return gate?.fingerprint === configFingerprint(config);
}

export async function writeGate(config: Config, identity: GateRecord["identity"]): Promise<void> {
  await writeJsonAtomic(
    join(config.dataDir, GATE_FILE),
    {
      fingerprint: configFingerprint(config),
      confirmedAt: new Date().toISOString(),
      identity,
    } satisfies GateRecord,
  );
}

export class GateClosedError extends Error {
  constructor() {
    super(
      "Network settings have not been confirmed (or changed since they were). Run " +
        "`splayed init` to review where queries will go before importing or scanning anything.",
    );
    this.name = "GateClosedError";
  }
}

export async function requireNetworkConfirmed(config: Config): Promise<void> {
  if (!(await networkConfirmed(config))) throw new GateClosedError();
}

// ---- Editing the config file (used by `splayed config ...`) ----

export async function readConfigFile(dataDir: string): Promise<Record<string, unknown>> {
  const text = await readTextIfExists(join(dataDir, CONFIG_FILE));
  return text === undefined ? {} : parseToml(text) as Record<string, unknown>;
}

export async function writeConfigFile(
  dataDir: string,
  data: Record<string, unknown>,
): Promise<void> {
  const header = "# splayed configuration. Changing anything here requires re-confirming with\n" +
    "# `splayed init` before the tool will query any backend.\n\n";
  await writeTextAtomic(join(dataDir, CONFIG_FILE), header + stringifyToml(data) + "\n");
}

export function backendToToml(b: BackendConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: b.kind,
    url: b.url,
    proxy: proxyToString(b.proxy),
    role: b.role,
    priority: b.priority,
  };
  if (b.label) out.label = b.label;
  if (b.auth?.cookieFile) out.cookie_file = b.auth.cookieFile;
  if (b.auth?.user) out.user = b.auth.user;
  if (b.auth?.passwordEnv) out.password_env = b.auth.passwordEnv;
  if (b.caFile) out.ca_file = b.caFile;
  return out;
}
