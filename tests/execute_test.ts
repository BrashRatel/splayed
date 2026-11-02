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
import { type FakeChain, fakeChain, FakeEsploraTransport, fund, spendReal } from "./fakes.ts";
import { protectedTxids } from "../src/core/donors.ts";

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
  const dir = await Deno.makeTempDir({ prefix: "splayed-exec-" });
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
  await Deno.writeTextFile(join(dir, "splayed.toml"), lines.join("\n"));
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
  return {
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
  // Unconfirmed: a second run says where each TEST FIRST transaction is and asks, once for both
  // chains; "no" sends nothing.
  s.answer.yes = false;
  s.questions.length = 0;
  assertEquals(await s.run("broadcast", s.id), 1);
  assertEquals(s.questions.length, 1);
  const q = s.questions[0];
  assert(q.includes("to prove the signer, the destination and the route work"), q);
  assert(
    /ECX: the TEST FIRST transaction \(ecx\/001-[0-9a-f]{8}\.psbt\) is in the mempool/.test(q),
    q,
  );
  assert(q.includes("XBT: the TEST FIRST transaction"), q);
  assert(q.includes("Send the other 1 ECX and 1 XBT transaction(s) now?"), q);
  assert(s.out.join("\n").includes("not sent: you chose to wait"), s.out.join("\n"));
  assertEquals(s.chains.ecx.broadcasts!.length, 1);
  assertEquals(s.chains.xbt.broadcasts!.length, 1);
  s.answer.yes = true;
  // Mine the test transactions, then the rest goes out.
  for (const c of [s.chains.ecx, s.chains.xbt]) {
    for (const [k, v] of c.spends) {
      if (v.height === undefined) {
        c.spends.set(k, { ...v, height: c.tip });
        c.txs.get(v.txid)!.height = c.tip; // the transaction itself is mined too
      }
    }
  }
  s.questions.length = 0;
  s.out.length = 0;
  assertEquals(await s.run("broadcast", s.id), 0, s.err.join("\n"));
  // Confirmed: the question reassures, and it is the only one asked.
  assertEquals(s.questions.length, 1);
  assert(s.questions[0].startsWith("The TEST FIRST spend went through:"), s.questions[0]);
  assert(s.questions[0].includes("is confirmed (1 deep)"), s.questions[0]);
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

// ---- reorgs, fee bumps and the TEST FIRST rule, end to end on the fake chains ----

/** Mines every unconfirmed transaction of the fake chain into a new block. */
function mine(c: FakeChain) {
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
function unmine(c: FakeChain, id: string) {
  c.txs.get(id)!.height = undefined;
  for (const [k, v] of c.spends) if (v.txid === id) c.spends.set(k, { txid: id });
}
/** A reorg after which the transaction is nowhere: its input is unspent again. */
function drop(c: FakeChain, id: string) {
  c.txs.delete(id);
  for (const [k, v] of c.spends) if (v.txid === id) c.spends.delete(k);
}
type Prog = {
  txs: Record<string, {
    verified?: { txid: string };
    broadcast?: { status: string; detail?: string };
    confirmations?: { depth: number; state?: string; previous?: { depth: number } };
    reorgs?: { kind: string; resolved?: string }[];
    replacedBy?: { plan: string };
  }>;
};
const progressOf = async (dir: string): Promise<Prog> =>
  JSON.parse(await Deno.readTextFile(join(dir, "progress.json")));

Deno.test("track after a reorg: depth goes to 0, broadcast sends the dropped split again, deep again resolves it", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, s.err.join("\n"));
  const ecx = s.chains.ecx;
  const [t1] = s.plan.transactions.filter((t: { chain: string }) => t.chain === "ecx");
  mine(ecx);
  mine(s.chains.xbt);
  ecx.tip += 59; // 60 deep: settled for any confirmation setting
  s.chains.xbt.tip += 59;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  const id1 = (await progressOf(s.planDir)).txs[t1.file].verified!.txid;
  assertEquals((await progressOf(s.planDir)).txs[t1.file].confirmations!.depth, 60);

  // Reorg 1: back in the mempool. The record says depth 0, not the old 60.
  unmine(ecx, id1);
  assertEquals(await s.run("track", s.id), 1);
  let p = (await progressOf(s.planDir)).txs[t1.file];
  assertEquals(p.confirmations!.depth, 0);
  assertEquals(p.confirmations!.state, "mempool");
  assertEquals(p.confirmations!.previous!.depth, 60);
  assert(s.err.join("\n").includes("REORG: This split was confirmed 60 deep in block"));
  // Still out of a block on the next track: still warned about, recorded once.
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 1);
  assert(s.err.join("\n").includes("back in the mempool"));
  assertEquals((await progressOf(s.planDir)).txs[t1.file].reorgs!.length, 1);

  // Reorg 2: gone altogether. Deleting the plan is refused (it was "60 deep" before the fix).
  drop(ecx, id1);
  assertEquals(await s.run("track", s.id), 1);
  p = (await progressOf(s.planDir)).txs[t1.file];
  assertEquals(p.broadcast!.status, "unknown");
  assertEquals(p.confirmations!.state, "absent");
  assertEquals(p.reorgs!.map((r) => r.kind), ["unconfirmed", "dropped"]);
  assertEquals(await s.run("plans", "delete", s.id, "--yes"), 1);
  assert(s.err.join("\n").includes("0 of"));

  // Broadcast verified sends it again (bytes re-verified, inputs re-checked).
  const before = ecx.broadcasts!.length;
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals(ecx.broadcasts!.length, before + 1);
  assertEquals(ecx.broadcasts!.at(-1)!.txid, id1);

  // Confirmed again but shallow: the alert stays open, and track says so (exit 1, like every
  // other open alert); deep again: resolved, and track is quiet.
  mine(ecx);
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 1);
  assert(s.err.join("\n").includes("REORG of "), s.err.join("\n"));
  assert(s.err.join("\n").includes("is still open (now: 1 of 50)"), s.err.join("\n"));
  assert((await progressOf(s.planDir)).txs[t1.file].reorgs!.every((r) => !r.resolved));
  ecx.tip += 59;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  p = (await progressOf(s.planDir)).txs[t1.file];
  assert(p.reorgs!.every((r) => r.resolved), JSON.stringify(p.reorgs));
  assertEquals(p.broadcast!.status, "accepted");
});

