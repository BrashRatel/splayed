/**
 * End-to-end harness: a data dir with a wallet, scanned coins and a written plan, on fake chains
 * served by any of the backend kinds (Esplora, Electrum, node RPC with and without txindex).
 */
import { assertEquals } from "./assert.ts";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer";
import { type CliIO, main } from "../src/cli/main.ts";
import { concatBytes, fromHex, toHex } from "../src/core/bytes.ts";
import { parseDescriptor } from "../src/core/descriptors.ts";
import { type ChainId, MAINNET } from "../src/core/profiles.ts";
import {
  decodePsbt,
  encodePsbtBase64,
  findValues,
  IN_BIP32_DERIVATION,
  IN_WITNESS_UTXO,
  kv,
} from "../src/core/psbt.ts";
import { parseTx, type Tx } from "../src/core/tx.ts";
import { unifiedSignatureHash } from "../src/core/unified_sighash.ts";
import type { HttpResponse, RequestSpec, Route, Transport } from "../src/net/transport.ts";
import {
  type FakeChain,
  fakeChain,
  FakeElectrumConn,
  FakeEsploraTransport,
  FakeNodeRpcTransport,
  fund,
} from "./fakes.ts";

const seed = (w: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(w));
const SOURCE = seed(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const OTHER = seed("legal winner thank year wave sausage worth useful legal winner thank yellow");
const fp = (k: HDKey) => k.fingerprint.toString(16).padStart(8, "0");
const SRC_DESC = `wpkh([${fp(SOURCE)}/84h/0h/0h]${
  SOURCE.derive("m/84'/0'/0'").publicExtendedKey
}/<0;1>/*)`;
const ECX_DEST = `wpkh([${fp(OTHER)}/84h/0h/0h]${
  OTHER.derive("m/84'/0'/0'").publicExtendedKey
}/0/*)`;
const XBT_DEST = `wpkh([${fp(OTHER)}/84h/0h/1h]${
  OTHER.derive("m/84'/0'/1'").publicExtendedKey
}/0/*)`;
const src = parseDescriptor(SRC_DESC);
const privFor = new Map<string, Uint8Array>(
  [0, 1, 2].map((i) => {
    const k = SOURCE.derive(`m/84'/0'/0'/0/${i}`);
    return [toHex(k.publicKey!), k.privateKey!];
  }),
);

/** An ordinary wallet: signs every input it has a key for with SIGHASH_ALL. */
export function stockSign(b64: string): string {
  const tx = Transaction.fromPSBT(Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0)));
  for (let i = 0; i < tx.inputsLength; i++) {
    for (const [pub, priv] of privFor) {
      if (tx.getInput(i).bip32Derivation?.some(([p]) => toHex(p) === pub)) tx.signIdx(priv, i);
    }
  }
  return btoa(String.fromCharCode(...tx.toPSBT()));
}

/** A SIGHASH_UNIFIED signer (what the Knots wallet does) for P2WPKH inputs. */
export function unifiedSign(b64: string, hashType = 0x21): string {
  const psbt = decodePsbt(b64);
  const spent = psbt.inputs.map((m) => {
    const v = findValues(m, IN_WITNESS_UTXO)[0].value;
    return {
      amount: new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true),
      script: v.slice(9),
    };
  });
  const utx = {
    version: psbt.tx.version,
    lockTime: psbt.tx.lockTime,
    inputs: psbt.tx.inputs.map((i) => ({
      txid: fromHex(i.txid),
      index: i.vout,
      sequence: i.sequence,
    })),
    outputs: psbt.tx.outputs.map((o) => ({ amount: o.value, script: o.script })),
  };
  psbt.inputs.forEach((m, i) => {
    const pub = findValues(m, IN_BIP32_DERIVATION)[0].key.slice(1);
    const code = concatBytes(
      Uint8Array.of(0x76, 0xa9, 0x14),
      spent[i].script.slice(2),
      Uint8Array.of(0x88, 0xac),
    );
    const digest = unifiedSignatureHash(utx, i, hashType, spent, {
      scriptType: 1,
      scriptCode: code,
    })!;
    const der = secp256k1.sign(digest, privFor.get(toHex(pub))!, {
      prehash: false,
      format: "der",
      lowS: true,
    });
    m.push(kv(0x02, pub, concatBytes(der, Uint8Array.of(hashType))));
  });
  return encodePsbtBase64(psbt);
}

