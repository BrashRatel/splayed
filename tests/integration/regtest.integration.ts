/**
 * Regtest integration: real Bitcoin Core (BTC), Bitcoin Knots with BLAKE2b (XBT) and an eCash node
 * (ECX) in Docker. forksplit's own CLI runs end to end against their JSON-RPC:
 * init -> import -> scan -> dest -> plan -> (sign in test code) -> verify -> broadcast -> track.
 *
 *   deno task test:integration
 *
 * The three nodes share blocks 1..109, so the coins funded in that prefix exist at the same outpoint
 * on all three chains. Each node then mines its own chain. Nothing here touches mainnet, Tor or any
 * existing container: a random Compose project with fresh volumes and loopback-only ports.
 */
import { join } from "node:path";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { assert, assertEquals } from "../assert.ts";
import { type CliIO, main } from "../../src/cli/main.ts";
import { parseDescriptor } from "../../src/core/descriptors.ts";
import type { ChainId } from "../../src/core/profiles.ts";
import {
  makeRegtestProfile,
  REGTEST_PROFILE_ID,
  XBT_ACTIVATION_HEIGHT,
} from "./regtest_profile.ts";
import { RegtestRpcTransport, Rpc } from "./rpc.ts";
import { ignoresUnifiedSign, keyMap, stockSign, unifiedSign } from "./signers.ts";

