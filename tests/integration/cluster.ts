/**
 * Helpers shared by the throwaway integration test and the long-lived `deno task regtest`
 * environment: driving Docker Compose and moving blocks between the three regtest nodes.
 */
import type { ChainId } from "../../src/core/profiles.ts";
import { Rpc } from "./rpc.ts";

export const COMPOSE_FILE = new URL("./compose.yml", import.meta.url).pathname;
export const CHAINS: ChainId[] = ["btc", "xbt", "ecx"];

/** Runs `docker compose` for a project; `env` feeds the compose file's ${...} variables. */
export async function docker(
  project: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  const out = await new Deno.Command("docker", {
    args: ["compose", "-p", project, "-f", COMPOSE_FILE, ...args],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(`docker compose ${args.join(" ")} failed:\n${text}`);
  return text;
}

/** The host port a service's RPC (container port 18443) is published on. */
export async function publishedPort(
  project: string,
  chain: ChainId,
  env: Record<string, string> = {},
): Promise<number> {
  const text = await docker(project, ["port", chain, "18443"], env);
  return Number(text.trim().split("\n")[0].split(":").pop());
}

export async function waitReady(rpc: Rpc, name: string, seconds = 120): Promise<void> {
  for (let i = 0;; i++) {
    try {
      await rpc.call("getblockcount");
      return;
    } catch (error) {
      if (i > seconds) throw new Error(`${name} node never became ready: ${error}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Submits blocks `from+1 ..= upTo` of `source` to every node in `to`. */
export async function copyBlocks(
  source: Rpc,
  to: Rpc[],
  from: number,
  upTo: number,
): Promise<void> {
  for (let h = from + 1; h <= upTo; h++) {
    const raw = await source.call<string>("getblock", await source.call("getblockhash", h), 0);
    for (const node of to) {
      const result = await node.call("submitblock", raw);
      if (result !== null) throw new Error(`submitblock at ${h}: ${result}`);
    }
  }
}

export function nodesOnPorts(ports: Record<ChainId, number>): Record<ChainId, Rpc> {
  return {
    btc: new Rpc(ports.btc),
    xbt: new Rpc(ports.xbt),
    ecx: new Rpc(ports.ecx),
  };
}