/** Consensus stand-ins for each fake chain's mempool. */
export function sigHashTypes(tx: Tx): number[] {
  return tx.inputs.flatMap((
    i,
  ) => (i.witness.length ? [i.witness[0][i.witness[0].length - 1]] : []));
}
export const RULES: Record<ChainId, (tx: Tx) => string | undefined> = {
  btc: (tx) =>
    tx.lockTime === 499_999_998
      ? "non-final"
      : sigHashTypes(tx).includes(0x21)
      ? "mandatory-script-verify-flag-failed"
      : undefined,
  ecx: (
    tx,
  ) => (sigHashTypes(tx).includes(0x21) ? "mandatory-script-verify-flag-failed" : undefined),
  xbt: (tx) => (tx.lockTime === 499_999_998 ? "non-final" : undefined),
};

/** A fake node RPC (identity + testmempoolaccept only). `accept` decides the answer. */
class FakeRpcTransport implements Transport {
  readonly route: Route = { via: "direct", hostClass: "loopback", reason: "fake" };
  calls: string[] = [];
  constructor(
    readonly chain: ChainId,
    readonly tip: number,
    readonly accept: (tx: Tx) => string | undefined,
  ) {}
  request(spec: RequestSpec): Promise<HttpResponse> {
    const { id, method, params } = JSON.parse(spec.body as string);
    this.calls.push(method);
    let result: unknown;
    if (method === "getblockcount") result = this.tip;
    else if (method === "getblockhash") {
      result = MAINNET.chains[this.chain].checkpoints.find((c) => c.height === params[0])?.hash ??
        "00".repeat(32);
    } else if (method === "getdeploymentinfo") {
      result = { deployments: {}, blake2b: { height: 110, active: true } };
    } else if (method === "testmempoolaccept") {
      const reason = this.accept(parseTx(params[0][0]));
      result = [{ allowed: !reason, "reject-reason": reason }];
    } else throw new Error(`fake rpc: ${method}`);
    const body = JSON.stringify({ id, result, error: null });
    return Promise.resolve({
      status: 200,
      headers: new Map(),
      body: new TextEncoder().encode(body),
      text: () => body,
      json: <T>() => JSON.parse(body) as T,
    });
  }
}

/**
 * The kinds of backend the end-to-end tests run against. Each sees the same fake chains but can
 * tell different things: Esplora and Electrum name the transaction that spent an output; node RPC
 * never does, and without txindex can't see a confirmed transaction at all.
 */
export type BackendKind = "esplora" | "electrum" | "rpc" | "rpc-txindex";
export const BACKEND_KINDS: BackendKind[] = ["esplora", "electrum", "rpc", "rpc-txindex"];
const PORTS: Record<ChainId, number> = { btc: 1, xbt: 2, ecx: 3 };

/** splayed.toml lines for one chain's backends of a kind. */
function backendLines(kind: BackendKind, c: ChainId, dir: string): string[] {
  switch (kind) {
    case "esplora":
      return [
        `[[chains.${c}.backends]]`,
        `kind = "esplora"`,
        `url = "http://192.168.1.10:300${PORTS[c]}/api"`,
        "",
      ];
    case "electrum":
      return [
        `[[chains.${c}.backends]]`,
        `kind = "electrum"`,
        `url = "tcp://192.168.1.10:5000${PORTS[c]}"`,
        "",
      ];
    default:
      return [
        `[[chains.${c}.backends]]`,
        `kind = "rpc"`,
        `url = "http://192.168.1.10:8${PORTS[c]}32"`,
        `cookie_file = "${dir}/.cookie"`,
        "",
      ];
  }
}