Deno.test("TEST FIRST replaced by a fee bump: the rest goes once the replacement confirms", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const ecx = s.chains.ecx;
  assertEquals(ecx.broadcasts!.length, 1); // TEST FIRST alone
  const test = s.plan.transactions.find((t: { chain: string; testFirst: boolean }) =>
    t.chain === "ecx" && t.testFirst
  );
  const oldTxid = ecx.broadcasts![0].txid;

  // Stuck: bump it. A second bump while the first is unsent is refused (no -bump2).
  assertEquals(await s.run("bump", s.id, "--chains", "ecx", "--tx", "1", "--fee-rate", "ecx=9"), 0);
  const bumpId = `${s.id}-bump1`;
  s.out.length = 0;
  assertEquals(
    await s.run("bump", s.id, "--chains", "ecx", "--tx", "1", "--fee-rate", "ecx=12"),
    1,
  );
  assert(s.out.join("\n").includes(`plan ${bumpId} already replaces it and is not sent yet`));
  assertEquals(await Deno.stat(join(s.dir, "plans", `${s.id}-bump2`)).catch(() => null), null);

  // Sign, verify, send the replacement (the fake node has no RBF: evict the original first).
  const bumpDir = join(s.dir, "plans", bumpId);
  const bumpPlan = JSON.parse(await Deno.readTextFile(join(bumpDir, "plan.json")));
  await signAll(bumpDir, bumpPlan);
  assertEquals(await s.run("verify", bumpId), 0, s.err.join("\n"));
  drop(ecx, oldTxid);
  assertEquals(await s.run("broadcast", bumpId, "--yes"), 0, s.err.join("\n"));
  assertEquals((await progressOf(s.planDir)).txs[test.file].broadcast!.status, "replaced");

  // Replacement unconfirmed: the question says so; "no" sends nothing.
  s.out.length = 0;
  s.questions.length = 0;
  s.answer.yes = false;
  assertEquals(await s.run("broadcast", s.id), 1);
  assertEquals(ecx.broadcasts!.length, 2);
  assert(
    s.questions[0].includes(`was replaced by plan ${bumpId}, which is in the mempool`),
    s.questions[0],
  );
  assert(s.out.join("\n").includes("Nothing sent:"));
  s.answer.yes = true;

  // Replacement confirmed: "Broadcast verified" on the original plan sends the rest.
  mine(ecx);
  mine(s.chains.xbt);
  s.questions.length = 0;
  assertEquals(await s.run("broadcast", s.id), 0, s.err.join("\n"));
  assert(s.questions[0].includes(`which is confirmed (1 deep)`), s.questions[0]);
  assertEquals(ecx.broadcasts!.length, 3);
  const rest = s.plan.transactions.find((t: { chain: string; order: number }) =>
    t.chain === "ecx" && t.order === 2
  );
  assertEquals((await progressOf(s.planDir)).txs[rest.file].broadcast!.status, "accepted");
});

