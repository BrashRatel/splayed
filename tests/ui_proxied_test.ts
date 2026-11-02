import { assert, assertEquals } from "./assert.ts";
import { type CliIO, main } from "../src/cli/main.ts";
import { createToken, startUi, TokenThrottle } from "../src/ui/server.ts";

/** One raw HTTP/1.1 request, so the Host header can be anything. Returns the status code. */
async function raw(
  port: number,
  host: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = "",
): Promise<number> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    "Connection: close",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ...(body ? [`Content-Length: ${new TextEncoder().encode(body).length}`] : []),
    "",
    body,
  ];
  await conn.write(new TextEncoder().encode(lines.join("\r\n")));
  const buf = new Uint8Array(512);
  const n = await conn.read(buf);
  conn.close();
  const m = /^HTTP\/1\.1 (\d{3})/u.exec(new TextDecoder().decode(buf.subarray(0, n ?? 0)));
  return Number(m?.[1]);
}

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

const dataDir = await Deno.makeTempDir({ prefix: "splayed-proxied-" });
const baseIO = { env: {} };

Deno.test("proxied mode: refuses to start without allowed hosts or a token", () => {
  for (
    const opts of [
      { hostname: "0.0.0.0", token: createToken() },
      { hostname: "0.0.0.0", allowedHosts: ["splayed.local"] },
      { allowedHosts: ["splayed.local"] }, // proxied on loopback: still needs a token
    ]
  ) {
    let threw = false;
    try {
      startUi({ dataDir, run: main, baseIO, ...opts });
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(opts));
  }
});

Deno.test("proxied mode: answers only to allowed host names; Origin must be one of them", async () => {
  const port = freePort();
  const token = createToken();
  const ui = startUi({
    dataDir,
    run: main,
    baseIO,
    port,
    // Like nginx on this machine forwarding to 127.0.0.1 (the test may only use loopback).
    hostname: "127.0.0.1",
    allowedHosts: ["Splayed.local", `localhost:${port}`],
    token,
  });
  try {
    const auth = { Authorization: `Bearer ${token}` };
    assertEquals(await raw(port, "splayed.local", "GET", "/"), 200);
    assertEquals(await raw(port, `localhost:${port}`, "GET", "/api/overview", auth), 200);
    // Not listed: refused before anything else (DNS rebinding), even loopback names.
    assertEquals(await raw(port, "evil.example", "GET", "/"), 403);
    assertEquals(await raw(port, `127.0.0.1:${port}`, "GET", "/"), 403);
    assertEquals(await raw(port, "splayed.local:8443", "GET", "/"), 403);
    // Token still required.
    assertEquals(await raw(port, "splayed.local", "GET", "/api/overview"), 401);
    // Writes: Origin must be http(s):// plus the same allowed host.
    const post = (origin: string) =>
      raw(port, "splayed.local", "POST", "/api/run", {
        ...auth,
        "Content-Type": "application/json",
        Origin: origin,
      }, JSON.stringify({ args: ["status"] }));
    assertEquals(await post("https://evil.example"), 403);
    assertEquals(await post(`http://localhost:${port}`), 403); // a different allowed host
    const ok = await post("https://splayed.local");
    assert(ok === 200 || ok === 409, `status ${ok}`);
  } finally {
    await ui.server.shutdown();
  }
});

Deno.test("loopback mode without allowed hosts is unchanged", async () => {
  const ui = startUi({ dataDir, run: main, baseIO });
  try {
    assertEquals(await raw(ui.port, `127.0.0.1:${ui.port}`, "GET", "/"), 200);
    assertEquals(await raw(ui.port, `localhost:${ui.port}`, "GET", "/"), 200);
    assertEquals(await raw(ui.port, "splayed.local", "GET", "/"), 403);
  } finally {
    await ui.server.shutdown();
  }
});

Deno.test("TokenThrottle: 5 wrong tokens in a minute, then one attempt per 2 s, doubling to 60 s", () => {
  let now = 0;
  const t = new TokenThrottle(() => now);
  for (let i = 0; i < 4; i++) t.failed();
  assertEquals(t.waitMs(), 0);
  t.failed();
  assertEquals(t.waitMs(), 2000);
  now += 2000;
  assertEquals(t.waitMs(), 0);
  t.failed();
  assertEquals(t.waitMs(), 4000);
  for (let i = 0; i < 10; i++) {
    now += t.waitMs();
    t.failed();
  }
  assertEquals(t.waitMs(), 60_000);
  // A success resets it.
  now += 60_000;
  t.succeeded();
  t.failed();
  assertEquals(t.waitMs(), 0);
});

Deno.test("UI: wrong tokens are throttled with 429, and the right one still works after the wait", async () => {
  const ui = startUi({ dataDir, run: main, baseIO });
  try {
    const host = `127.0.0.1:${ui.port}`;
    for (let i = 0; i < 5; i++) {
      assertEquals(
        await raw(ui.port, host, "GET", "/api/overview", { Authorization: "Bearer x" }),
        401,
      );
    }
    assertEquals(
      await raw(ui.port, host, "GET", "/api/overview", { Authorization: `Bearer ${ui.token}` }),
      429,
    );
    await new Promise((r) => setTimeout(r, 2100));
    assertEquals(
      await raw(ui.port, host, "GET", "/api/overview", { Authorization: `Bearer ${ui.token}` }),
      200,
    );
  } finally {
    await ui.server.shutdown();
  }
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: () => true,
    env: {},
  };
  return { cli, text: () => [...out, ...err].join("\n") };
}

Deno.test("ui --new-token-file and token-file checks; proxied mode needs both flags", async () => {
  const dir = await Deno.makeTempDir({ prefix: "splayed-token-" });
  const file = `${dir}/ui-token`;
  const a = io();
  assertEquals(await main(["--data-dir", dir, "ui", "--new-token-file", file], a.cli), 0);
  const text = (await Deno.readTextFile(file)).trim();
  assert(/^[A-Za-z0-9_-]{43}$/u.test(text), text);
  if (Deno.build.os !== "windows") assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
  // A new one replaces it.
  assertEquals(await main(["--data-dir", dir, "ui", "--new-token-file", file], io().cli), 0);
  assert((await Deno.readTextFile(file)).trim() !== text);

  // Refusals (usage errors, before listening).
  const refuse = async (args: string[], expect: RegExp) => {
    const r = io();
    assertEquals(await main(["--data-dir", dir, "ui", ...args], r.cli), 2, r.text());
    assert(expect.test(r.text()), r.text());
  };
  await refuse(["--listen", "0.0.0.0:0", "--token-file", file], /--allowed-host/u);
  await refuse(["--listen", "0.0.0.0:0", "--allowed-host", "x.local"], /--token-file/u);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(file, 0o644);
    await refuse(
      ["--listen", "0.0.0.0:0", "--allowed-host", "x.local", "--token-file", file],
      /other users/u,
    );
  }
  const short = `${dir}/short`;
  await Deno.writeTextFile(short, "tooshort\n", { mode: 0o600 });
  await refuse(
    ["--listen", "0.0.0.0:0", "--allowed-host", "x.local", "--token-file", short],
    /32\+ characters/u,
  );
  await refuse(["--listen", "nonsense"], /HOST:PORT/u);
});
