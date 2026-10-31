import {
  type ChainId,
  type ChainProfile,
  ECX_MAINNET_REPLAY_LOCKTIME,
  type NetworkProfile,
  registerProfileForTesting,
  SIGHASH_UNIFIED,
} from "../../src/core/profiles.ts";

export const REGTEST_PROFILE_ID = "regtest-integration";

/** First regtest height where the Knots node uses BLAKE2b (compose.yml: blake2b@110). */
export const XBT_ACTIVATION_HEIGHT = 110;

export interface RegtestCheckpoint {
  height: number;
  hash: string;
}

/**
 * A regtest stand-in for the mainnet profile. Checkpoints are read from the running nodes after
 * they have diverged, so each chain's identity check pins that node's own block. Replay-protection
 * rules are the real mainnet constants; only the heights, hashes and backends differ.
 */
export function makeRegtestProfile(
  checkpoints: Record<ChainId, RegtestCheckpoint>,
): NetworkProfile {
  const chain = (id: ChainId, extra: Partial<ChainProfile>): ChainProfile => ({
    chain: id,
    checkpoints: [{ ...checkpoints[id], source: "regtest node" }],
    replayProtection: { kind: "none" },
    minConfirmations: 1,
    defaultConfirmations: 1,
    defaultBackends: [],
    ...extra,
  });
  const profile: NetworkProfile = {
    id: REGTEST_PROFILE_ID,
    description: "Regtest rehearsal (test code only)",
    addressNetwork: "regtest",
    chains: {
      btc: chain("btc", {}),
      xbt: chain("xbt", {
        lastSharedHeight: XBT_ACTIVATION_HEIGHT - 1,
        replayProtection: { kind: "unified-sighash", bit: SIGHASH_UNIFIED },
        rpc: { requiredDeployment: "blake2b" },
      }),
      ecx: chain("ecx", {
        lastSharedHeight: XBT_ACTIVATION_HEIGHT - 1,
        replayProtection: { kind: "locktime-marker", lockTime: ECX_MAINNET_REPLAY_LOCKTIME },
      }),
    },
  };
  registerProfileForTesting(profile);
  return profile;
}