Deno.test("bump --another writes a second replacement anyway, with a warning; --yes alone doesn't", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const args = ["bump", s.id, "--chains", "ecx", "--tx", "1", "--fee-rate", "ecx=9"];
  assertEquals(await s.run(...args), 0);
  // --yes only answers the prompt; it no longer overrides the one-unsent-bump rule.
  s.out.length = 0;
  assertEquals(await s.run(...args, "--yes"), 1);
  assert(s.out.join("\n").includes("--another writes another one anyway"), s.out.join("\n"));
  assertEquals(await Deno.stat(join(s.dir, "plans", `${s.id}-bump2`)).catch(() => null), null);
  assertEquals(await s.run(...args, "--another", "--yes"), 0, s.err.join("\n"));
  assert(s.err.join("\n").includes("Only one replacement can ever confirm"));
  assert(await Deno.stat(join(s.dir, "plans", `${s.id}-bump2`)));
});

Deno.test("broadcast: with an unverified TEST FIRST it asks before sending the rest, and every held one says why", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  const test = s.plan.transactions.find((t: { chain: string; testFirst: boolean }) =>
    t.chain === "ecx" && t.testFirst
  );
  // Only the second ECX transaction comes back signed.
  const others = s.plan.transactions.filter((t: { file: string }) => t.file !== test.file)
    .map((t: { file: string }) => join(s.planDir, t.file.replace(/\.psbt$/u, ".signed.psbt")));
  assertEquals(await s.run("verify", s.id, ...others), 0, s.err.join("\n"));
  s.out.length = 0;
  s.answer.yes = false;
  assertEquals(await s.run("broadcast", s.id), 1);
  assertEquals(s.chains.ecx.broadcasts, undefined); // used to go out without its test
  // Two questions only in this mixed case: the rest of ECX (after its TEST FIRST), then the XBT
  // TEST FIRST transaction's own first send, which needs the usual yes.
  assertEquals(s.questions.length, 2);
  assert(s.questions[0].includes("isn't verified yet"), s.questions[0]);
  assert(s.questions[1].startsWith("Broadcast these now?"), s.questions[1]);
  const text = s.out.join("\n");
  assert(text.includes(`ECX #1 (${test.file}): not verified yet`), text);
  assert(text.includes("ECX #2 (") && text.includes("not sent: you chose to wait"), text);
  assertEquals(s.chains.xbt.broadcasts, undefined);
  // "yes" sends the rest without the test: the user's call, nothing is stuck. XBT still sends
  // only its TEST FIRST transaction.
  s.answer.yes = true;
  assertEquals(await s.run("broadcast", s.id), 0, s.err.join("\n"));
  assertEquals(s.chains.ecx.broadcasts!.length, 1);
  assertEquals(s.chains.xbt.broadcasts!.length, 1);
});

// ---- a split that was sent but never confirmed and fell out of the mempool ----

