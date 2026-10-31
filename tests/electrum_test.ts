import { assert, assertEquals } from "./assert.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { ElectrumBackend } from "../src/backends/electrum.ts";
import { fromHex, reverseBytes, toHex } from "../src/core/bytes.ts";
import { verifyIdentity } from "../src/core/identity.ts";
import { type ChainProfile, MAINNET } from "../src/core/profiles.ts";
import { electrumScripthash, parseTx, txid as computeTxid } from "../src/core/tx.ts";
import { resolveRoute } from "../src/net/transport.ts";
import { type FakeChain, fakeChain, fund, spendReal } from "./fakes.ts";
import { serializeStripped } from "../src/core/tx.ts";

/** Minimal Electrum server over TCP backed by a FakeChain. */
async function withElectrum(chain: FakeChain, fn: (port: number) => Promise<void>) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns: Deno.Conn[] = [];
  const handle = async (conn: Deno.Conn) => {
    conns.push(conn);
    const dec = new TextDecoder();
    let buf = "";
    const b = new Uint8Array(65536);
    const send = (o: unknown) => conn.write(new TextEncoder().encode(JSON.stringify(o) + "\n"));
    // Script -> outpoints index built on demand from the chain's history.
    const byScripthash = () => {
      const map = new Map<string, { txid: string; vout: number; script: string }[]>();
      for (const [id, tx] of chain.txs) {
        tx.vout.forEach((o, vout) => {
          const sh = electrumScripthash(fromHex(o.scriptpubkey));
          map.set(sh, [...(map.get(sh) ?? []), { txid: id, vout, script: o.scriptpubkey }]);
        });
      }
      return map;
    };
    try {
      while (true) {
        const n = await conn.read(b);
        if (n === null) break;
        buf += dec.decode(b.subarray(0, n));
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const { id, method, params } = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          const ok = (result: unknown) => send({ jsonrpc: "2.0", id, result });
          const fail = (message: string) =>
            send({ jsonrpc: "2.0", id, error: { code: 2, message } });
          chain.requests.push(method);
          switch (method) {
            case "server.version":
              await ok(["FakeElectrum", "1.4"]);
              break;
            case "blockchain.headers.subscribe":
              await ok({ height: chain.tip, hex: chain.headers?.get(chain.tip) ?? "" });
              break;
            case "blockchain.block.header": {
              const h = chain.headers?.get(params[0]);
              await (h ? ok(h) : fail("height out of range"));
              break;
            }
            case "blockchain.transaction.get": {
              const tx = chain.txs.get(params[0]);
              await (tx?.raw ? ok(tx.raw) : fail("No such mempool or blockchain transaction"));
              break;
            }
            case "blockchain.scripthash.listunspent": {
              const outs = byScripthash().get(params[0]) ?? [];
              await ok(
                outs.filter((o) => !chain.spends.has(`${o.txid}:${o.vout}`)).map((o) => ({
                  tx_hash: o.txid,
                  tx_pos: o.vout,
                  height: chain.txs.get(o.txid)!.height ?? 0,
                  value: chain.txs.get(o.txid)!.vout[o.vout].value,
                })),
              );
              break;
            }
            case "blockchain.scripthash.get_history": {
              const outs = byScripthash().get(params[0]) ?? [];
              const hist: { tx_hash: string; height: number }[] = [];
              for (const o of outs) {
                hist.push({ tx_hash: o.txid, height: chain.txs.get(o.txid)!.height ?? 0 });
                const sp = chain.spends.get(`${o.txid}:${o.vout}`);
                if (sp) hist.push({ tx_hash: sp.txid, height: sp.height ?? 0 });
              }
              await ok(hist);
              break;
            }
            case "blockchain.transaction.broadcast": {
              const tx = parseTx(params[0]);
              const id = computeTxid(tx);
              if (tx.inputs.some((i) => chain.spends.has(`${i.txid}:${i.vout}`))) {
                await fail("bad-txns-inputs-missingorspent");
                break;
              }
              for (const i of tx.inputs) chain.spends.set(`${i.txid}:${i.vout}`, { txid: id });
              chain.txs.set(id, { vout: [], raw: params[0] });
              await ok(id);
              break;
            }
            case "blockchain.estimatefee":
              await ok(0.00002);
              break;
            default:
              await fail(`unknown method ${method}`);
          }
        }
      }
    } catch { /* closed */ }
  };
  const accepting = (async () => {
    for await (const c of listener) handle(c);
  })();
  try {
    await fn((listener.addr as Deno.NetAddr).port);
  } finally {
    listener.close();
    for (const c of conns) {
      try {
        c.close();
      } catch { /* closed */ }
    }
    await accepting.catch(() => {});
  }
}

