/**
 * A long-lived regtest environment for trying splayed by hand: real Bitcoin Core (BTC), Knots
 * with BLAKE2b (XBT) and eCash (ECX) in Docker, splayed's web UI wired to them, and your own
 * regtest wallets (Sparrow, Shrike, ...) for signing.
 *
 *   deno task regtest up                      start the three nodes, mine the shared history
 *   deno task regtest fund <descriptor|addr>  put coins on your wallet, on ALL THREE chains
 *   deno task regtest fork                    split the chains apart (no more shared coins after)
 *   deno task regtest ui                      run the splayed web UI against the nodes
 *   deno task regtest mine <chain|all> [n]    confirm what you broadcast
 *   deno task regtest check <plan>            ask every node about a plan's signed transactions
 *   deno task regtest reorg <chain> [depth]   force a reorg, to see what `track` reports
 *   deno task regtest status | stop | down
 *
 * Order matters: coins can only be shared on all three chains if they are funded BEFORE the fork.
 * This is not for mainnet and never touches Tor, mainnet data or other containers.
 */
import { join } from "node:path";
import { type CliIO, main } from "../../src/cli/main.ts";
import { parseDescriptor, REGTEST_NETWORK } from "../../src/core/descriptors.ts";
import type { ChainId } from "../../src/core/profiles.ts";
import { startUi } from "../../src/ui/server.ts";
import { CHAINS, copyBlocks, docker, nodesOnPorts, waitReady } from "./cluster.ts";
import {
  makeRegtestProfile,
  REGTEST_PROFILE_ID,
  XBT_ACTIVATION_HEIGHT,
} from "./regtest_profile.ts";
import { RegtestRpcTransport, type Rpc } from "./rpc.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const STATE_DIR = join(ROOT, ".data", "regtest");
const STATE_FILE = join(STATE_DIR, "env.json");
const APP_DIR = join(STATE_DIR, "splayed");
const PROJECT = "splayed-regtest";
const DEFAULT_PORTS: Record<ChainId, number> = { btc: 18443, xbt: 18543, ecx: 18643 };
const RPC_USER = "regtest";
const RPC_PASSWORD = "regtest";
const MINER = "miner";
/** Funding is only possible while every chain still shares the history, i.e. below the fork. */
const LAST_SHARED = XBT_ACTIVATION_HEIGHT - 1;
const UI_PORT = 18080;

interface EnvState {
  bind: string;
  ports: Record<ChainId, number>;
  phase: "prefix" | "forked";
  /** Highest BTC block already submitted to the XBT and ECX nodes. */
  syncedHeight: number;
  checkpoints?: Record<ChainId, { height: number; hash: string }>;
}

class UserError extends Error {}

const composeEnv = (s: Pick<EnvState, "bind" | "ports">): Record<string, string> => ({
  SPLAYED_BIND: s.bind,
  SPLAYED_BTC_PORT: String(s.ports.btc),
  SPLAYED_XBT_PORT: String(s.ports.xbt),
  SPLAYED_ECX_PORT: String(s.ports.ecx),
  SPLAYED_RESTART: "unless-stopped",
});

async function readState(): Promise<EnvState | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(STATE_FILE));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function writeState(s: EnvState): Promise<void> {
  await Deno.mkdir(STATE_DIR, { recursive: true });
  await Deno.writeTextFile(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

async function requireState(): Promise<EnvState> {
  const s = await readState();
  if (!s) throw new UserError("No regtest environment yet. Run: deno task regtest up");
  return s;
}

const nodesFor = (s: EnvState) => nodesOnPorts(s.ports);
const minerAddress = (node: Rpc) => node.withWallet(MINER).call<string>("getnewaddress");

function portIsFree(bind: string, port: number): boolean {
  try {
    Deno.listen({ hostname: bind, port }).close();
    return true;
  } catch {
    return false;
  }
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const [k, inline] = args[i].slice(2).split("=");
      flags[k] = inline ?? args[++i] ?? "";
    } else positional.push(args[i]);
  }
  return { positional, flags };
}

// ---- commands ----

