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
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { assert, assertEquals } from "../assert.ts";
import { type CliIO, main } from "../../src/cli/main.ts";
import { parseDescriptor } from "../../src/core/descriptors.ts";
import type { ChainId } from "../../src/core/profiles.ts";
import {
  makeRegtestProfile,
  REGTEST_PROFILE_ID,
  XBT_ACTIVATION_HEIGHT,
} from "./regtest_profile.ts";
import { makeCli } from "./cli_harness.ts";
import { CHAINS, copyBlocks, docker, publishedPort, waitReady } from "./cluster.ts";
import { RegtestRpcTransport, Rpc } from "./rpc.ts";
import { btcFirstScenario, donorScenario, rbfScenario, reorgScenario } from "./scenarios.ts";
import { ignoresUnifiedSign, keyMap, stockSign, unifiedSign } from "./signers.ts";

const seed = (words: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(words));
const OTHER = seed("legal winner thank year wave sausage worth useful legal winner thank yellow");
const fp = (k: HDKey) => k.fingerprint.toString(16).padStart(8, "0");
const ECX_DEST = `wpkh([${fp(OTHER)}/84h/0h/0h]${
  OTHER.derive("m/84'/0'/0'").publicExtendedKey
}/0/*)`;
const XBT_DEST = `wpkh([${fp(OTHER)}/84h/0h/1h]${
  OTHER.derive("m/84'/0'/1'").publicExtendedKey
}/0/*)`;
const BTC_DEST = `wpkh([${fp(OTHER)}/84h/0h/2h]${
  OTHER.derive("m/84'/0'/2'").publicExtendedKey
}/0/*)`;

/** Deterministic, valid mnemonics so each wallet group gets its own coins. */
const words = (n: number) => entropyToMnemonic(new Uint8Array(16).fill(n), english);
const DEFAULT_SINGLE = words(1);
const DEFAULT_COSIGNERS = [words(2), words(3), words(4)];

const COIN_VALUES = [1, 0.5]; // BTC per coin; every descriptor gets one coin of each

/** A source wallet to split, with the keys test code signs it with. */
interface WalletSpec {
  name: string;
  /** Descriptors imported together; the wallet's coins are the union of theirs. */
  descriptors: string[];
  /** Enough keys to satisfy every descriptor. */
  keys: Map<string, Uint8Array>;
  /** Too few keys for at least one multisig input: verify must refuse the result. */
  belowThreshold?: Map<string, Uint8Array>;
  /** `plan --batch` value; "all" puts every coin of a fork in one transaction. */
  batch?: string;
}

interface Part {
  descriptor: string;
  keys: Map<string, Uint8Array>;
  belowThreshold?: Map<string, Uint8Array>;
}

function singleSigPart(
  purpose: number,
  wrap: (inner: string) => string,
  mnemonic = DEFAULT_SINGLE,
): Part {
  const root = seed(mnemonic);
  const account = root.derive(`m/${purpose}'/0'/0'`);
  return {
    descriptor: wrap(`[${fp(root)}/${purpose}h/0h/0h]${account.publicExtendedKey}/<0;1>/*`),
    keys: keyMap(account),
  };
}

/** 2-of-3 sortedmulti with three independent cosigners. */
function multiSigPart(wrap: (inner: string) => string, mnemonics = DEFAULT_COSIGNERS): Part {
  const cosigners = mnemonics.map((m) => {
    const root = seed(m);
    return { root, account: root.derive("m/48'/0'/0'/2'") };
  });
  const parts = cosigners.map((c) =>
    `[${fp(c.root)}/48h/0h/0h/2h]${c.account.publicExtendedKey}/<0;1>/*`
  );
  return {
    descriptor: wrap(`sortedmulti(2,${parts.join(",")})`),
    keys: new Map([...keyMap(cosigners[0].account), ...keyMap(cosigners[2].account)]),
    belowThreshold: keyMap(cosigners[1].account),
  };
}

