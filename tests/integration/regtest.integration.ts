/**
 * Regtest integration: real Bitcoin Core (BTC), Bitcoin Knots with BLAKE2b (XBT) and an eCash node
 * (ECX) in Docker. splayed's own CLI runs end to end against their JSON-RPC:
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
import { assert, assertEquals, assertThrows } from "../assert.ts";
import { type CliIO, main } from "../../src/cli/main.ts";
import { parseDescriptor } from "../../src/core/descriptors.ts";
import {
  decodePsbt,
  encodePsbtBase64,
  IN_NON_WITNESS_UTXO,
  IN_WITNESS_UTXO,
} from "../../src/core/psbt.ts";
import type { ChainId } from "../../src/core/profiles.ts";
import {
  makeRegtestProfile,
  REGTEST_PROFILE_ID,
  XBT_ACTIVATION_HEIGHT,
} from "./regtest_profile.ts";
import { makeCli } from "./cli_harness.ts";
import { CHAINS, copyBlocks, docker, publishedPort, waitReady } from "./cluster.ts";
import { RegtestRpcTransport, Rpc, xprvToTprv, xpubToTpub } from "./rpc.ts";
import {
  btcFirstScenario,
  bumpExtrasScenario,
  donorScenario,
  droppedScenario,
  foreignFundingScenario,
  nodeRpcScenario,
  rbfScenario,
  reorgScenario,
} from "./scenarios.ts";
import { rpcPathsScenario } from "./rpc_paths.ts";
import {
  type Device,
  DeviceRefusal,
  type DeviceRules,
  hardwareStyleSign,
  ignoresUnifiedSign,
  keyMap,
  nodeWalletSign,
  stockSign,
  unifiedSign,
} from "./signers.ts";

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

/** What a person holding a hardware signer would accept on its screen: the ECX destination. */
const HARDWARE_RULES: DeviceRules = {
  allowedOutputs: new Set(
    Array.from(
      { length: 20 },
      (_, i) => parseDescriptor(ECX_DEST).branches[0].derive(i).scriptPubKey,
    ),
  ),
  maxFeeFraction: 0.005,
};

/** Deterministic, valid mnemonics so each wallet group gets its own coins. */
const words = (n: number) => entropyToMnemonic(new Uint8Array(16).fill(n), english);
const DEFAULT_SINGLE = words(1);
const DEFAULT_COSIGNERS = [words(2), words(3), words(4)];
const cosignerSet = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => words(from + i));

const COIN_VALUES = [1, 0.5]; // BTC per coin; every descriptor gets one coin of each

/** A source wallet to split, with the keys test code signs it with. */
interface WalletSpec {
  name: string;
  /** Descriptors imported together; the wallet's coins are the union of theirs. */
  descriptors: string[];
  /** Enough keys to satisfy every descriptor. */
  keys: Map<string, Uint8Array>;
  /** The same keys as separate hardware signers, one per master key, for the hardware-style flow. */
  devices: Device[];
  /** Too few keys for at least one multisig input: verify must refuse the result. */
  belowThreshold?: Map<string, Uint8Array>;
  /** `plan --batch` value; "all" puts every coin of a fork in one transaction. */
  batch?: string;
}

interface Part {
  descriptor: string;
  keys: Map<string, Uint8Array>;
  devices: Device[];
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
    devices: [{
      fingerprint: fp(root),
      keys: keyMap(account),
      descriptor: wrap(
        `[${fp(root)}/${purpose}h/0h/0h]${xprvToTprv(account.privateExtendedKey!)}/<0;1>/*`,
      ),
    }],
  };
}