async function up(flags: Record<string, string>) {
  const existing = await readState();
  if (existing) {
    await docker(PROJECT, ["up", "-d", "--no-build"], composeEnv(existing));
    for (const c of CHAINS) await waitReady(nodesFor(existing)[c], c);
    console.log("The environment was already set up; its nodes are running again.\n");
    return await status();
  }
  const bind = flags.bind ?? "0.0.0.0";
  const ports: Record<ChainId, number> = {
    btc: Number(flags["btc-port"] ?? DEFAULT_PORTS.btc),
    xbt: Number(flags["xbt-port"] ?? DEFAULT_PORTS.xbt),
    ecx: Number(flags["ecx-port"] ?? DEFAULT_PORTS.ecx),
  };
  for (const c of CHAINS) {
    if (!portIsFree(bind === "0.0.0.0" ? "127.0.0.1" : bind, ports[c])) {
      throw new UserError(`Port ${ports[c]} (${c}) is in use. Pick another with --${c}-port.`);
    }
  }
  if (bind !== "127.0.0.1") {
    console.log(
      `WARNING: the node RPC ports listen on ${bind} with the PUBLIC password ` +
        `"${RPC_PASSWORD}", so anyone on your network can use them. Use a network you trust, ` +
        `or pass --bind 127.0.0.1 to keep them on this machine.\n`,
    );
  }
  console.log("Building the node images (the first build compiles eCash, about 5 minutes)...");
  const env = composeEnv({ bind, ports });
  await docker(PROJECT, ["build"], env);
  await docker(PROJECT, ["up", "-d", "--no-build"], env);
  const nodes = nodesOnPorts(ports);
  for (const c of CHAINS) {
    await waitReady(nodes[c], c);
    await nodes[c].call("createwallet", MINER);
  }
  console.log("Mining the shared history (101 blocks, so the first coinbase can be spent)...");
  await nodes.btc.mine(101, await minerAddress(nodes.btc));
  await copyBlocks(nodes.btc, [nodes.xbt, nodes.ecx], 0, 101);
  await writeState({ bind, ports, phase: "prefix", syncedHeight: 101 });
  console.log("Ready.\n");
  await status();
}

async function fund(positional: string[], flags: Record<string, string>) {
  const s = await requireState();
  if (s.phase !== "prefix") {
    throw new UserError(
      "The chains have already forked, so new coins would exist on BTC only. Fund before " +
        "`fork`, or `down` and start over.",
    );
  }
  const target = positional[0];
  if (!target) throw new UserError("fund <descriptor|address> [--coins N] [--btc AMOUNT]");
  const nodes = nodesFor(s);
  const amount = Number(flags.btc ?? 1);
  const addresses: string[] = [];
  if (target.includes("(")) {
    // A descriptor: fund its first N receive addresses (what a wallet shows first).
    const parsed = parseDescriptor(target, REGTEST_NETWORK);
    const count = Number(flags.coins ?? 2);
    for (let i = 0; i < count; i++) addresses.push(parsed.branches[0].derive(i).address);
  } else {
    addresses.push(target);
  }
  const height = await nodes.btc.call<number>("getblockcount");
  if (height + 1 > LAST_SHARED) {
    throw new UserError(
      `Block ${height + 1} would be past the fork height (${XBT_ACTIVATION_HEIGHT}). ` +
        "No more funding is possible on this environment: `down` and `up` for a fresh one.",
    );
  }
  const outputs = Object.fromEntries(addresses.map((a) => [a, amount]));
  const txid = await nodes.btc.withWallet(MINER).call<string>("sendmany", "", outputs);
  await nodes.btc.mine(1, await minerAddress(nodes.btc));
  await copyBlocks(nodes.btc, [nodes.xbt, nodes.ecx], s.syncedHeight, height + 1);
  await writeState({ ...s, syncedHeight: height + 1 });
  console.log(`Sent ${amount} BTC to each of ${addresses.length} address(es) in ${txid}:`);
  for (const a of addresses) console.log(`  ${a}`);
  console.log(
    `\nThe coins now exist at the same outpoints on BTC, XBT and ECX (block ${height + 1}). ` +
      `${LAST_SHARED - (height + 1)} more funding block(s) are possible before the fork.`,
  );
}

/**
 * Donors for the advanced routes: coinbase outputs mined after the fork, which exist on one chain
 * only. XBT donors serve the forks-first donor route, BTC donors the BTC-first route.
 */