const makeWallet = (name: string, parts: Part[], batch?: string): WalletSpec => ({
  name,
  descriptors: parts.map((p) => p.descriptor),
  keys: new Map(parts.flatMap((p) => [...p.keys])),
  belowThreshold: parts.some((p) => p.belowThreshold)
    // Every single-sig input is fully signed; only the multisig inputs are short of a signature.
    ? new Map(parts.flatMap((p) => [...(p.belowThreshold ?? p.keys)]))
    : undefined,
  batch,
});

const PART = {
  pkh: (m?: string) => singleSigPart(44, (k) => `pkh(${k})`, m),
  wpkh: (m?: string) => singleSigPart(84, (k) => `wpkh(${k})`, m),
  shWpkh: (m?: string) => singleSigPart(49, (k) => `sh(wpkh(${k}))`, m),
  tr: (m?: string) => singleSigPart(86, (k) => `tr(${k})`, m),
  sh: (m?: string[]) => multiSigPart((k) => `sh(${k})`, m),
  wsh: (m?: string[]) => multiSigPart((k) => `wsh(${k})`, m),
  shWsh: (m?: string[]) => multiSigPart((k) => `sh(wsh(${k}))`, m),
};

// Mixed wallet: every script type, each from its own seeds, so a single transaction per fork
// spends inputs of all seven kinds at once.
const MIXED_COSIGNERS = (n: number) => [words(n), words(n + 1), words(n + 2)];
const MIXED = makeWallet("mixed-batch-all", [
  PART.pkh(words(20)),
  PART.wpkh(words(21)),
  PART.shWpkh(words(22)),
  PART.tr(words(23)),
  PART.sh(MIXED_COSIGNERS(30)),
  PART.wsh(MIXED_COSIGNERS(40)),
  PART.shWsh(MIXED_COSIGNERS(50)),
], "all");

// Wallets for the RBF and reorg scenarios: funded with the others, but not part of the loop below.
const RBF_WALLET = makeWallet("rbf", [PART.wpkh(words(60))]);
const REORG_WALLET = makeWallet("reorg", [PART.wpkh(words(61))]);

// Donor route: shared coins to split, and a separate donor wallet (its keys sign the donor inputs).
const DONOR_SOURCE = makeWallet("donor-source", [PART.wpkh(words(62))]);
const DONOR_WALLET = makeWallet("donor-wallet", [PART.wpkh(words(70))]);
const BTC_SOURCE = makeWallet("btc-first-source", [PART.wpkh(words(63))]);
const BTC_DONOR_WALLET = makeWallet("btc-donor-wallet", [PART.wpkh(words(71))]);

const WALLETS: WalletSpec[] = [
  makeWallet("pkh", [PART.pkh()]),
  makeWallet("wpkh", [PART.wpkh()]),
  makeWallet("sh-wpkh", [PART.shWpkh()]),
  makeWallet("tr-keypath", [PART.tr()]),
  makeWallet("sh-sortedmulti-2of3", [PART.sh()]),
  makeWallet("wsh-sortedmulti-2of3", [PART.wsh()]),
  makeWallet("sh-wsh-sortedmulti-2of3", [PART.shWsh()]),
  MIXED,
];

async function startNodes(project: string): Promise<Record<ChainId, Rpc>> {
  await docker(project, ["build"]); // layers are cached after the first run
  await docker(project, ["up", "-d", "--no-build"]);
  const nodes = {} as Record<ChainId, Rpc>;
  for (const chain of CHAINS) {
    nodes[chain] = new Rpc(await publishedPort(project, chain));
    await waitReady(nodes[chain], chain);
  }
  return nodes;
}