export async function setup(
  opts: { nodes?: boolean; brokenBtcNode?: boolean; backend?: BackendKind } = {},
) {
  const btc = fakeChain("btc", 975_000);
  const xbt = fakeChain("xbt", 970_000);
  const ecx = fakeChain("ecx", 974_500);
  btc.accept = RULES.btc;
  ecx.accept = RULES.ecx;
  xbt.accept = RULES.xbt;
  const all = [btc, xbt, ecx];
  const at = (i: number) => src.branches[0].derive(i);
  const a = fund(all, [{ ...at(0), value: 100_000 }], 900_000, 1);
  const b = fund(all, [{ ...at(1), value: 250_000 }], 900_100, 2);
  const chains: Record<ChainId, FakeChain> = { btc, xbt, ecx };
  const contacted: string[] = [];
  const rpc: Record<string, FakeRpcTransport> = {};
  /** What reads and broadcasts go to (all chains); Esplora until `useBackend`. */
  let kind: BackendKind = "esplora";
  const dir = await Deno.makeTempDir({ prefix: "splayed-exec-" });
  // Every chain uses the user's own backends: a "self-hosted" Esplora, plus node RPC if asked.
  const configText = (k: BackendKind) => {
    const lines = ["[scan]", "jitter_min_ms = 0", "jitter_max_ms = 0", ""];
    for (const c of ["btc", "xbt", "ecx"] as ChainId[]) {
      lines.push(...backendLines(k, c, dir));
      if (opts.nodes && k === "esplora") {
        lines.push(
          `[[chains.${c}.backends]]`,
          `kind = "rpc"`,
          `url = "http://127.0.0.1:8${c === "btc" ? 332 : c === "xbt" ? 432 : 532}"`,
          `cookie_file = "${dir}/.cookie"`,
          `role = "read"`,
          "priority = 5",
          "",
        );
      }
    }
    return lines.join("\n");
  };
  await Deno.writeTextFile(join(dir, "splayed.toml"), configText("esplora"));
  await Deno.writeTextFile(join(dir, ".cookie"), "__cookie__:x");
  const out: string[] = [];
  const err: string[] = [];
  /** What every question is answered, and the questions asked. */
  const answer = { yes: true };
  const questions: string[] = [];
  const io: CliIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: (q) => {
      questions.push(q);
      return answer.yes;
    },
    env: {},
    tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
    transportFactory: (_config, chain, backend) => {
      contacted.push(backend.url);
      if (backend.kind === "rpc" && kind !== "esplora") {
        return new FakeNodeRpcTransport(chains[chain], {
          txindex: kind === "rpc-txindex",
          accept: RULES[chain],
        });
      }
      if (backend.kind === "rpc") {
        const rule = chain === "btc" && opts.brokenBtcNode ? () => undefined : RULES[chain];
        return (rpc[chain] = new FakeRpcTransport(chain, chains[chain].tip, rule));
      }
      return new FakeEsploraTransport(chains[chain]);
    },
    streamFactory: (_config, chain, backend) => () => {
      contacted.push(backend.url);
      return Promise.resolve(new FakeElectrumConn(chains[chain]) as unknown as Deno.Conn);
    },
  };
  const run = (...args: string[]) => main(["--data-dir", dir, ...args], io);
  assertEquals(await run("init", "--yes"), 0, err.join("\n"));
  assertEquals(await run("import", SRC_DESC), 0);
  assertEquals(await run("scan"), 0, err.join("\n"));
  assertEquals(await run("dest", "set", "ecx", ECX_DEST), 0);
  assertEquals(await run("dest", "set", "xbt", XBT_DEST), 0);
  assertEquals(
    await run("plan", "--xbt-signer", "knots", "--fee-rate", "ecx=2,xbt=3", "--yes"),
    0,
    err.join("\n"),
  );
  const plansDir = join(dir, "plans");
  let id = "";
  for await (const e of Deno.readDir(plansDir)) id = e.name;
  const planDir = join(plansDir, id);
  const plan = JSON.parse(await Deno.readTextFile(join(planDir, "plan.json")));
  /**
   * Points every chain at backends of another kind and confirms them, as a user who switches (or
   * whose first backend fails over to the next) would. Plans and progress stay as they are.
   */
  const useBackend = async (k: BackendKind) => {
    kind = k;
    await Deno.writeTextFile(join(dir, "splayed.toml"), configText(k));
    assertEquals(await run("init", "--yes"), 0, err.join("\n"));
  };
  if (opts.backend && opts.backend !== "esplora") await useBackend(opts.backend);
  return {
    useBackend,
    chains,
    dir,
    run,
    out,
    err,
    plan,
    planDir,
    id,
    contacted,
    rpc,
    coins: { a, b },
    answer,
    questions,
  };
}