async function donors(positional: string[], flags: Record<string, string>) {
  const s = await requireState();
  const chain = (flags.chain ?? "xbt").toLowerCase();
  if (chain !== "xbt" && chain !== "btc") {
    throw new UserError("--chain is xbt (forks-first route) or btc (BTC-first route)");
  }
  const name = chain.toUpperCase();
  if (s.phase !== "forked") {
    throw new UserError(`Run \`fork\` first: donors are coins that exist on ${name} only.`);
  }
  const target = positional[0];
  if (!target) throw new UserError("donors <descriptor|address> [--coins N] [--chain xbt|btc]");
  const nodes = nodesFor(s);
  const addresses: string[] = [];
  if (target.includes("(")) {
    const parsed = parseDescriptor(target, REGTEST_NETWORK);
    const count = Number(flags.coins ?? 2);
    for (let i = 0; i < count; i++) addresses.push(parsed.branches[0].derive(i).address);
  } else {
    addresses.push(target);
  }
  const node = nodes[chain];
  for (const a of addresses) await node.mine(1, a);
  // A coinbase output can't be spent for 100 blocks.
  await node.mine(100, await minerAddress(node));
  console.log(`Mined one ${name} block to each of ${addresses.length} address(es), then 100 more:`);
  for (const a of addresses) console.log(`  ${a}   (50 BTC coinbase, ${name} only)`);
  console.log(
    chain === "xbt"
      ? "\nThese coins do not exist on BTC or ECX. In splayed: `donor import <descriptor>`, " +
        "`donor scan`, then `plan --donor txid:vout` (one donor per XBT transaction)."
      : "\nThese coins do not exist on XBT or ECX. In splayed: `dest set btc <descriptor>`, " +
        "`donor import <descriptor>`, `donor scan`, then `plan --btc-first --donor txid:vout` " +
        "(one donor per BTC transaction). Use a donor wallet other than your source wallet.",
  );
}

async function fork() {
  const s = await requireState();
  if (s.phase === "forked") throw new UserError("Already forked.");
  const nodes = nodesFor(s);
  const prefix = s.syncedHeight;
  // Each chain mines on its own, to its own address. The XBT node must pass its BLAKE2b height.
  const blocks = Math.max(6, XBT_ACTIVATION_HEIGHT + 3 - prefix);
  console.log(`Forking after block ${prefix}: mining ${blocks} blocks on each chain...`);
  for (const c of CHAINS) await nodes[c].mine(blocks, await minerAddress(nodes[c]));
  const height = prefix + 2; // the second block after the split point: different on every chain
  const checkpoints = {} as NonNullable<EnvState["checkpoints"]>;
  for (const c of CHAINS) {
    checkpoints[c] = { height, hash: await nodes[c].call<string>("getblockhash", height) };
  }
  if (new Set(Object.values(checkpoints).map((c) => c.hash)).size !== 3) {
    throw new Error("The three chains did not diverge; something is wrong with the environment.");
  }
  await writeState({ ...s, phase: "forked", checkpoints });
  console.log("Done. The three chains now have separate histories.\n");
  console.log("Next: deno task regtest ui");
}

async function mine(positional: string[]) {
  const s = await requireState();
  if (s.phase !== "forked") {
    throw new UserError("Mine after `fork` (before it, `fund` mines the blocks that are needed).");
  }
  const [which = "all", count = "1"] = positional;
  const chains = which === "all" ? CHAINS : [which as ChainId];
  if (!chains.every((c) => CHAINS.includes(c))) throw new UserError("mine <btc|xbt|ecx|all> [n]");
  const nodes = nodesFor(s);
  for (const c of chains) {
    await nodes[c].mine(Number(count), await minerAddress(nodes[c]));
    console.log(`${c.toUpperCase()}: height ${await nodes[c].call("getblockcount")}`);
  }
}

async function reorg(positional: string[]) {
  const s = await requireState();
  if (s.phase !== "forked") throw new UserError("Reorgs only make sense after `fork`.");
  const chain = positional[0] as ChainId;
  if (!CHAINS.includes(chain)) throw new UserError("reorg <btc|xbt|ecx> [depth]");
  const depth = Number(positional[1] ?? 2);
  const node = nodesFor(s)[chain];
  const tip = await node.call<number>("getblockcount");
  const checkpoint = s.checkpoints![chain].height;
  if (tip - depth + 1 <= checkpoint) throw new UserError("That would undo the pinned checkpoint.");
  await node.call("invalidateblock", await node.call("getblockhash", tip - depth + 1));
  console.log(
    `${chain.toUpperCase()}: undid ${depth} block(s); their transactions are back in the mempool.`,
  );
  await node.mine(depth + 1, await minerAddress(node));
  console.log(
    `Mined ${depth + 1} replacement block(s): height ${await node.call("getblockcount")}.`,
  );
  console.log("Now run `track` in the UI (or CLI) for a plan broadcast on that chain.");
}

