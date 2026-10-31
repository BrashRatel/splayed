// A stand-in for the tor binary: reads SocksPort from -f <torrc>, "bootstraps", then answers
// SOCKS5 greetings until killed. FAKE_TOR_MODE=error makes it fail like a bad config.
const rc = await Deno.readTextFile(Deno.args[Deno.args.indexOf("-f") + 1]);
const port = Number(/SocksPort 127\.0\.0\.1:(\d+)/.exec(rc)![1]);
if (Deno.env.get("FAKE_TOR_MODE") === "error") {
  console.log("Oct 31 12:00:00.000 [err] Reading config failed--see warnings above.");
  Deno.exit(1);
}
const listener = Deno.listen({ hostname: "127.0.0.1", port });
console.log("Oct 31 12:00:00.000 [notice] Bootstrapped 0% (starting): Starting");
console.log(
  "Oct 31 12:00:00.100 [notice] Bootstrapped 50% (loading_descriptors): Loading relay descriptors",
);
console.log("Oct 31 12:00:00.200 [notice] Bootstrapped 100% (done): Done");
for await (const conn of listener) {
  (async () => {
    const buf = new Uint8Array(16);
    await conn.read(buf);
    await conn.write(Uint8Array.of(5, 2));
    conn.close();
  })().catch(() => {});
}
