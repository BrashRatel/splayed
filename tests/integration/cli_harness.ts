import { join } from "node:path";
import { Transaction } from "@scure/btc-signer";
import { type CliIO, main } from "../../src/cli/main.ts";
import type { Plan } from "../../src/core/planner.ts";
import type { ChainId } from "../../src/core/profiles.ts";
import { decodePsbt, encodePsbtBase64 } from "../../src/core/psbt.ts";
import { CHAINS } from "./cluster.ts";
import { REGTEST_PROFILE_ID } from "./regtest_profile.ts";
import { RegtestRpcTransport, type RegtestTransportOptions, type Rpc } from "./rpc.ts";
import { stockSign, unifiedSign } from "./signers.ts";

/** splayed's real CLI, in a fresh data dir, with the three regtest nodes as its only backends. */
export interface Cli {
  dir: string;
  io: CliIO;
  run: (...args: string[]) => Promise<number>;
  /** Output and error text of the last `run`. */
  text: () => string;
  /** Standard output only (for `--json`). */
  stdout: () => string;
}

/**
 * `options` is shared with every transport the CLI makes, so a scenario can change it between
 * commands (see RegtestTransportOptions).
 */
export async function makeCli(
  nodes: Record<ChainId, Rpc>,
  options: RegtestTransportOptions = {},
): Promise<Cli> {
  const dir = await Deno.makeTempDir({ prefix: "splayed-it-" });
  const toml = ["[scan]", "jitter_min_ms = 0", "jitter_max_ms = 0", ""];
  for (const c of CHAINS) {
    toml.push(
      `[chains.${c}]`,
      "confirmations = 1",
      `[[chains.${c}.backends]]`,
      `kind = "rpc"`,
      `url = "http://127.0.0.1:${nodes[c].port}"`,
      `user = "regtest"`,
      `password_env = "SPLAYED_RPC_PW"`,
      "",
    );
  }
  await Deno.writeTextFile(join(dir, "splayed.toml"), toml.join("\n"));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    confirm: () => true,
    env: { SPLAYED_RPC_PW: "regtest" },
    tor: () => Promise.reject(new Error("regtest must never start or use Tor")),
    transportFactory: (_config, chain) => new RegtestRpcTransport(nodes[chain], options, chain),
  };
  return {
    dir,
    io,
    run: async (...args) => {
      out.length = 0;
      err.length = 0;
      return await main(["--data-dir", dir, "--profile", REGTEST_PROFILE_ID, ...args], io);
    },
    text: () => out.join("\n") + "\n" + err.join("\n"),
    stdout: () => out.join("\n"),
  };
}

export async function readPlan(cliDir: string, id: string): Promise<{ dir: string; plan: Plan }> {
  const dir = join(cliDir, "plans", id);
  return { dir, plan: JSON.parse(await Deno.readTextFile(join(dir, "plan.json"))) };
}

/** Ids of every plan written so far, oldest first. */
export async function planIds(cliDir: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const e of Deno.readDir(join(cliDir, "plans"))) if (e.isDirectory) ids.push(e.name);
  return ids.sort();
}

export async function readProgress(planDir: string) {
  return JSON.parse(await Deno.readTextFile(join(planDir, "progress.json"))) as {
    txs: Record<
      string,
      {
        verified?: { txid: string; finalHex: string };
        broadcast?: { status: string };
        replacedBy?: { plan: string };
        reorgs?: { kind: string }[];
      }
    >;
  };
}

/** Signs every PSBT in a plan like the real signers would: ordinary for ECX, 0x21 for XBT. */
export async function signPlan(
  planDir: string,
  plan: Plan,
  keys: Map<string, Uint8Array>,
): Promise<void> {
  for (const tx of plan.transactions) {
    const b64 = await Deno.readTextFile(join(planDir, tx.file));
    const signed = tx.chain === "ecx" ? stockSign(b64, keys) : unifiedSign(b64, keys);
    await Deno.writeTextFile(join(planDir, tx.file.replace(/\.psbt$/u, ".signed.psbt")), signed);
  }
}

/**
 * A valid, finalized ECX spend of the same inputs as a planned PSBT that pays a different amount:
 * what an ordinary BTC spend replayed onto ECX, or any other outside spender, would look like.
 */
export function foreignSpendHex(unsignedB64: string, keys: Map<string, Uint8Array>): string {
  const psbt = decodePsbt(unsignedB64.trim());
  psbt.tx.outputs[0].value -= 1000n;
  const signed = stockSign(encodePsbtBase64(psbt), keys);
  const tx = Transaction.fromPSBT(Uint8Array.from(atob(signed), (c) => c.charCodeAt(0)));
  tx.finalize();
  return tx.hex;
}

/** The raw hex of a fully signed PSBT, for sending it outside the tool (as another machine would). */
export function finalHexOf(signedB64: string): string {
  const tx = Transaction.fromPSBT(Uint8Array.from(atob(signedB64.trim()), (c) => c.charCodeAt(0)));
  tx.finalize();
  return tx.hex;
}