async function status() {
  const s = await requireState();
  const nodes = nodesFor(s);
  console.log(`Phase: ${s.phase === "prefix" ? "shared history (fund, then fork)" : "forked"}`);
  console.log(`Data:  ${STATE_DIR}\n`);
  const labels: Record<ChainId, string> = {
    btc: "BTC  Bitcoin Core",
    xbt: "XBT  Knots, BLAKE2b",
    ecx: "ECX  eCash",
  };
  for (const c of CHAINS) {
    try {
      const height = await nodes[c].call<number>("getblockcount");
      const pool = (await nodes[c].call<string[]>("getrawmempool")).length;
      console.log(
        `${labels[c]}  http://${s.bind === "0.0.0.0" ? "<this-host>" : s.bind}:${s.ports[c]}  ` +
          `height ${height}  mempool ${pool}`,
      );
    } catch (error) {
      console.log(`${labels[c]}  port ${s.ports[c]}  NOT RESPONDING: ${(error as Error).message}`);
    }
  }
  const host = s.bind === "127.0.0.1" ? "127.0.0.1" : "<this machine's LAN address>";
  console.log(`
Wallet setup (RPC user "${RPC_USER}", password "${RPC_PASSWORD}", network regtest):
  Sparrow (BTC):          Server -> Bitcoin Core, host ${host}, port ${s.ports.btc}
  Sparrow BLAKE2b (XBT):  Server -> Bitcoin Core, host ${host}, port ${s.ports.xbt}
  Shrike (XBT, 0x21):     point it at port ${s.ports.xbt}; ECX transactions sign with any wallet
  ECX node:               port ${s.ports.ecx}
  Your wallet and splayed need the SAME coins: use \`fund\` with the wallet's descriptor.
${
    s.bind === "127.0.0.1"
      ? "  (The ports listen on this machine only. From another machine, tunnel them with ssh -L.)\n"
      : ""
  }`);
}

async function ui(flags: Record<string, string>) {
  const s = await requireState();
  if (s.phase !== "forked" || !s.checkpoints) {
    throw new UserError("Run `fork` first: splayed needs the chains to have diverged.");
  }
  makeRegtestProfile(s.checkpoints);
  await Deno.mkdir(APP_DIR, { recursive: true });
  const configPath = join(APP_DIR, "splayed.toml");
  try {
    await Deno.stat(configPath);
  } catch {
    const toml = ["[scan]", "jitter_min_ms = 0", "jitter_max_ms = 0", ""];
    for (const c of CHAINS) {
      toml.push(
        `[chains.${c}]`,
        "confirmations = 1",
        `[[chains.${c}.backends]]`,
        `kind = "rpc"`,
        `url = "http://127.0.0.1:${s.ports[c]}"`,
        `user = "${RPC_USER}"`,
        `password_env = "SPLAYED_RPC_PW"`,
        `label = "regtest ${c.toUpperCase()} node"`,
        "",
      );
    }
    await Deno.writeTextFile(configPath, toml.join("\n"));
  }
  const nodes = nodesFor(s);
  const baseIO: Omit<CliIO, "out" | "err" | "confirm"> = {
    env: { SPLAYED_PROFILE: REGTEST_PROFILE_ID, SPLAYED_RPC_PW: RPC_PASSWORD },
    tor: () => Promise.reject(new Error("The regtest environment never uses Tor")),
    transportFactory: (_config, chain) => new RegtestRpcTransport(nodes[chain]),
  };
  const port = Number(flags.port ?? UI_PORT);
  const lan = (flags.bind ?? "0.0.0.0") !== "127.0.0.1";
  const server = startUi({
    dataDir: APP_DIR,
    port,
    run: main,
    baseIO,
    listenOnAllInterfaces: lan,
    devTools: {
      heights: async () => {
        const out: Record<string, number> = {};
        for (const c of CHAINS) out[c] = await nodes[c].call<number>("getblockcount");
        return out;
      },
      mine: async (which, count) => {
        const chains = which === "all" ? CHAINS : CHAINS.filter((c) => c === which);
        if (!chains.length) throw new Error("chain must be btc, xbt, ecx or all");
        const out: Record<string, number> = {};
        for (const c of chains) {
          await nodes[c].mine(count, await minerAddress(nodes[c]));
          out[c] = await nodes[c].call<number>("getblockcount");
        }
        return out;
      },
    },
  });
  console.log(`splayed UI (regtest profile): ${server.url}\n`);
  console.log("Open that exact URL: it carries the access token. Ctrl+C to stop.");
  console.log(
    lan
      ? `Test environment: also listening on all interfaces. From the LAN open ` +
        `http://<this-host>:${server.port}/ with the same #token=... (plain HTTP, so use a ` +
        `network you trust; --bind 127.0.0.1 keeps it local).`
      : `From another machine, forward the same port first:  ssh -L ${server.port}:127.0.0.1:${server.port} <this-host>\n` +
        `and open http://localhost:${server.port}/#token=...`,
  );
  console.log(`\nIts data (wallet, scans, plans, PSBTs) lives in ${APP_DIR}`);
  await server.server.finished;
}