export async function signAll(
  planDir: string,
  plan: { transactions: { chain: string; file: string }[] },
  xbtSigner = unifiedSign,
) {
  for (const t of plan.transactions) {
    const b64 = await Deno.readTextFile(join(planDir, t.file));
    const signed = t.chain === "ecx" ? stockSign(b64) : xbtSigner(b64);
    await Deno.writeTextFile(join(planDir, t.file.replace(/\.psbt$/u, ".signed.psbt")), signed);
  }
}

/** Mines every unconfirmed transaction of the fake chain into a new block. */
export function mine(c: FakeChain) {
  c.tip++;
  for (const [k, v] of c.spends) {
    if (v.height === undefined) {
      c.spends.set(k, { ...v, height: c.tip });
      const tx = c.txs.get(v.txid);
      if (tx) tx.height = c.tip;
    }
  }
}
/** A reorg that puts the transaction back in the mempool. */
export function unmine(c: FakeChain, id: string) {
  c.txs.get(id)!.height = undefined;
  for (const [k, v] of c.spends) if (v.txid === id) c.spends.set(k, { txid: id });
}
/** A reorg after which the transaction is nowhere: its input is unspent again. */
export function drop(c: FakeChain, id: string) {
  c.txs.delete(id);
  for (const [k, v] of c.spends) if (v.txid === id) c.spends.delete(k);
}
export type Prog = {
  txs: Record<string, {
    verified?: { txid: string };
    broadcast?: { status: string; detail?: string };
    confirmations?: { depth: number; state?: string; previous?: { depth: number } };
    reorgs?: { kind: string; resolved?: string }[];
    replacedBy?: { plan: string };
  }>;
};
export const progressOf = async (dir: string): Promise<Prog> =>
  JSON.parse(await Deno.readTextFile(join(dir, "progress.json")));

export type Tx1 = { chain: string; order: number; file: string; testFirst?: boolean };
export const ecxTx = (s: { plan: { transactions: Tx1[] } }, order: number) =>
  s.plan.transactions.find((t) => t.chain === "ecx" && t.order === order)!;

/** Moves a send's time back, past the grace `track` gives a split no mempool shows yet. */
export async function backdateSends(planDir: string, minutes = 60) {
  const p = JSON.parse(await Deno.readTextFile(join(planDir, "progress.json")));
  for (const e of Object.values(p.txs) as { broadcast?: { at: string } }[]) {
    if (e.broadcast) {
      e.broadcast.at = new Date(Date.parse(e.broadcast.at) - minutes * 60_000).toISOString();
    }
  }
  await Deno.writeTextFile(join(planDir, "progress.json"), JSON.stringify(p));
}

/** Bumps ECX #1 of `planId`, signs, verifies and sends it (evicting `evict`, as RBF would). */
export async function bumpAndSend(
  s: Awaited<ReturnType<typeof setup>>,
  planId: string,
  rate: number,
  evict: string,
) {
  assertEquals(
    await s.run(
      "bump",
      planId,
      "--chains",
      "ecx",
      "--tx",
      "1",
      "--fee-rate",
      `ecx=${rate}`,
      "--yes",
    ),
    0,
    s.out.join("\n") + s.err.join("\n"),
  );
  const bumpId = `${planId}-bump1`;
  const bumpDir = join(s.dir, "plans", bumpId);
  await signAll(bumpDir, JSON.parse(await Deno.readTextFile(join(bumpDir, "plan.json"))));
  assertEquals(await s.run("verify", bumpId), 0, s.err.join("\n"));
  drop(s.chains.ecx, evict);
  assertEquals(await s.run("broadcast", bumpId, "--yes"), 0, s.err.join("\n"));
  return { bumpId, bumpDir, txid: s.chains.ecx.broadcasts!.at(-1)!.txid };
}

export async function sentTestFirst() {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const test = s.plan.transactions.find((t: Tx1) => t.chain === "ecx" && t.testFirst);
  return { s, test, old: s.chains.ecx.broadcasts![0].txid };
}