type Tx1 = { chain: string; order: number; file: string; testFirst?: boolean };
const ecxTx = (s: { plan: { transactions: Tx1[] } }, order: number) =>
  s.plan.transactions.find((t) => t.chain === "ecx" && t.order === order)!;

/** Moves a send's time back, past the grace `track` gives a split no mempool shows yet. */
async function backdateSends(planDir: string, minutes = 60) {
  const p = JSON.parse(await Deno.readTextFile(join(planDir, "progress.json")));
  for (const e of Object.values(p.txs) as { broadcast?: { at: string } }[]) {
    if (e.broadcast) {
      e.broadcast.at = new Date(Date.parse(e.broadcast.at) - minutes * 60_000).toISOString();
    }
  }
  await Deno.writeTextFile(join(planDir, "progress.json"), JSON.stringify(p));
}

Deno.test("dropped from the mempool: track alerts, delete is refused, Broadcast verified sends it again", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const ecx = s.chains.ecx;
  mine(ecx); // TEST FIRST confirmed: the rest may go
  mine(s.chains.xbt);
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const second = ecxTx(s, 2);
  const id2 = (await progressOf(s.planDir)).txs[second.file].verified!.txid;
  assertEquals(ecx.broadcasts!.at(-1)!.txid, id2);
  // track sees it in the mempool, then it falls out of every mempool without confirming.
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  drop(ecx, id2);
  s.out.length = 0;
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 1);
  const err = s.err.join("\n");
  assert(err.includes("!!! WARNING"), err);
  assert(
    err.includes(`ECX ${second.file}: DROPPED: This split was in the mempool (last seen`),
    err,
  );
  assert(err.includes("mempool minimum") && err.includes("`splayed bump`"), err);
  assert(s.out.join("\n").includes("DROPPED from the mempool, never confirmed"), s.out.join("\n"));
  let p = (await progressOf(s.planDir)).txs[second.file] as Prog["txs"][string] & {
    unmined?: { state: string; lastInMempool?: string };
  };
  assertEquals(p.broadcast!.status, "accepted"); // it was sent: still counts as sent
  assertEquals(p.unmined!.state, "absent");
  assert(p.unmined!.lastInMempool);
  assertEquals(p.reorgs!.map((r) => r.kind), ["evicted"]);
  assertEquals(p.confirmations, undefined); // never in a block: no depth record is invented
  // Repeats on every track while it is out, recorded once.
  assertEquals(await s.run("track", s.id), 1);
  assertEquals((await progressOf(s.planDir)).txs[second.file].reorgs!.length, 1);
  // Sent and not confirmed: the plan can't be deleted.
  assertEquals(await s.run("plans", "delete", s.id, "--yes"), 1);

  // Broadcast verified sends it again (bytes re-verified, inputs re-checked); nothing else.
  const before = ecx.broadcasts!.length;
  s.out.length = 0;
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals(ecx.broadcasts!.length, before + 1);
  assertEquals(ecx.broadcasts!.at(-1)!.txid, id2);
  assert(s.out.join("\n").includes("no longer in the mempool or on the chain"), s.out.join("\n"));
  p = (await progressOf(s.planDir)).txs[second.file];
  assertEquals(p.broadcast!.status, "accepted");
  assertEquals(p.unmined, undefined);
  // Back in the mempool: sending again is idempotent.
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals(ecx.broadcasts!.length, before + 1);
  assert(s.out.join("\n").includes("already sent: in the mempool"), s.out.join("\n"));
  // Deep: the alert is resolved.
  mine(ecx);
  ecx.tip += 59;
  s.chains.xbt.tip += 59;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assert((await progressOf(s.planDir)).txs[second.file].reorgs!.every((r) => r.resolved));
});