/** Regtest address for a script, from the node's own decoder (the app uses mainnet encodings). */
async function regtestAddress(node: Rpc, scriptPubKey: string): Promise<string> {
  return (await node.call<{ address: string }>("decodescript", scriptPubKey)).address;
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

      // Coins: two outputs per test wallet, created in the shared prefix (heights < 110).
      await nodes.btc.mine(101, await minerAddr("btc"));
      // One funding transaction for every coin: a chain of single sends would trip the node's
      // ancestor limit, and the prefix has to stay below the fork height.
      const outputs: Record<string, number> = {};
      for (const spec of [...WALLETS, RBF_WALLET, REORG_WALLET, DONOR_SOURCE, BTC_SOURCE]) {
        for (const descriptor of spec.descriptors) {
          const source = parseDescriptor(descriptor);
          for (let i = 0; i < COIN_VALUES.length; i++) {
            const addr = await regtestAddress(
              nodes.btc,
              source.branches[0].derive(i).scriptPubKey,
            );
            outputs[addr] = COIN_VALUES[i];
          }
        }
      }
      // A decoy: a donor-wallet address (index 5) that already holds a SHARED coin.
      outputs[
        await regtestAddress(
          nodes.btc,
          parseDescriptor(DONOR_WALLET.descriptors[0]).branches[0].derive(5).scriptPubKey,
        )
      ] = 0.3;
      await wallet("btc").call("sendmany", "", outputs);
      await nodes.btc.mine(XBT_ACTIVATION_HEIGHT - 1 - 101, await minerAddr("btc"));
      await copyBlocks(nodes.btc, [nodes.xbt, nodes.ecx], 0, XBT_ACTIVATION_HEIGHT - 1);

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

      for (const spec of WALLETS) {
        await t.step({
          name: `wallet: ${spec.name}`,
          sanitizeOps: false,
          sanitizeResources: false,
          fn: async (t) => {
            const keys = spec.keys;
            const sources = spec.descriptors.map((d) => parseDescriptor(d));
            const coinCount = spec.descriptors.length * COIN_VALUES.length;
            const batchAll = spec.batch === "all";
            // forksplit, driven through its real CLI with real node RPC as the only backends.
            const { dir, io, run, text, stdout } = await makeCli(nodes);

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

            await t.step("import + scan: every coin is shared on all three chains", async () => {
              for (const descriptor of spec.descriptors) {
                assertEquals(await run("import", descriptor, "--label", "it"), 0, text());
              }
              assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
              assertEquals(await run("status", "--json"), 0, text());
              const status = JSON.parse(stdout());
              const coins = status.coins as {
                classification: { status: string; unspentOn: string[] };
              }[];
              assertEquals(coins.length, coinCount, text());
              for (const coin of coins) {
                assertEquals(coin.classification.status, "shared", JSON.stringify(coin));
              }
            });

            let planDir = "";
            let planId = "";
            let plan: {
              transactions: { chain: string; file: string; inputs: { kind: string }[] }[];
            };
            await t.step(
              "plan: one PSBT per coin per fork (one per fork with --batch all)",
              async () => {
                assertEquals(await run("dest", "set", "ecx", ECX_DEST), 0, text());
                assertEquals(await run("dest", "set", "xbt", XBT_DEST), 0, text());
                assertEquals(
                  await run(
                    "plan",
                    "--xbt-signer",
                    "knots",
                    "--fee-rate",
                    "ecx=2,xbt=3",
                    ...(spec.batch ? ["--batch", spec.batch] : []),
                    "--yes",
                  ),
                  0,
                  text(),
                );
                for await (const e of Deno.readDir(join(dir, "plans"))) planId = e.name;
                planDir = join(dir, "plans", planId);
                plan = JSON.parse(await Deno.readTextFile(join(planDir, "plan.json")));
                for (const chain of ["ecx", "xbt"]) {
                  const txs = plan.transactions.filter((x) => x.chain === chain);
                  assertEquals(txs.length, batchAll ? 1 : coinCount, `${chain} transactions`);
                  if (batchAll) {
                    assertEquals(txs[0].inputs.length, coinCount);
                    // The point of the batch: one transaction spending every script type at once.
                    assertEquals(
                      new Set(txs[0].inputs.map((i) => i.kind)).size,
                      spec.descriptors.length,
                      `${chain} input kinds: ${txs[0].inputs.map((i) => i.kind)}`,
                    );
                  }
                }
              },
            );

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
              // A legacy/segwit signer falls back to ALL (0x01); a Taproot signer to DEFAULT (0x00).
              assert(/signature hash type 0x0[01], not 0x21/u.test(text()), text());
            });

            if (spec.belowThreshold) {
              await t.step(
                "verify refuses a multisig input that is below its threshold",
                async () => {
                  await signAll((b64) => unifiedSign(b64, spec.belowThreshold!));
                  assertEquals(await run("verify", planId), 1, text());
                },
              );
            }

            await t.step("verify accepts the real signatures; the real nodes agree", async () => {
              await signAll((b64) => unifiedSign(b64, keys));
              assertEquals(await run("verify", planId), 0, text());
            });

            await t.step("broadcast, confirm, track", async () => {
              assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
              for (const c of CHAINS) await nodes[c].mine(2, await minerAddr(c));
              assertEquals(await run("track", planId), 0, text());
            });

            await t.step(
              "replaying a confirmed fork split onto another chain is rejected",
              async () => {
                const progress = JSON.parse(
                  await Deno.readTextFile(join(planDir, "progress.json")),
                );
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
                      const [r] = await nodes[other].call<{ allowed: boolean }[]>(
                        "testmempoolaccept",
                        [
                          hex,
                        ],
                      );
                      assertEquals(r.allowed, false, `${chain} split was accepted by ${other}`);
                    }
                  }
                }
              },
            );

            await t.step(
              "rescan: coins are separated and the BTC copies are untouched",
              async () => {
                assertEquals(await run("scan", "--rpc-range", "20"), 0, text());
                assertEquals(await run("status", "--json"), 0, text());
                const status = JSON.parse(stdout());
                const coins = status.coins as {
                  classification: { status: string; unspentOn: string[] };
                }[];
                for (const coin of coins) {
                  assert(
                    coin.classification.unspentOn.join() === "btc" &&
                      ["separated", "pending"].includes(coin.classification.status),
                    JSON.stringify(coin),
                  );
                }
                const addrs: string[] = [];
                for (const source of sources) {
                  for (let i = 0; i < COIN_VALUES.length; i++) {
                    addrs.push(
                      `addr(${await regtestAddress(
                        nodes.btc,
                        source.branches[0].derive(i).scriptPubKey,
                      )})`,
                    );
                  }
                }
                const btcUtxos = await nodes.btc.call<{ unspents: unknown[] }>(
                  "scantxoutset",
                  "start",
                  addrs,
                );
                assertEquals(btcUtxos.unspents.length, coinCount);
              },
            );
          },
        });
      }

      const harness = {
        nodes,
        minerAddr,
        ecxDest: ECX_DEST,
        xbtDest: XBT_DEST,
        btcDest: BTC_DEST,
      };
      await t.step({
        name: "fee bump (RBF) replaces a stuck split",
        sanitizeOps: false,
        sanitizeResources: false,
        fn: (t) => rbfScenario(t, harness, RBF_WALLET),
      });
      await t.step({
        name: "reorg handling: moved, unconfirmed and conflicting splits are reported",
        sanitizeOps: false,
        sanitizeResources: false,
        fn: (t) => reorgScenario(t, harness, REORG_WALLET),
      });
      await t.step({
        name: "advanced XBT donor route: stock signatures, protected by an XBT-only donor",
        sanitizeOps: false,
        sanitizeResources: false,
        fn: (t) => donorScenario(t, harness, DONOR_SOURCE, DONOR_WALLET),
      });
      await t.step({
        name: "advanced BTC-first route: BTC donor, then ECX, then a plain XBT split",
        sanitizeOps: false,
        sanitizeResources: false,
        fn: (t) => btcFirstScenario(t, harness, BTC_SOURCE, BTC_DONOR_WALLET),
      });
    } finally {
      await docker(project, ["down", "-v", "--remove-orphans"]).catch(() => {});
    }
  },
});
