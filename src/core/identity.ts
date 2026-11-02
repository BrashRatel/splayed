// Checkpoint pattern adapted from smolcars/bcashjr-wallet src/core/chain_verifier.ts (MIT).
import type { ChainBackend } from "../backends/types.ts";
import type { ChainProfile } from "./profiles.ts";
import { shortBlockHash } from "./bytes.ts";

export interface IdentityResult {
  ok: boolean;
  tip?: number;
  detail: string;
}

/**
 * A backend is trusted for a chain only if it reports the pinned hash at every checkpoint.
 * This is what stops a BTC explorer being used as the XBT backend (they run the same software),
 * and what catches ECX nodes still on v1.0.0 (they split off at 974,016).
 * Never learn a checkpoint from the backend being checked.
 */
export async function verifyIdentity(
  backend: ChainBackend,
  profile: ChainProfile,
): Promise<IdentityResult> {
  try {
    const tip = await backend.tipHeight();
    const highest = Math.max(...profile.checkpoints.map((c) => c.height));
    if (tip < highest) {
      return { ok: false, tip, detail: `tip ${tip} is behind checkpoint ${highest}` };
    }
    for (const checkpoint of profile.checkpoints) {
      const hash = await backend.blockHash(checkpoint.height);
      if (hash !== checkpoint.hash) {
        return {
          ok: false,
          tip,
          detail: `wrong chain: block ${checkpoint.height} is ${shortBlockHash(hash)}, expected ` +
            shortBlockHash(checkpoint.hash),
        };
      }
    }
    const problems = await backend.identityProblems();
    if (problems.length) return { ok: false, tip, detail: problems.join("; ") };
    return {
      ok: true,
      tip,
      detail: `tip ${tip}; matches ${profile.checkpoints.length} checkpoint(s)`,
    };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
