import { assert, assertEquals } from "./assert.ts";
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
  encodePsbt,
  encodePsbtBase64,
  findValues,
  IN_BIP32_DERIVATION,
  IN_WITNESS_UTXO,
  kv,
} from "../src/core/psbt.ts";
import { parseTx, type Tx } from "../src/core/tx.ts";
import { unifiedSignatureHash } from "../src/core/unified_sighash.ts";
import type { HttpResponse, RequestSpec, Route, Transport } from "../src/net/transport.ts";
import { type FakeChain, fakeChain, FakeEsploraTransport, fund } from "./fakes.ts";

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
function stockSign(b64: string): string {
  const tx = Transaction.fromPSBT(Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0)));
  for (let i = 0; i < tx.inputsLength; i++) {
    for (const [pub, priv] of privFor) {
      if (tx.getInput(i).bip32Derivation?.some(([p]) => toHex(p) === pub)) tx.signIdx(priv, i);
    }
  }
  return btoa(String.fromCharCode(...tx.toPSBT()));
}

/** A SIGHASH_UNIFIED signer (what the Knots wallet does) for P2WPKH inputs. */
function unifiedSign(b64: string, hashType = 0x21): string {
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
function sigHashTypes(tx: Tx): number[] {
  return tx.inputs.flatMap((
    i,
  ) => (i.witness.length ? [i.witness[0][i.witness[0].length - 1]] : []));
}
const RULES: Record<ChainId, (tx: Tx) => string | undefined> = {
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

async function setup(opts: { nodes?: boolean; brokenBtcNode?: boolean } = {}) {
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
  const dir = await Deno.makeTempDir({ prefix: "forksplit-exec-" });
  // Every chain uses the user's own backends: a "self-hosted" Esplora, plus node RPC if asked.
  const lines = ["[scan]", "jitter_min_ms = 0", "jitter_max_ms = 0", ""];
  for (const c of ["btc", "xbt", "ecx"] as ChainId[]) {
    lines.push(
      `[[chains.${c}.backends]]`,
      `kind = "esplora"`,
      `url = "http://192.168.1.10:${({ btc: 3001, xbt: 3002, ecx: 3003 })[c]}/api"`,
      "",
    );
    if (opts.nodes) {
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
  await Deno.writeTextFile(join(dir, "forksplit.toml"), lines.join("\n"));
  await Deno.writeTextFile(join(dir, ".cookie"), "__cookie__:x");
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: () => true,
    env: {},
    tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
    transportFactory: (_config, chain, backend) => {
      contacted.push(backend.url);
      if (backend.kind === "rpc") {
        const rule = chain === "btc" && opts.brokenBtcNode ? () => undefined : RULES[chain];
        return (rpc[chain] = new FakeRpcTransport(chain, chains[chain].tip, rule));
      }
      return new FakeEsploraTransport(chains[chain]);
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
  return { chains, dir, run, out, err, plan, planDir, id, contacted, rpc, coins: { a, b } };
}

async function signAll(
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

Deno.test("profile defaults are never contacted when the user configured their own backends", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0);
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, s.err.join("\n"));
  assertEquals(await s.run("track", s.id), 0);
  const defaults = new Set(
    Object.values(MAINNET.chains).flatMap((c) => c.defaultBackends.map((d) => d.url)),
  );
  assert(s.contacted.length > 0);
  for (const url of s.contacted) assert(!defaults.has(url), `default backend contacted: ${url}`);
});

Deno.test("verify -> broadcast (test first) -> track -> broadcast the rest", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assert(s.out.join("\n").includes("SIGHASH_ALL|UNIFIED (0x21)"));
  // First broadcast sends only the TEST FIRST transaction on each chain.
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals(s.chains.ecx.broadcasts?.length, 1);
  assertEquals(s.chains.xbt.broadcasts?.length, 1);
  assertEquals(s.chains.btc.broadcasts, undefined); // nothing ever goes to BTC
  // Each broadcast used its own circuit.
  assert(s.chains.ecx.broadcasts![0].isolation.startsWith("broadcast:"));
  assert(s.chains.ecx.broadcasts![0].isolation !== s.chains.xbt.broadcasts![0].isolation);
  // The ECX bytes on the wire carry the marker; the XBT ones carry 0x21.
  assertEquals(parseTx(s.chains.ecx.broadcasts![0].hex).lockTime, 499_999_998);
  assertEquals(sigHashTypes(parseTx(s.chains.xbt.broadcasts![0].hex)), [0x21]);
  // Unconfirmed: a second run waits.
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0);
  assert(s.out.join("\n").includes("waiting for the TEST FIRST transaction"));
  assertEquals(s.chains.ecx.broadcasts!.length, 1);
  // Mine the test transactions, then the rest goes out.
  for (const c of [s.chains.ecx, s.chains.xbt]) {
    for (const [k, v] of c.spends) {
      if (v.height === undefined) {
        c.spends.set(k, { ...v, height: c.tip });
        c.txs.get(v.txid)!.height = c.tip; // the transaction itself is mined too
      }
    }
  }
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals(s.chains.ecx.broadcasts!.length, 2);
  assertEquals(s.chains.xbt.broadcasts!.length, 2);
  assertEquals(await s.run("track", s.id), 0);
  assert(s.out.join("\n").includes("1 of 50"));
  // Re-running is idempotent: nothing more is sent.
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0);
  assertEquals(s.chains.ecx.broadcasts!.length, 2);
  // A rescan now sees both coins' fork copies spent (pending depth), BTC copies untouched.
  assertEquals(await s.run("scan"), 0);
  const btcSpent = [...s.chains.btc.spends.keys()];
  assertEquals(btcSpent.length, 0);
});

