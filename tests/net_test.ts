import { assert, assertEquals, assertRejects, assertThrows } from "./assert.ts";
import { classifyHost, isValidOnionV3 } from "../src/net/hosts.ts";
import { parseResponse } from "../src/net/http1.ts";
import {
  PolicyError,
  resolveRoute,
  RoutedTransport,
  TorUnavailableError,
} from "../src/net/transport.ts";

const BTC_ONION = "mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion";
const XBT_ONION = "mempool5nxspkxjk3n5afqh7zswbv4i324z76ltmw3cvfmniw45mnhad.onion";
const TOR = { host: "127.0.0.1", port: 9050 };

Deno.test("onion v3 checksum validation", () => {
  assert(isValidOnionV3(BTC_ONION));
  assert(isValidOnionV3(XBT_ONION));
  // One character changed breaks the checksum.
  assert(!isValidOnionV3(BTC_ONION.replace("mempoolhq", "mempoolhr")));
  assert(!isValidOnionV3("abc.onion"));
});

Deno.test("host classes", () => {
  assertEquals(classifyHost("127.0.0.1"), "loopback");
  assertEquals(classifyHost("localhost"), "loopback");
  assertEquals(classifyHost("[::1]"), "loopback");
  assertEquals(classifyHost("192.168.1.20"), "lan");
  assertEquals(classifyHost("10.0.0.5"), "lan");
  assertEquals(classifyHost("172.20.1.1"), "lan");
  assertEquals(classifyHost("node.local"), "lan");
  assertEquals(classifyHost(BTC_ONION), "onion");
  assertEquals(classifyHost("mempool.space"), "public");
  assertEquals(classifyHost("8.8.8.8"), "public");
});

Deno.test("route policy: Tor by default, no silent clearnet, onion needs a proxy", () => {
  const onion = resolveRoute(`http://${BTC_ONION}/api`, { kind: "tor" }, false, TOR);
  assertEquals(onion.via, "socks");
  const pub = resolveRoute("https://explorer.ecash.com/api", { kind: "tor" }, false, TOR);
  assertEquals(pub.via, "socks");
  assertThrows(
    () => resolveRoute("https://explorer.ecash.com/api", { kind: "none" }, false, TOR),
    PolicyError,
    "clearnet",
  );
  const opted = resolveRoute("https://explorer.ecash.com/api", { kind: "none" }, true, TOR);
  assertEquals(opted.via, "direct");
  assertThrows(
    () => resolveRoute(`http://${BTC_ONION}/api`, { kind: "none" }, true, TOR),
    PolicyError,
    "Tor",
  );
  assertThrows(
    () => resolveRoute("http://mempool.space/api", { kind: "tor" }, false, TOR),
    PolicyError,
    "https",
  );
  const local = resolveRoute("http://127.0.0.1:8332", { kind: "tor" }, false, TOR);
  assertEquals(local.via, "direct");
  assertThrows(
    () => resolveRoute("http://user:pw@127.0.0.1:8332", { kind: "tor" }, false, TOR),
    PolicyError,
  );
  assertThrows(
    () => resolveRoute(`http://${BTC_ONION.replace("q", "r")}/api`, { kind: "tor" }, false, TOR),
    PolicyError,
    "checksum",
  );
});

Deno.test("HTTP/1.1 parsing: content-length and chunked", () => {
  const enc = new TextEncoder();
  const a = parseResponse(enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloEXTRA"));
  assertEquals(a.status, 200);
  assertEquals(new TextDecoder().decode(a.body), "hello");
  const b = parseResponse(
    enc.encode(
      "HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nTran\r\n6\r\nsactio\r\n0\r\n\r\n",
    ),
  );
  assertEquals(b.status, 404);
  assertEquals(new TextDecoder().decode(b.body), "Transactio");
});

/** A fake SOCKS5 proxy that records handshakes and forwards to a local HTTP server. */
async function withFakeSocks(
  fn: (socksPort: number, seen: { user: string; atyp: number; host: string }[]) => Promise<void>,
) {
  const http = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req) => new Response(`path=${new URL(req.url).pathname}`),
  );
  const httpPort = (http.addr as Deno.NetAddr).port;
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const socksPort = (listener.addr as Deno.NetAddr).port;
  const seen: { user: string; atyp: number; host: string }[] = [];
  const pending: Promise<void>[] = [];
  const accept = (async () => {
    for await (const conn of listener) {
      pending.push((async () => {
        const buf = new Uint8Array(1024);
        const read = async (n: number) => {
          const out = new Uint8Array(n);
          let o = 0;
          while (o < n) {
            const r = await conn.read(buf.subarray(0, n - o));
            if (r === null) throw new Error("eof");
            out.set(buf.subarray(0, r), o);
            o += r;
          }
          return out;
        };
        try {
          const greet = await read(2);
          await read(greet[1]);
          await conn.write(Uint8Array.of(5, 2));
          const ver = await read(2);
          const user = new TextDecoder().decode(await read(ver[1]));
          const plen = (await read(1))[0];
          await read(plen);
          await conn.write(Uint8Array.of(1, 0));
          const head = await read(4);
          let host = "";
          if (head[3] === 3) {
            const len = (await read(1))[0];
            host = new TextDecoder().decode(await read(len));
          }
          await read(2);
          seen.push({ user, atyp: head[3], host });
          const upstream = await Deno.connect({ hostname: "127.0.0.1", port: httpPort });
          await conn.write(Uint8Array.of(5, 0, 0, 1, 127, 0, 0, 1, 0, 0));
          await Promise.all([
            conn.readable.pipeTo(upstream.writable).catch(() => {}),
            upstream.readable.pipeTo(conn.writable).catch(() => {}),
          ]);
        } catch {
          try {
            conn.close();
          } catch { /* closed */ }
        }
      })());
    }
  })();
  try {
    await fn(socksPort, seen);
  } finally {
    listener.close();
    await accept.catch(() => {});
    await Promise.allSettled(pending);
    await http.shutdown();
  }
}

Deno.test("SOCKS5: remote DNS (domain ATYP) and per-isolation credentials", async () => {
  await withFakeSocks(async (socksPort, seen) => {
    const route = resolveRoute(`http://${XBT_ONION}/api`, { kind: "tor" }, false, {
      host: "127.0.0.1",
      port: socksPort,
    });
    const t = new RoutedTransport(route, "session1");
    const r1 = await t.request({
      url: `http://${XBT_ONION}/api/blocks/tip/height`,
      isolation: "xbt",
    });
    const r2 = await t.request({ url: `http://${XBT_ONION}/api/x`, isolation: "broadcast:abc" });
    assertEquals(r1.text(), "path=/api/blocks/tip/height");
    assertEquals(r2.status, 200);
    assertEquals(seen.length, 2);
    assertEquals(seen[0].atyp, 3);
    assertEquals(seen[0].host, XBT_ONION);
    assertEquals(seen[0].user, "forksplit:xbt:session1");
    assertEquals(seen[1].user, "forksplit:broadcast:abc:session1");
  });
});

Deno.test("Tor unreachable fails closed (no clearnet fallback)", async () => {
  // Grab a free port and close it so nothing listens there.
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  const route = resolveRoute("https://explorer.ecash.com/api", { kind: "tor" }, false, {
    host: "127.0.0.1",
    port,
  });
  await assertRejects(
    () =>
      new RoutedTransport(route).request({
        url: "https://explorer.ecash.com/api/x",
        isolation: "ecx",
      }),
    TorUnavailableError,
    "Refusing to fall back to clearnet",
  );
});