/** m-of-n sortedmulti with n independent cosigners (2-of-3 unless told otherwise). */
function multiSigPart(
  wrap: (inner: string) => string,
  mnemonics = DEFAULT_COSIGNERS,
  m = 2,
): Part {
  const cosigners = mnemonics.map((mnemonic) => {
    const root = seed(mnemonic);
    return { root, account: root.derive("m/48'/0'/0'/2'") };
  });
  const parts = cosigners.map((c) =>
    `[${fp(c.root)}/48h/0h/0h/2h]${c.account.publicExtendedKey}/<0;1>/*`
  );
  // The quorum that signs is the first m-1 cosigners and the last (a 2-of-3 uses the first and the
  // last); one signature short is m-1 cosigners starting from the second.
  const signing = [...cosigners.slice(0, m - 1), cosigners[cosigners.length - 1]];
  const short = cosigners.slice(1, m);
  return {
    descriptor: wrap(`sortedmulti(${m},${parts.join(",")})`),
    keys: new Map(signing.flatMap((c) => [...keyMap(c.account)])),
    devices: signing.map((own) => ({
      fingerprint: fp(own.root),
      keys: keyMap(own.account),
      // This cosigner's wallet: its own key private, the others public.
      descriptor: wrap(
        `sortedmulti(${m},${
          cosigners.map((c) =>
            `[${fp(c.root)}/48h/0h/0h/2h]${
              c === own
                ? xprvToTprv(c.account.privateExtendedKey!)
                : xpubToTpub(c.account.publicExtendedKey)
            }/<0;1>/*`
          ).join(",")
        })`,
      ),
    })),
    belowThreshold: new Map(short.flatMap((c) => [...keyMap(c.account)])),
  };
}

const makeWallet = (name: string, parts: Part[], batch?: string): WalletSpec => ({
  name,
  descriptors: parts.map((p) => p.descriptor),
  keys: new Map(parts.flatMap((p) => [...p.keys])),
  devices: parts.flatMap((p) => p.devices),
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
  sh: (cosigners?: string[], m?: number) => multiSigPart((k) => `sh(${k})`, cosigners, m),
  wsh: (cosigners?: string[], m?: number) => multiSigPart((k) => `wsh(${k})`, cosigners, m),
  shWsh: (cosigners?: string[], m?: number) => multiSigPart((k) => `sh(wsh(${k}))`, cosigners, m),
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
const FOREIGN_SOURCE = makeWallet("foreign-source", [PART.wpkh(words(64))]);
const FOREIGN_DONOR = makeWallet("foreign-donor", [PART.wpkh(words(72))]);
const DROP_WALLET = makeWallet("drop", [PART.wpkh(words(66))]);
const CPFP_WALLET = makeWallet("cpfp", [PART.wpkh(words(67))]);
const DROPPED_WALLET = makeWallet("dropped", [PART.wpkh(words(65))]);
const BTC_DONOR_WALLET = makeWallet("btc-donor-wallet", [PART.wpkh(words(71))]);
// Node RPC with and without txindex: a lost reply, the tool's own fee bump, a stranger's spend.
const rpcPathsWallets = (first: number, label: string) => ({
  lost: makeWallet(`rpc-${label}-lost`, [PART.wpkh(words(first))]),
  own: makeWallet(`rpc-${label}-own`, [PART.wpkh(words(first + 1))]),
  conflict: makeWallet(`rpc-${label}-conflict`, [PART.wpkh(words(first + 2))]),
});
const RPC_WITH_TXINDEX = rpcPathsWallets(100, "txindex");
const RPC_WITHOUT_TXINDEX = rpcPathsWallets(103, "no-txindex");

const WALLETS: WalletSpec[] = [
  makeWallet("pkh", [PART.pkh()]),
  makeWallet("wpkh", [PART.wpkh()]),
  makeWallet("sh-wpkh", [PART.shWpkh()]),
  makeWallet("tr-keypath", [PART.tr()]),
  makeWallet("sh-sortedmulti-2of3", [PART.sh()]),
  makeWallet("wsh-sortedmulti-2of3", [PART.wsh()]),
  makeWallet("sh-wsh-sortedmulti-2of3", [PART.shWsh()]),
  // Other quorum sizes: bigger scripts, more signatures, and a quorum that needs every cosigner.
  makeWallet("wsh-sortedmulti-3of5", [PART.wsh(cosignerSet(80, 5), 3)]),
  makeWallet("sh-wsh-sortedmulti-2of2", [PART.shWsh(cosignerSet(85, 2), 2)]),
  makeWallet("sh-sortedmulti-3of4", [PART.sh(cosignerSet(87, 4), 3)]),
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

/** Deletes every signed file of a plan: they sit beside the PSBTs, in the per-chain folders too. */
async function removeSignedFiles(planDir: string): Promise<void> {
  for (const sub of ["btc", "ecx", "xbt", "uploads", "."]) {
    try {
      for await (const e of Deno.readDir(join(planDir, sub))) {
        if (e.isFile && e.name.toLowerCase().includes("signed")) {
          await Deno.remove(join(planDir, sub, e.name));
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

Deno.test({
  name: "regtest: split a shared coin across real BTC, XBT and ECX nodes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const project = `splayed-it-${crypto.randomUUID().slice(0, 8)}`;
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
      for (
        const spec of [
          ...WALLETS,
          RBF_WALLET,
          REORG_WALLET,
          DONOR_SOURCE,
          BTC_SOURCE,
          FOREIGN_SOURCE,
          DROPPED_WALLET,
          DROP_WALLET,
          CPFP_WALLET,
          ...Object.values(RPC_WITH_TXINDEX),
          ...Object.values(RPC_WITHOUT_TXINDEX),
        ]
      ) {
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

      // SPLAYED_IT_WALLETS=name,name runs only those wallets, and SPLAYED_IT_WALLETS_ONLY=1 stops
      // after them (skipping the longer scenarios below): a quick loop while changing the wallets.
      const only = Deno.env.get("SPLAYED_IT_WALLETS")?.split(",").filter(Boolean);
      for (const spec of WALLETS.filter((w) => !only || only.includes(w.name))) {
        await t.step({
          name: `wallet: ${spec.name}`,
          sanitizeOps: false,
          sanitizeResources: false,
          fn: async (t) => {
            const keys = spec.keys;
            const sources = spec.descriptors.map((d) => parseDescriptor(d));
            const coinCount = spec.descriptors.length * COIN_VALUES.length;
            const batchAll = spec.batch === "all";
            // splayed, driven through its real CLI with real node RPC as the only backends.
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
              const other = await Deno.makeTempDir({ prefix: "splayed-it-wrong-" });
              await Deno.copyFile(join(dir, "splayed.toml"), join(other, "splayed.toml"));
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
              transactions: {
                chain: string;
                file: string;
                vsize: number;
                fee: number;
                inputs: { kind: string }[];
              }[];
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

            // verify exits 0 for a transaction it has no signed file for ("verified earlier" or "not
            // signed yet"), so also require that every transaction was verified by this run.
            const assertAllVerified = () =>
              assertEquals(
                (text().match(/VERIFIED/gu) ?? []).length,
                plan.transactions.length,
                text(),
              );

            // ECX by ordinary wallet software (all keys at once), or, given `ecxDevices`, by one
            // hardware-style device per master key, each signing the same unsigned PSBT on its own
            // and saving its own file (the documented multisig flow); XBT by a 0x21 signer.
            const signAll = async (
              xbtSigner: (b64: string) => string,
              ecxDevices?: Device[],
            ) => {
              for (const tx of plan.transactions) {
                const b64 = await Deno.readTextFile(join(planDir, tx.file));
                const base = join(planDir, tx.file.replace(/\.psbt$/u, ""));
                if (tx.chain === "ecx" && ecxDevices) {
                  await Deno.remove(`${base}.signed.psbt`).catch(() => {});
                  for (const [i, device] of ecxDevices.entries()) {
                    await Deno.writeTextFile(
                      `${base}.device${i + 1}.signed.psbt`,
                      hardwareStyleSign(b64, device, HARDWARE_RULES),
                    );
                  }
                  continue;
                }
                const signed = tx.chain === "ecx" ? stockSign(b64, keys) : xbtSigner(b64);
                await Deno.writeTextFile(`${base}.signed.psbt`, signed);
              }
            };

            await t.step("a hardware-style signer refuses what it cannot vouch for", async () => {
              const ecxTx = plan.transactions.find((x) => x.chain === "ecx")!;
              const b64 = await Deno.readTextFile(join(planDir, ecxTx.file));
              const device = spec.devices[0];
              // splayed's own PSBT satisfies it, so the refusals below are the checks working.
              hardwareStyleSign(b64, device, HARDWARE_RULES);
              const rules = (extra: Partial<DeviceRules>) => ({ ...HARDWARE_RULES, ...extra });
              assertThrows(
                () => hardwareStyleSign(b64, device, rules({ allowedOutputs: new Set() })),
                DeviceRefusal,
                "not a destination",
              );
              assertThrows(
                () => hardwareStyleSign(b64, device, rules({ maxFeeFraction: 0 })),
                DeviceRefusal,
                "fee",
              );
              assertThrows(
                () =>
                  hardwareStyleSign(b64, { ...device, fingerprint: "deadbeef" }, HARDWARE_RULES),
                DeviceRefusal,
                "no input names my fingerprint",
              );
              const stripped = decodePsbt(b64);
              stripped.inputs[0] = stripped.inputs[0].filter((e) =>
                e.key[0] !== IN_NON_WITNESS_UTXO && e.key[0] !== IN_WITNESS_UTXO
              );
              assertThrows(
                () => hardwareStyleSign(encodePsbtBase64(stripped), device, HARDWARE_RULES),
                DeviceRefusal,
                "previous transaction",
              );
            });

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
              // ECX is signed by hardware-style devices, each into a file of its own.
              await signAll((b64) => unifiedSign(b64, keys), spec.devices);
              assertEquals(await run("verify", planId), 0, text());
              assertAllVerified();
            });

            await t.step(
              "the nodes' own wallets sign it: Core and eCash for ECX, Knots for XBT",
              async () => {
                // Start from nothing signed or verified: only what the node wallets produce counts.
                await removeSignedFiles(planDir);
                await Deno.remove(join(planDir, "progress.json"));
                for (const tx of plan.transactions) {
                  const b64 = await Deno.readTextFile(join(planDir, tx.file));
                  const base = join(planDir, tx.file.replace(/\.psbt$/u, ""));
                  for (const [i, device] of spec.devices.entries()) {
                    // Each cosigner is a wallet of its own, holding only its key. ECX alternates between
                    // Bitcoin Core and the eCash node; XBT is Knots, which takes the 0x21 request from
                    // the PSBT itself, so the default sighash type is all it needs.
                    const node = tx.chain === "xbt"
                      ? nodes.xbt
                      : i % 2 === 0
                      ? nodes.btc
                      : nodes.ecx;
                    const { psbt } = await nodeWalletSign(node, device, b64, "DEFAULT");
                    await Deno.writeTextFile(`${base}.node${i + 1}.signed.psbt`, psbt);
                  }
                }
                assertEquals(await run("verify", planId), 0, text());
                assertAllVerified();
              },
            );

            await t.step("broadcast, confirm, track", async () => {
              assertEquals(await run("broadcast", planId, "--all", "--yes"), 0, text());
              for (const c of CHAINS) await nodes[c].mine(2, await minerAddr(c));
              assertEquals(await run("track", planId), 0, text());
            });

            await t.step("the planned size and fee match what the nodes mined", async () => {
              const progress = JSON.parse(await Deno.readTextFile(join(planDir, "progress.json")));
              const asked: Record<string, number> = { ecx: 2, xbt: 3 }; // --fee-rate above
              for (const tx of plan.transactions) {
                const id: string = progress.txs[tx.file].verified.txid;
                const mined = await nodes[tx.chain as ChainId].call<
                  { vsize: number; confirmations: number }
                >("getrawtransaction", id, true);
                assert(mined.confirmations > 0, `${tx.file} is not mined`);
                // Never below the real size (the fee would be short), and only a little above it.
                assert(
                  tx.vsize >= mined.vsize,
                  `${tx.file}: planned ${tx.vsize} vbytes, mined ${mined.vsize}`,
                );
                assert(
                  tx.vsize - mined.vsize <= mined.vsize * 0.03 + 8,
                  `${tx.file}: planned ${tx.vsize} vbytes is far above the mined ${mined.vsize}`,
                );
                // So the rate actually paid is at least the rate asked for.
                assert(
                  tx.fee / mined.vsize >= asked[tx.chain],
                  `${tx.file}: paid ${tx.fee / mined.vsize} sat/vB, asked ${asked[tx.chain]}`,
                );
              }
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

      if (Deno.env.get("SPLAYED_IT_WALLETS_ONLY")) return;
      // SPLAYED_IT_SCENARIOS=rpc-paths runs just that scenario after the wallets (set
      // SPLAYED_IT_WALLETS= to none as well); unset, everything runs.
      const scenarios = Deno.env.get("SPLAYED_IT_SCENARIOS")?.split(",").filter(Boolean);

      const harness = {
        nodes,
        minerAddr,
        ecxDest: ECX_DEST,
        xbtDest: XBT_DEST,
        btcDest: BTC_DEST,
        ecxDestKeys: keyMap(OTHER.derive("m/84'/0'/0'")),
        xbtDestKeys: keyMap(OTHER.derive("m/84'/0'/1'")),
      };
      if (!scenarios) {
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
        await t.step({
          name:
            "donors funded elsewhere: a 0x21-funded donor is proven, a plain-funded one is refused",
          sanitizeOps: false,
          sanitizeResources: false,
          fn: (t) => foreignFundingScenario(t, harness, FOREIGN_SOURCE, FOREIGN_DONOR),
        });
        await t.step({
          name: "real node RPC: reject reasons are classified the way mempoolChecks expects",
          sanitizeOps: false,
          sanitizeResources: false,
          fn: (t) => nodeRpcScenario(t, harness),
        });
        await t.step({
          name:
            "reorg: a split that left the chain and expired from the mempool is reported and re-sent",
          sanitizeOps: false,
          sanitizeResources: false,
          fn: (t) => droppedScenario(t, harness, DROPPED_WALLET),
        });
        await t.step({
          name: "fee bump extras: drop an input from a batch, CPFP a low-fee split",
          sanitizeOps: false,
          sanitizeResources: false,
          fn: (t) => bumpExtrasScenario(t, harness, DROP_WALLET, CPFP_WALLET),
        });
      }
      if (!scenarios || scenarios.includes("rpc-paths")) {
        for (
          const [txindex, wallets] of [[true, RPC_WITH_TXINDEX], [
            false,
            RPC_WITHOUT_TXINDEX,
          ]] as const
        ) {
          await t.step({
            name: `node RPC ${
              txindex ? "with" : "without"
            } txindex: lost replies, own spends, strangers`,
            sanitizeOps: false,
            sanitizeResources: false,
            fn: (t) => rpcPathsScenario(t, harness, wallets, txindex),
          });
        }
      }
    } finally {
      await docker(project, ["down", "-v", "--remove-orphans"]).catch(() => {});
    }
  },
});