Deno.test("dropped from the mempool: a TEST FIRST sent with --all is sent again when nothing else is pending", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, s.err.join("\n"));
  const ecx = s.chains.ecx;
  const test = s.plan.transactions.find((t: Tx1) => t.chain === "ecx" && t.testFirst);
  const testId = (await progressOf(s.planDir)).txs[test.file].verified!.txid;
  drop(ecx, testId);
  // Every ECX transaction is "accepted", so this used to stop at "Nothing to broadcast".
  const before = ecx.broadcasts!.length;
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals(ecx.broadcasts!.length, before + 1);
  assertEquals(ecx.broadcasts!.at(-1)!.txid, testId);
  // A split no mempool has seen yet, sent minutes ago: no alarm yet.
  drop(ecx, testId);
  s.out.length = 0;
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assert(s.out.join("\n").includes("not on the network yet"), s.out.join("\n"));
  await backdateSends(s.planDir);
  assertEquals(await s.run("track", s.id), 1);
  assert(s.err.join("\n").includes("DROPPED: This split was accepted by the server"));
});

Deno.test("dropped from the mempool: a failed lookup is never taken for a drop", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, s.err.join("\n"));
  const ecx = s.chains.ecx;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  await backdateSends(s.planDir);
  const second = ecxTx(s, 2);
  const id2 = (await progressOf(s.planDir)).txs[second.file].verified!.txid;
  const before = JSON.stringify((await progressOf(s.planDir)).txs[second.file]);
  drop(ecx, id2);
  // The server mimics the eCash Esplora trap ({"confirmed":false} for any txid) and then fails
  // the existence check: that used to read as "mempool"; it must not read as anything.
  ecx.statusTrap = true;
  ecx.fail = new RegExp(`^/tx/${id2}$`);
  s.out.length = 0;
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 1);
  const err = s.err.join("\n");
  assert(!err.includes("DROPPED") && !err.includes("!!! WARNING"), err);
  assert(err.includes(`ECX ${second.file}: couldn't check it`), err);
  assert(s.out.join("\n").includes("? (lookup failed)"), s.out.join("\n"));
  assert(s.out.join("\n").includes("XBT"), "the other transactions are still tracked");
  assertEquals(JSON.stringify((await progressOf(s.planDir)).txs[second.file]), before);
  // broadcast doesn't send on the strength of it either.
  const sent = ecx.broadcasts!.length;
  s.out.length = 0;
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals(ecx.broadcasts!.length, sent);
  assert(s.out.join("\n").includes("couldn't check whether it is still on the network"));
});

Deno.test("broadcast: a server that already has the transaction is not a rejection", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  s.chains.ecx.accept = () => "txn-already-known";
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const test = s.plan.transactions.find((t: Tx1) => t.chain === "ecx" && t.testFirst);
  const b = (await progressOf(s.planDir)).txs[test.file].broadcast!;
  assertEquals(b.status, "accepted");
  assertEquals(b.detail, "the server already had it");
});

Deno.test("dropped from the mempool: a fee-bumped original vanishing is expected; its replacement vanishing is not", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const ecx = s.chains.ecx;
  const oldTxid = ecx.broadcasts![0].txid;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n")); // seen in the mempool
  assertEquals(await s.run("bump", s.id, "--chains", "ecx", "--tx", "1", "--fee-rate", "ecx=9"), 0);
  const bumpId = `${s.id}-bump1`;
  const bumpDir = join(s.dir, "plans", bumpId);
  await signAll(bumpDir, JSON.parse(await Deno.readTextFile(join(bumpDir, "plan.json"))));
  assertEquals(await s.run("verify", bumpId), 0, s.err.join("\n"));
  drop(ecx, oldTxid); // the replacement evicts the original
  assertEquals(await s.run("broadcast", bumpId, "--yes"), 0, s.err.join("\n"));
  await backdateSends(s.planDir);
  await backdateSends(bumpDir);
  // The original is gone, as it should be: no alarm.
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("track", bumpId), 0, s.err.join("\n"));
  // The replacement falls out of the mempool too: both plans say so.
  drop(ecx, ecx.broadcasts!.at(-1)!.txid);
  s.err.length = 0;
  assertEquals(await s.run("track", bumpId), 1);
  assert(s.err.join("\n").includes("DROPPED: This split was in the mempool"), s.err.join("\n"));
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 1);
  assert(s.err.join("\n").includes("is no longer in the mempool or on the chain either"));
  assert(s.err.join("\n").includes(`\`splayed broadcast ${bumpId}\``), s.err.join("\n"));
  // Neither plan can be deleted.
  assertEquals(await s.run("plans", "delete", bumpId, "--yes"), 1);
  assertEquals(await s.run("plans", "delete", s.id, "--yes"), 1);
  // Broadcast verified on the bump plan sends the replacement again.
  const n = ecx.broadcasts!.length;
  assertEquals(await s.run("broadcast", bumpId, "--yes"), 0, s.err.join("\n"));
  assertEquals(ecx.broadcasts!.length, n + 1);
});