const cfg = (url: string) => ({
  kind: "electrum" as const,
  url,
  proxy: { kind: "tor" as const },
  role: "both" as const,
  priority: 0,
  origin: "user" as const,
});

function backend(chainId: "btc" | "xbt" | "ecx", port: number) {
  const url = `tcp://127.0.0.1:${port}`;
  const route = resolveRoute(url, { kind: "tor" }, false, { host: "127.0.0.1", port: 9050 });
  return new ElectrumBackend(
    chainId,
    cfg(url),
    route,
    undefined,
    () => Deno.connect({ hostname: "127.0.0.1", port }),
  );
}

function v2Header(prevDisplayHash: string, fill: number): string {
  const h = new Uint8Array(164).fill(fill);
  new DataView(h.buffer).setUint32(0, 0x8000_0000 | 0x2000_0000, true);
  h.set(reverseBytes(fromHex(prevDisplayHash)), 4);
  return toHex(h);
}

Deno.test("Electrum: XBT identity from the 164-byte header's previous-hash field", async () => {
  const xbt = fakeChain("xbt", 970_000);
  const pinned = MAINNET.chains.xbt.checkpoints[0].hash;
  xbt.headers = new Map([
    [961_640, v2Header("00".repeat(32), 1)],
    [961_641, v2Header(pinned, 2)],
  ]);
  await withElectrum(xbt, async (port) => {
    const b = backend("xbt", port);
    try {
      assertEquals(b.route.via, "direct");
      const r = await verifyIdentity(b, MAINNET.chains.xbt);
      assertEquals(r.ok, true, r.detail);
      // A BTC-chain server would carry a different previous hash.
      xbt.headers!.set(961_641, v2Header("ab".repeat(32), 2));
      assertEquals((await verifyIdentity(b, MAINNET.chains.xbt)).ok, false);
    } finally {
      await b.close();
    }
  });
});

Deno.test("Electrum: 80-byte headers must hash (sha256d) to the linked previous hash", async () => {
  const btc = fakeChain("btc", 1000);
  const h100 = new Uint8Array(80).fill(7);
  const hash100 = toHex(reverseBytes(sha256(sha256(h100))));
  const h101 = new Uint8Array(80).fill(8);
  h101.set(reverseBytes(fromHex(hash100)), 4);
  btc.headers = new Map([[100, toHex(h100)], [101, toHex(h101)]]);
  const profile: ChainProfile = {
    ...MAINNET.chains.btc,
    checkpoints: [{ height: 100, hash: hash100, source: "test" }],
  };
  await withElectrum(btc, async (port) => {
    const b = backend("btc", port);
    try {
      assertEquals((await verifyIdentity(b, profile)).ok, true);
      // Tamper with header 100 so it no longer links to 101.
      btc.headers!.set(100, toHex(new Uint8Array(80).fill(9)));
      const r = await verifyIdentity(b, profile);
      assertEquals(r.ok, false);
      assert(r.detail.includes("don't link"));
    } finally {
      await b.close();
    }
  });
});

