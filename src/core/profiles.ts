/**
 * Network profiles. Everything in this file is consensus-critical or identity-critical and is
 * compiled in on purpose: users can choose a profile but can never edit its constants.
 * See docs/reference/security-model.md.
 */

export type ChainId = "btc" | "xbt" | "ecx";
export const CHAIN_IDS: readonly ChainId[] = Object.freeze(["btc", "xbt", "ecx"] as const);

export const CHAIN_NAMES: Readonly<Record<ChainId, string>> = Object.freeze({
  btc: "Bitcoin (BTC)",
  xbt: "Bitcoin BLAKE2b (XBT)",
  ecx: "eCash (ECX)",
});

export interface Checkpoint {
  readonly height: number;
  /** Block hash in conventional (display) byte order, lowercase hex. */
  readonly hash: string;
  readonly source: string;
}

export interface DefaultBackend {
  readonly kind: "esplora";
  readonly url: string;
  readonly label: string;
  /** Primary defaults are used after first-run confirmation; fallbacks need explicit confirmation. */
  readonly tier: "primary" | "fallback";
}

export interface ChainProfile {
  readonly chain: ChainId;
  /** Last block shared with BTC (undefined for BTC itself). */
  readonly lastSharedHeight?: number;
  /** Checkpoints a backend must match before it is trusted for this chain. */
  readonly checkpoints: readonly Checkpoint[];
  /** Replay protection this chain offers its own transactions. */
  readonly replayProtection:
    | { readonly kind: "none" }
    | { readonly kind: "locktime-marker"; readonly lockTime: number }
    | { readonly kind: "unified-sighash"; readonly bit: number };
  /** Minimum confirmations the user may configure before a spend counts as deep. */
  readonly minConfirmations: number;
  readonly defaultConfirmations: number;
  readonly defaultBackends: readonly DefaultBackend[];
  /** Node RPC identity extras. */
  readonly rpc?: {
    /** XBT: getdeploymentinfo must report this deployment active. */
    readonly requiredDeployment?: string;
  };
}

export interface NetworkProfile {
  readonly id: string;
  readonly description: string;
  /** Extended-key versions and address encoding for descriptors. Default "main". */
  readonly addressNetwork?: "main" | "regtest";
  readonly chains: Readonly<Record<ChainId, ChainProfile>>;
}

/** ECX mainnet replay marker: LOCKTIME_THRESHOLD - 2. Betanet used 499_999_999; never mix them. */
export const ECX_MAINNET_REPLAY_LOCKTIME = 499_999_998;
/** Bitcoin Knots unified opt-in sighash bit (Knots PR #357). SIGHASH_ALL becomes 0x21. */
export const SIGHASH_UNIFIED = 0x20;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export const MAINNET: NetworkProfile = deepFreeze({
  id: "mainnet",
  description: "BTC, XBT and ECX mainnets",
  chains: {
    btc: {
      chain: "btc",
      checkpoints: [
        {
          height: 961_640,
          hash: "00000000000000000001d82da6ecccf08e07afa383f9212b0e1b95cc72430c00",
          source: "smolcars/bcashjr-wallet chain_verifier.ts",
        },
        {
          height: 973_728,
          hash: "0000000000000000000104150b08ff89bbb2d11bab42c245c82b8165ab2e2c11",
          source: "smolcars/ecashjr-wallet network.ts (mempool.space, blockstream.info)",
        },
      ],
      replayProtection: { kind: "none" },
      minConfirmations: 3,
      defaultConfirmations: 6,
      defaultBackends: [
        {
          kind: "esplora",
          url: "http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api",
          label: "mempool.space (onion)",
          tier: "primary",
        },
        {
          kind: "esplora",
          url: "https://mempool.space/api",
          label: "mempool.space (clearnet via Tor exit)",
          tier: "fallback",
        },
      ],
    },
    xbt: {
      chain: "xbt",
      lastSharedHeight: 961_631,
      checkpoints: [
        {
          height: 961_640,
          hash: "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb",
          source: "smolcars/bcashjr-wallet chain_verifier.ts; awesome-bitcoin-blake",
        },
      ],
      replayProtection: { kind: "unified-sighash", bit: SIGHASH_UNIFIED },
      minConfirmations: 20,
      defaultConfirmations: 50,
      defaultBackends: [
        {
          kind: "esplora",
          url: "http://mempool5nxspkxjk3n5afqh7zswbv4i324z76ltmw3cvfmniw45mnhad.onion/api",
          label: "mempool.guide (onion)",
          tier: "primary",
        },
        {
          kind: "esplora",
          url: "https://mempool.guide/api",
          label: "mempool.guide (clearnet via Tor exit)",
          tier: "fallback",
        },
      ],
      rpc: { requiredDeployment: "blake2b" },
    },
    ecx: {
      chain: "ecx",
      lastSharedHeight: 973_727,
      checkpoints: [
        {
          height: 973_728,
          hash: "0000000000000001441a6a4ae49d679d4a30581db3e3eaeeb2fba5da6dc146ed",
          source: "smolcars/ecashjr-wallet network.ts (explorer.ecash.com)",
        },
        {
          // After the first post-fork retarget (974,016): rejects nodes still on v1.0.0.
          height: 974_017,
          hash: "00000000000000008d487d52676c997de6b83c6712ef0914325f623e3d1ebc47",
          source: "explorer.ecash.com, 2026-10-31 (needs a second-source check before release)",
        },
      ],
      replayProtection: { kind: "locktime-marker", lockTime: ECX_MAINNET_REPLAY_LOCKTIME },
      minConfirmations: 20,
      defaultConfirmations: 50,
      defaultBackends: [
        {
          kind: "esplora",
          url: "https://explorer.ecash.com/api",
          label: "explorer.ecash.com (clearnet via Tor exit)",
          tier: "primary",
        },
        {
          kind: "esplora",
          url: "https://esplora.ecash.ninja",
          label: "esplora.ecash.ninja (clearnet via Tor exit)",
          tier: "fallback",
        },
      ],
    },
  },
});

export const PROFILES: Readonly<Record<string, NetworkProfile>> = Object.freeze({
  mainnet: MAINNET,
});

/**
 * Profiles registered by test code only (regtest rehearsals). Nothing user-reachable calls
 * registerProfileForTesting: it is not wired to the CLI, the environment, the config file or the UI,
 * and PROFILES (what users may choose and what error messages list) stays mainnet-only.
 */
const testProfiles = new Map<string, NetworkProfile>();

export function registerProfileForTesting(profile: NetworkProfile): void {
  if (!/^regtest-[a-z0-9-]+$/u.test(profile.id)) {
    throw new Error(`Test profile ids must look like "regtest-<name>", got "${profile.id}"`);
  }
  testProfiles.set(profile.id, deepFreeze(profile));
}

export function getProfile(id: string): NetworkProfile {
  const profile = PROFILES[id] ?? testProfiles.get(id);
  if (!profile) {
    throw new Error(
      `Unknown network profile "${id}". Available: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  return profile;
}

export function isChainId(value: string): value is ChainId {
  return (CHAIN_IDS as readonly string[]).includes(value);
}