// ---- this tool's own spends are recognised before anything is called a conflict ----

/** Bumps ECX #1 of `planId`, signs, verifies and sends it (evicting `evict`, as RBF would). */
async function bumpAndSend(
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

async function sentTestFirst() {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const test = s.plan.transactions.find((t: Tx1) => t.chain === "ecx" && t.testFirst);
  return { s, test, old: s.chains.ecx.broadcasts![0].txid };
}

Deno.test("own spends: a bump of a bump is followed by track, with no false alarm, and can't be deleted from under it", async () => {
  const { s, test, old } = await sentTestFirst();
  const b = await bumpAndSend(s, s.id, 9, old);
  const c = await bumpAndSend(s, b.bumpId, 15, b.txid);
  mine(s.chains.ecx);
  mine(s.chains.xbt);
  s.out.length = 0;
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  const text = s.out.join("\n");
  assert(text.includes(`REPLACED by plan ${c.bumpId} (via ${b.bumpId}) (confirmed, 1 deep)`), text);
  assertEquals((await progressOf(s.planDir)).txs[test.file].reorgs, undefined);
  // Broadcast verified on the original: the question follows the bumps, and the rest goes.
  const n = s.chains.ecx.broadcasts!.length;
  s.questions.length = 0;
  assertEquals(await s.run("broadcast", s.id), 0, s.err.join("\n"));
  assert(
    s.questions[0].includes(
      `was replaced by plan ${c.bumpId} (via ${b.bumpId}), which is confirmed (1 deep)`,
    ),
    s.questions[0],
  );
  assertEquals(s.chains.ecx.broadcasts!.length, n + 1);
  assertEquals(await s.run("track", b.bumpId), 0, s.err.join("\n"));
  // The last bump, deep: it is still the link the others follow, so it can't be deleted.
  s.chains.ecx.tip += 60;
  s.chains.xbt.tip += 60;
  assertEquals(await s.run("track", c.bumpId), 0, s.err.join("\n"));
  s.err.length = 0;
  assertEquals(await s.run("plans", "delete", c.bumpId, "--yes"), 1);
  assert(
    s.err.join("\n").includes(`plan ${b.bumpId} (ecx/`) &&
      s.err.join("\n").includes("points to as its replacement"),
    s.err.join("\n"),
  );
});

/** A fee bump that got out, but whose reply was lost: its plan says unknown, the original knows nothing. */
async function lostReply() {
  const { s, test, old } = await sentTestFirst();
  const b = await bumpAndSend(s, s.id, 9, old);
  const pb = JSON.parse(await Deno.readTextFile(join(b.bumpDir, "progress.json")));
  for (const k in pb.txs) if (pb.txs[k].broadcast) pb.txs[k].broadcast.status = "unknown";
  await Deno.writeTextFile(join(b.bumpDir, "progress.json"), JSON.stringify(pb));
  const po = JSON.parse(await Deno.readTextFile(join(s.planDir, "progress.json")));
  delete po.txs[test.file].replacedBy;
  po.txs[test.file].broadcast.status = "accepted";
  await Deno.writeTextFile(join(s.planDir, "progress.json"), JSON.stringify(po));
  mine(s.chains.ecx);
  mine(s.chains.xbt);
  return { s, test, b };
}

Deno.test("own spends: a fee bump whose send reply was lost is recognised, however it is found", async () => {
  for (const first of ["track the original", "broadcast the bump", "track the bump"]) {
    const { s, test, b } = await lostReply();
    if (first === "broadcast the bump") {
      const n = s.chains.ecx.broadcasts!.length;
      assertEquals(await s.run("broadcast", b.bumpId, "--yes"), 0, s.err.join("\n"));
      assertEquals(s.chains.ecx.broadcasts!.length, n, "already on chain: not sent again");
    } else if (first === "track the bump") {
      assertEquals(await s.run("track", b.bumpId), 0, s.err.join("\n"));
    }
    s.out.length = 0;
    s.err.length = 0;
    assertEquals(await s.run("track", s.id), 0, `${first}: ${s.err.join("\n")}`);
    assert(!s.err.join("\n").includes("CONFLICT"), first);
    assert(s.out.join("\n").includes(`REPLACED by plan ${b.bumpId}`), first);
    const p = (await progressOf(s.planDir)).txs[test.file] as Prog["txs"][string] & {
      replacedBy?: { plan: string; txid?: string };
    };
    assertEquals(p.broadcast!.status, "replaced", first);
    assertEquals(p.replacedBy!.plan, b.bumpId, first);
    assertEquals(p.replacedBy!.txid, b.txid, first);
    assertEquals(p.reorgs, undefined, first);
    // The rest of the plan goes out after the usual question.
    const n = s.chains.ecx.broadcasts!.length;
    s.questions.length = 0;
    assertEquals(await s.run("broadcast", s.id), 0, s.err.join("\n"));
    assert(s.questions[0].includes(`replaced by plan ${b.bumpId}, which is confirmed`), first);
    assertEquals(s.chains.ecx.broadcasts!.length, n + 1, first);
  }
});

Deno.test("own spends: a deep fee bump plan is kept while the original follows it; archived, it can go and is followed by txid", async () => {
  const { s, old } = await sentTestFirst();
  const b = await bumpAndSend(s, s.id, 9, old);
  mine(s.chains.ecx);
  mine(s.chains.xbt);
  s.chains.ecx.tip += 100;
  s.chains.xbt.tip += 100;
  assertEquals(await s.run("track", b.bumpId), 0, s.err.join("\n"));
  assertEquals(await s.run("plans", "delete", b.bumpId, "--yes"), 1); // used to be deleted
  assertEquals(await s.run("plans", "archive", s.id), 0);
  assertEquals(await s.run("plans", "delete", b.bumpId, "--yes"), 0, s.err.join("\n"));
  assertEquals(await s.run("plans", "unarchive", s.id), 0);
  s.out.length = 0;
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assert(s.out.join("\n").includes(`REPLACED by plan ${b.bumpId} (confirmed, 101 deep)`));
  // Followed by txid for the TEST FIRST question too; the rest goes.
  const n = s.chains.ecx.broadcasts!.length;
  s.questions.length = 0;
  assertEquals(await s.run("broadcast", s.id), 0, s.err.join("\n"));
  assert(s.questions[0].includes(`which is confirmed (101 deep)`), s.questions[0]);
  assertEquals(s.chains.ecx.broadcasts!.length, n + 1);
});

Deno.test("own spends: a coin in two plans: the plan that lost is superseded, not in conflict", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  // The same coins planned again (say, after forgetting the first plan was sent).
  assertEquals(
    await s.run("plan", "--xbt-signer", "knots", "--fee-rate", "ecx=2,xbt=3", "--yes"),
    0,
    s.err.join("\n"),
  );
  const ids: string[] = [];
  for await (const e of Deno.readDir(join(s.dir, "plans"))) ids.push(e.name);
  const p2 = ids.sort().find((id) => id !== s.id)!;
  const p2Dir = join(s.dir, "plans", p2);
  await signAll(p2Dir, JSON.parse(await Deno.readTextFile(join(p2Dir, "plan.json"))));
  assertEquals(await s.run("verify", p2), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, s.err.join("\n"));
  // On ECX the first plan's splits fall out and the second plan's get in instead.
  const first = (await progressOf(s.planDir)).txs;
  for (const t of s.plan.transactions.filter((t: Tx1) => t.chain === "ecx")) {
    drop(s.chains.ecx, first[t.file].verified!.txid);
  }
  s.err.length = 0;
  assertEquals(await s.run("broadcast", p2, "--all", "--yes"), 0, s.err.join("\n"));
  // On XBT the first plan got there first: the second plan's XBT splits are superseded at once.
  const second = (await progressOf(p2Dir)).txs;
  const p2Plan = JSON.parse(await Deno.readTextFile(join(p2Dir, "plan.json")));
  for (const t of p2Plan.transactions.filter((t: Tx1) => t.chain === "xbt")) {
    assertEquals(second[t.file].broadcast!.status, "superseded", t.file);
  }
  assert(!s.err.join("\n").includes("no longer unspent"), s.err.join("\n"));
  mine(s.chains.ecx);
  mine(s.chains.xbt);
  s.out.length = 0;
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assert(!s.err.join("\n").includes("CONFLICT"), s.err.join("\n"));
  assert(s.out.join("\n").includes(`superseded by plan ${p2}`), s.out.join("\n"));
  const t1 = ecxTx(s, 1);
  const p = (await progressOf(s.planDir)).txs[t1.file] as Prog["txs"][string] & {
    supersededBy?: { plan: string; depth?: number };
  };
  assertEquals(p.broadcast!.status, "superseded");
  assertEquals(p.supersededBy!.plan, p2);
  assertEquals(p.supersededBy!.depth, 1);
  // Nothing to bump or send for it.
  s.out.length = 0;
  assertEquals(await s.run("bump", s.id, "--chains", "ecx", "--tx", "1", "--fee-rate", "ecx=9"), 1);
  assert(s.out.join("\n").includes(`plan ${p2} already spent this coin`), s.out.join("\n"));
  const n = s.chains.ecx.broadcasts!.length;
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, s.err.join("\n"));
  assertEquals(s.chains.ecx.broadcasts!.length, n);
});