Deno.test("Electrum: observe unspent, spent (with depth) and absent; discovery; fees", async () => {
  const ecx = fakeChain("ecx", 974_500);
  const script = "0014" + "11".repeat(20);
  const id = fund(
    [ecx],
    [{ address: "bc1qtest", scriptPubKey: script, value: 50_000 }, {
      address: "bc1qtest",
      scriptPubKey: script,
      value: 60_000,
    }],
    900_000,
    1,
  );
  const spender = spendReal(ecx, id, 1, 974_400, 2);
  await withElectrum(ecx, async (port) => {
    const b = backend("ecx", port);
    try {
      assertEquals(await b.observeOutput(id, 0), {
        state: "unspent",
        value: 50_000,
        createdHeight: 900_000,
      });
      const spent = await b.observeOutput(id, 1);
      assertEquals(spent, {
        state: "spent",
        value: 60_000,
        spendTxid: spender,
        spendHeight: 974_400,
        spendDetailKnown: true,
      });
      assertEquals((await b.observeOutput("cd".repeat(32), 0)).state, "absent");
      assertEquals(await b.addressTxCount("bc1qtest", script), 3);
      assertEquals((await b.addressUtxos("bc1qtest", script)).map((u) => u.vout), [0]);
      assertEquals(await b.feeRate(6), 2);
      assertEquals(await b.rawTransaction(id), ecx.txs.get(id)!.raw);
    } finally {
      await b.close();
    }
  });
});

Deno.test("Electrum: txStatus reads confirmed (with block hash), mempool and absent", async () => {
  const ecx = fakeChain("ecx", 974_500);
  const id = fund(
    [ecx],
    [{ address: "bc1qs", scriptPubKey: "0014" + "33".repeat(20), value: 10_000 }],
    900_000,
    1,
  );
  const mined = spendReal(ecx, id, 0, 974_400, 2);
  const pooled = spendReal(ecx, mined, 0, undefined, 3);
  const header = new Uint8Array(80).fill(7);
  ecx.headers = new Map([[974_400, toHex(header)]]);
  const expected = toHex(reverseBytes(sha256(sha256(header))));
  await withElectrum(ecx, async (port) => {
    const b = backend("ecx", port);
    try {
      // The spends use a bare OP_1 script, so look them up by that script's history.
      assertEquals(await b.txStatus(mined), {
        state: "confirmed",
        height: 974_400,
        blockHash: expected,
      });
      assertEquals(await b.txStatus(pooled), { state: "mempool" });
      assertEquals(await b.txStatus("cd".repeat(32)), { state: "absent" });
      // Dropped from the mempool: the server stops listing it (the raw bytes are cached).
      ecx.txs.delete(pooled);
      ecx.spends.delete(`${mined}:0`);
      assertEquals(await b.txStatus(pooled), { state: "absent" });
    } finally {
      await b.close();
    }
  });
});

Deno.test("Electrum: broadcast on its own connection; explicit errors are marked as rejections", async () => {
  const ecx = fakeChain("ecx", 974_500);
  const id = fund(
    [ecx],
    [{ address: "bc1qx", scriptPubKey: "0014" + "22".repeat(20), value: 10_000 }],
    900_000,
    7,
  );
  const spend = {
    version: 2,
    inputs: [{ txid: id, vout: 0, scriptSig: new Uint8Array(), sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: 9_000n, script: Uint8Array.of(0x51) }],
    lockTime: 499_999_998,
  };
  const hex = toHex(serializeStripped(spend));
  let connects = 0;
  await withElectrum(ecx, async (port) => {
    const url = `tcp://127.0.0.1:${port}`;
    const route = resolveRoute(url, { kind: "tor" }, false, { host: "127.0.0.1", port: 9050 });
    const b = new ElectrumBackend("ecx", cfg(url), route, undefined, () => {
      connects++;
      return Deno.connect({ hostname: "127.0.0.1", port });
    });
    try {
      await b.tipHeight(); // read connection
      assertEquals(await b.broadcast(hex, "broadcast:x"), computeTxid(spend));
      assertEquals(connects, 2); // broadcast used a fresh connection
      const again = await b.broadcast(hex, "broadcast:x").catch((e) => e);
      assertEquals(again.status, -1);
      assert(String(again.message).includes("missingorspent"));
    } finally {
      await b.close();
    }
  });
});