Deno.test("verify rejects an XBT transaction signed with plain SIGHASH_ALL", async () => {
  const s = await setup();
  // The XBT signer "helpfully" ignores the 0x21 request and signs SIGHASH_ALL.
  await signAll(s.planDir, s.plan, (b64) => {
    const psbt = decodePsbt(b64);
    psbt.inputs = psbt.inputs.map((m) => m.filter((e) => e.key[0] !== 0x03)); // drop the 0x21 request
    return stockSign(encodePsbtBase64(psbt));
  });
  assertEquals(await s.run("verify", s.id), 1);
  assert(s.out.join("\n").includes("not 0x21"));
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0);
  assertEquals(s.chains.xbt.broadcasts, undefined); // unverified XBT txs are never sent
});

Deno.test("verify rejects a signer that changed the transaction", async () => {
  const s = await setup();
  const t = s.plan.transactions.find((x: { chain: string }) => x.chain === "ecx");
  const psbt = decodePsbt(await Deno.readTextFile(join(s.planDir, t.file)));
  psbt.tx.outputs[0].value -= 1000n; // e.g. a malicious signer bumping the fee
  await Deno.writeTextFile(
    join(s.planDir, t.file.replace(".psbt", ".signed.psbt")),
    btoa(String.fromCharCode(...encodePsbt(psbt))),
  );
  assertEquals(await s.run("verify", s.id), 0);
  assert(s.err.join("\n").includes("doesn't match any transaction"));
});

Deno.test("mempool checks on the user's own nodes: target accepts, others reject", async () => {
  const s = await setup({ nodes: true });
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  const text = s.out.join("\n");
  assert(text.includes("ECX node: accepted by your node"));
  assert(text.includes("BTC node: rejected (good): non-final"));
  assert(text.includes("BTC node: rejected (good): mandatory-script-verify-flag-failed"));
  assert(s.rpc.btc.calls.includes("testmempoolaccept"));
});

Deno.test("mempool checks: a BTC node accepting a fork transaction fails verification", async () => {
  const s = await setup({ nodes: true, brokenBtcNode: true });
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 1);
  assert(s.out.join("\n").includes("NOT replay-protected"));
});