const COMPOSE = new URL("./compose.yml", import.meta.url).pathname;
const CHAINS: ChainId[] = ["btc", "xbt", "ecx"];
const seed = (words: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(words));
const SOURCE = seed(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const OTHER = seed("legal winner thank year wave sausage worth useful legal winner thank yellow");
const fp = (k: HDKey) => k.fingerprint.toString(16).padStart(8, "0");
const account = SOURCE.derive("m/84'/0'/0'");
const SRC_DESC = `wpkh([${fp(SOURCE)}/84h/0h/0h]${account.publicExtendedKey}/<0;1>/*)`;
const ECX_DEST = `wpkh([${fp(OTHER)}/84h/0h/0h]${
  OTHER.derive("m/84'/0'/0'").publicExtendedKey
}/0/*)`;
const XBT_DEST = `wpkh([${fp(OTHER)}/84h/0h/1h]${
  OTHER.derive("m/84'/0'/1'").publicExtendedKey
}/0/*)`;
const keys = keyMap(account);
const source = parseDescriptor(SRC_DESC);

async function docker(project: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("docker", {
    args: ["compose", "-p", project, "-f", COMPOSE, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(`docker compose ${args.join(" ")} failed:\n${text}`);
  return text;
}

async function startNodes(project: string): Promise<Record<ChainId, Rpc>> {
  await docker(project, "build"); // layers are cached after the first run
  await docker(project, "up", "-d", "--no-build");
  const nodes = {} as Record<ChainId, Rpc>;
  for (const chain of CHAINS) {
    const port = Number((await docker(project, "port", chain, "18443")).trim().split(":").pop());
    const rpc = new Rpc(port);
    for (let i = 0;; i++) {
      try {
        await rpc.call("getblockcount");
        break;
      } catch (error) {
        if (i > 120) throw new Error(`${chain} node never became ready: ${error}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    nodes[chain] = rpc;
  }
  return nodes;
}

/** Regtest address for a script, from the node's own decoder (the app uses mainnet encodings). */
async function regtestAddress(node: Rpc, scriptPubKey: string): Promise<string> {
  return (await node.call<{ address: string }>("decodescript", scriptPubKey)).address;
}

async function copyBlocks(from: Rpc, to: Rpc[], upTo: number): Promise<void> {
  for (let h = 1; h <= upTo; h++) {
    const raw = await from.call<string>("getblock", await from.call("getblockhash", h), 0);
    for (const node of to) {
      const result = await node.call("submitblock", raw);
      if (result !== null) throw new Error(`submitblock at ${h}: ${result}`);
    }
  }
}

Deno.test({
  name: "regtest: split a shared coin across real BTC, XBT and ECX nodes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const project = `fsplit-it-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const nodes = await startNodes(project);
      for (const c of CHAINS) await nodes[c].call("createwallet", "miner");
      const wallet = (c: ChainId) => nodes[c].withWallet("miner");
      const minerAddr = (c: ChainId) => wallet(c).call<string>("getnewaddress");

      // Coins: two outputs to the test wallet, created in the shared prefix (heights < 110).
      const coinValues = [1, 0.5];
      await nodes.btc.mine(101, await minerAddr("btc"));
      for (let i = 0; i < coinValues.length; i++) {
        const addr = await regtestAddress(nodes.btc, source.branches[0].derive(i).scriptPubKey);
        await wallet("btc").call("sendtoaddress", addr, coinValues[i]);
      }
      await nodes.btc.mine(XBT_ACTIVATION_HEIGHT - 1 - 101, await minerAddr("btc"));
      await copyBlocks(nodes.btc, [nodes.xbt, nodes.ecx], XBT_ACTIVATION_HEIGHT - 1);

      // The chains diverge. Different payees make the BTC and ECX blocks differ; XBT is BLAKE2b.
      for (const c of CHAINS) await nodes[c].mine(6, await minerAddr(c));
      const checkpointHeight = XBT_ACTIVATION_HEIGHT + 2;
      const checkpoints = {} as Record<ChainId, { height: number; hash: string }>;
      for (const c of CHAINS) {
        checkpoints[c] = {
          height: checkpointHeight,
          hash: await nodes[c].call<string>("getblockhash", checkpointHeight),
        };
      }
      assertEquals(new Set(Object.values(checkpoints).map((c) => c.hash)).size, 3);
      makeRegtestProfile(checkpoints);

      // forksplit, driven through its real CLI with real node RPC as the only backends.
      const dir = await Deno.makeTempDir({ prefix: "forksplit-it-" });
      const toml = ["[scan]", "jitter_min_ms = 0", "jitter_max_ms = 0", ""];
      for (const c of CHAINS) {
        toml.push(
          `[chains.${c}]`,
          "confirmations = 1",
          `[[chains.${c}.backends]]`,
          `kind = "rpc"`,
          `url = "http://127.0.0.1:${nodes[c].port}"`,
          `user = "regtest"`,
          `password_env = "FSPLIT_RPC_PW"`,
          "",
        );
      }
      await Deno.writeTextFile(join(dir, "forksplit.toml"), toml.join("\n"));
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIO = {
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        confirm: () => true,
        env: { FSPLIT_RPC_PW: "regtest" },
        tor: () => Promise.reject(new Error("regtest must never start or use Tor")),
        transportFactory: (_config, chain) => new RegtestRpcTransport(nodes[chain]),
      };
      const run = async (...args: string[]) => {
        out.length = 0;
        err.length = 0;
        return await main(["--data-dir", dir, "--profile", REGTEST_PROFILE_ID, ...args], io);
      };
      const text = () => out.join("\n") + "\n" + err.join("\n");

      await t.step("init: identity checks pass on all three real nodes", async () => {
        assertEquals(await run("init", "--yes"), 0, text());
      });

      await t.step("init rejects a node on the wrong chain", async () => {
        const wrong: CliIO = {
          ...io,
          transportFactory: (_c, chain) =>
            new RegtestRpcTransport(nodes[chain === "ecx" ? "btc" : chain]),
        };
        const other = await Deno.makeTempDir({ prefix: "forksplit-it-wrong-" });
        await Deno.copyFile(join(dir, "forksplit.toml"), join(other, "forksplit.toml"));
        const code = await main(
          ["--data-dir", other, "--profile", REGTEST_PROFILE_ID, "init", "--yes"],
          wrong,
        );
        assertEquals(code, 1);
      });

      await t.step("import + scan: both coins are shared on all three chains", async () => {
        assertEquals(await run("import", SRC_DESC, "--label", "it"), 0, text());
        assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
        assertEquals(await run("status", "--json"), 0, text());
        const status = JSON.parse(out.join("\n"));
        const coins = status.coins as { classification: { status: string; unspentOn: string[] } }[];
        assertEquals(coins.length, 2, text());
        for (const coin of coins) {
          assertEquals(coin.classification.status, "shared", JSON.stringify(coin));
        }
      });

      let planDir = "";
      let planId = "";
      let plan: { transactions: { chain: string; file: string }[] };
      await t.step("plan: one PSBT per coin per fork", async () => {
        assertEquals(await run("dest", "set", "ecx", ECX_DEST), 0, text());
        assertEquals(await run("dest", "set", "xbt", XBT_DEST), 0, text());
        assertEquals(
          await run("plan", "--xbt-signer", "knots", "--fee-rate", "ecx=2,xbt=3", "--yes"),
          0,
          text(),
        );
        for await (const e of Deno.readDir(join(dir, "plans"))) planId = e.name;
        planDir = join(dir, "plans", planId);
        plan = JSON.parse(await Deno.readTextFile(join(planDir, "plan.json")));
        assertEquals(plan.transactions.filter((x) => x.chain === "ecx").length, 2);
        assertEquals(plan.transactions.filter((x) => x.chain === "xbt").length, 2);
      });

      const signAll = async (xbtSigner: (b64: string) => string) => {
        for (const tx of plan.transactions) {
          const b64 = await Deno.readTextFile(join(planDir, tx.file));
          const signed = tx.chain === "ecx" ? stockSign(b64, keys) : xbtSigner(b64);
          await Deno.writeTextFile(
            join(planDir, tx.file.replace(/\.psbt$/u, ".signed.psbt")),
            signed,
          );
        }
      };

      await t.step("verify refuses XBT signatures that are plain SIGHASH_ALL", async () => {
        await signAll((b64) => ignoresUnifiedSign(b64, keys));
        assertEquals(await run("verify", planId), 1, text());
        assert(text().includes("signature hash type 0x01, not 0x21"), text());
      });

      await t.step("verify accepts the real signatures; the real nodes agree", async () => {
        await signAll((b64) => unifiedSign(b64, keys));
        assertEquals(await run("verify", planId), 0, text());
      });

      await t.step("broadcast, confirm, track", async () => {
        assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
        for (const c of CHAINS) await nodes[c].mine(2, await minerAddr(c));
        assertEquals(await run("track", planId), 0, text());
      });

      await t.step("replaying a confirmed fork split onto another chain is rejected", async () => {
        const progress = JSON.parse(await Deno.readTextFile(join(planDir, "progress.json")));
        const byChain = new Map<string, string[]>();
        for (const tx of plan.transactions) {
          byChain.set(tx.chain, [
            ...(byChain.get(tx.chain) ?? []),
            progress.txs[tx.file].verified.finalHex,
          ]);
        }
        for (const [chain, hexes] of byChain) {
          for (const hex of hexes) {
            for (const other of CHAINS.filter((c) => c !== chain)) {
              const [r] = await nodes[other].call<{ allowed: boolean }[]>("testmempoolaccept", [
                hex,
              ]);
              assertEquals(r.allowed, false, `${chain} split was accepted by ${other}`);
            }
          }
        }
      });

      await t.step("rescan: coins are separated and the BTC copies are untouched", async () => {
        assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
        assertEquals(await run("status", "--json"), 0, text());
        const status = JSON.parse(out.join("\n"));
        const coins = status.coins as { classification: { status: string; unspentOn: string[] } }[];
        for (const coin of coins) {
          assert(
            coin.classification.unspentOn.join() === "btc" &&
              ["separated", "pending"].includes(coin.classification.status),
            JSON.stringify(coin),
          );
        }
        const btcUtxos = await nodes.btc.call<{ unspents: unknown[] }>("scantxoutset", "start", [
          `addr(${await regtestAddress(nodes.btc, source.branches[0].derive(0).scriptPubKey)})`,
        ]);
        assertEquals(btcUtxos.unspents.length, 1);
      });
    } finally {
      await docker(project, "down", "-v", "--remove-orphans").catch(() => {});
    }
  },
});