/** Asks every node about each signed transaction of a plan, independently of splayed's checks. */
async function check(positional: string[]) {
  const s = await requireState();
  const id = positional[0];
  if (!id) throw new UserError("check <plan-id>   (see the plan ids in the UI's Plans tab)");
  const dir = join(APP_DIR, "plans", id);
  let plan: { transactions: { chain: ChainId; file: string }[] };
  let progress: { txs: Record<string, { verified?: { finalHex: string; txid: string } }> };
  try {
    plan = JSON.parse(await Deno.readTextFile(join(dir, "plan.json")));
    progress = JSON.parse(await Deno.readTextFile(join(dir, "progress.json")));
  } catch {
    throw new UserError(`No verified transactions for plan "${id}". Run verify in the UI first.`);
  }
  const nodes = nodesFor(s);
  let bad = 0;
  let masked = false;
  for (const tx of plan.transactions) {
    const v = progress.txs[tx.file]?.verified;
    if (!v) {
      console.log(`${tx.file}: not verified yet`);
      continue;
    }
    console.log(`\n${tx.chain.toUpperCase()} split ${tx.file}  txid ${v.txid}`);
    for (const c of CHAINS) {
      const [r] = await nodes[c].call<{ allowed: boolean; "reject-reason"?: string }[]>(
        "testmempoolaccept",
        [v.finalHex],
      );
      const own = c === tx.chain;
      // Already in the mempool or chain counts as accepted for the chain it belongs to.
      const accepted = r.allowed ||
        (own && /already|known|conflict/iu.test(r["reject-reason"] ?? ""));
      const ok = own ? accepted : !r.allowed;
      if (!ok) bad++;
      if (/already|insufficient fee|conflict/iu.test(r["reject-reason"] ?? "")) masked = true;
      console.log(
        `  ${c.toUpperCase()} node: ${r.allowed ? "accepts" : `rejects (${r["reject-reason"]})`}` +
          `  ${ok ? "OK" : "WRONG"}  [should ${own ? "accept" : "reject"}]`,
      );
    }
  }
  if (masked) {
    console.log(
      "\nNote: after a broadcast, 'already in mempool' and 'insufficient fee' come from the real " +
        "split occupying the same inputs, not from the script check. `check` is cleanest before " +
        "you broadcast.",
    );
  }
  console.log(
    bad
      ? `\n${bad} node answer(s) were not what replay protection requires.`
      : "\nEvery node answered as it should.",
  );
  if (bad) Deno.exitCode = 1;
}

async function stop() {
  const s = await requireState();
  await docker(PROJECT, ["stop"], composeEnv(s));
  console.log("Stopped. `up` starts it again with the same chains.");
}

async function down() {
  const s = await readState();
  await docker(PROJECT, ["down", "-v", "--remove-orphans"], s ? composeEnv(s) : {});
  await Deno.remove(STATE_DIR, { recursive: true }).catch(() => {});
  console.log("Removed the containers, volumes and state.");
}

const HELP = `deno task regtest <command>

  up [--bind ADDR (default 0.0.0.0: reachable from the LAN)] [--btc-port N --xbt-port N --ecx-port N]
  fund <descriptor|address> [--coins N] [--btc AMOUNT]   (before fork)
  fork
  donors <descriptor|address> [--coins N] [--chain xbt|btc]
                                            (after fork: single-chain donor coins; xbt default,
                                             btc for the BTC-first route)
  ui [--port N] [--bind 127.0.0.1 to keep it local]
  mine <btc|xbt|ecx|all> [n]
  check <plan-id>
  reorg <btc|xbt|ecx> [depth]
  status | stop | down
`;

if (import.meta.main) {
  const [command, ...rest] = Deno.args;
  const { positional, flags } = parseFlags(rest);
  try {
    switch (command) {
      case "up":
        await up(flags);
        break;
      case "fund":
        await fund(positional, flags);
        break;
      case "fork":
        await fork();
        break;
      case "ui":
        await ui(flags);
        break;
      case "donors":
        await donors(positional, flags);
        break;
      case "mine":
        await mine(positional);
        break;
      case "check":
        await check(positional);
        break;
      case "reorg":
        await reorg(positional);
        break;
      case "status":
        await status();
        break;
      case "stop":
        await stop();
        break;
      case "down":
        await down();
        break;
      default:
        console.log(HELP);
        if (command) Deno.exitCode = 2;
    }
  } catch (error) {
    if (error instanceof UserError) {
      console.error(`Error: ${error.message}`);
      Deno.exitCode = 1;
    } else throw error;
  }
}