Deno.test("own spends: a stranger's spend is a CONFLICT that lists the likely causes", async () => {
  const { s, test, old } = await sentTestFirst();
  drop(s.chains.ecx, old);
  const input = s.plan.transactions.find((t: Tx1) => t.file === test.file).inputs[0];
  const stranger = spendReal(s.chains.ecx, input.txid, input.vout, s.chains.ecx.tip, 7);
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 1);
  const err = s.err.join("\n");
  assert(err.includes(`CONFLICT: This split's input was spent by transaction ${stranger}`), err);
  assert(err.includes("not one of this tool's plans or fee bumps"), err);
  assert(err.includes("spent with another wallet or tool"), err);
  assert(err.includes("replayed onto ECX"), err);
  assert(err.includes("only if neither applies, the key may be compromised"), err);
  assert(!err.includes("treat the key as compromised"), err);
  // broadcast says so in its question, and sends the rest only on yes.
  s.answer.yes = false;
  s.questions.length = 0;
  const n = s.chains.ecx.broadcasts!.length;
  assertEquals(await s.run("broadcast", s.id), 1);
  assert(
    s.questions[0].includes(`is in conflict: its input was spent by ${stranger}`),
    s.questions[0],
  );
  assertEquals(s.chains.ecx.broadcasts!.length, n);
});

Deno.test("track: a split marked conflict that is deep in the chain itself is accepted again", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, s.err.join("\n"));
  mine(s.chains.ecx);
  mine(s.chains.xbt);
  const t1 = s.plan.transactions.find((t: Tx1) => t.chain === "xbt" && t.order === 1);
  // An earlier run (or an older version) marked it conflict.
  const po = JSON.parse(await Deno.readTextFile(join(s.planDir, "progress.json")));
  po.txs[t1.file].broadcast.status = "conflict";
  await Deno.writeTextFile(join(s.planDir, "progress.json"), JSON.stringify(po));
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assertEquals((await progressOf(s.planDir)).txs[t1.file].broadcast!.status, "conflict"); // shallow
  s.chains.ecx.tip += 59;
  s.chains.xbt.tip += 59;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assertEquals((await progressOf(s.planDir)).txs[t1.file].broadcast!.status, "accepted");
  // Back to "accepted", it counts again for the donor rules.
  assert((await protectedTxids(s.dir, "xbt")).has(
    (await progressOf(s.planDir)).txs[t1.file].verified!.txid,
  ));
});
