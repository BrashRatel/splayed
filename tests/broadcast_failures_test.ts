/**
 * What a failed broadcast means. Only the server's own refusal of the transaction is "rejected"
 * (and stops `broadcast` from sending it again); a gateway error, a timeout or a node that is
 * still starting says nothing about it, so it is "unknown": the next `broadcast` asks the chain
 * first, and sends again only if the transaction isn't there.
 */
import { assert, assertEquals } from "./assert.ts";
import { BackendError, isExplicitRejection } from "../src/backends/types.ts";
import { progressOf, setup, signAll, type Tx1 } from "./e2e.ts";

Deno.test("isExplicitRejection: only the server's own refusal counts", () => {
  const rpc = (status: number, code: number) =>
    Object.assign(new BackendError("RPC", status), { rpcCode: code });
  // Esplora: the node's refusal is HTTP 400; gateway, server, login and rate-limit errors aren't.
  assertEquals(isExplicitRejection(new BackendError("x", 400)), true);
  for (const status of [401, 403, 404, 408, 413, 429, 500, 502, 503, 504]) {
    assertEquals(isExplicitRejection(new BackendError("x", status)), false, `HTTP ${status}`);
  }
  // Node RPC: HTTP 500 with the node's own error is a refusal; "warming up" and co. are not.
  assertEquals(isExplicitRejection(rpc(500, -26)), true);
  assertEquals(isExplicitRejection(rpc(500, -25)), true);
  for (const code of [-28, -10, -9]) {
    assertEquals(isExplicitRejection(rpc(500, code)), false, `RPC ${code}`);
  }
  // Electrum error reply (status -1), and failures with no status at all (timeouts, no route).
  assertEquals(isExplicitRejection(new BackendError("x", -1)), true);
  assertEquals(isExplicitRejection(new BackendError("timed out")), false);
  assertEquals(isExplicitRejection(new Error("boom")), false);
});

const testTx = (s: Awaited<ReturnType<typeof setup>>) =>
  s.plan.transactions.find((t: Tx1) => t.chain === "ecx" && t.testFirst) as Tx1;

async function verified() {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  return s;
}

Deno.test("a 502 that hid a relayed send: unknown, then found in the mempool, never sent twice", async () => {
  const s = await verified();
  s.chains.ecx.broadcastFailure = { status: 502, relayed: true };
  s.err.length = 0;
  assertEquals(await s.run("broadcast", s.id, "--yes"), 1);
  const p = (await progressOf(s.planDir)).txs[testTx(s).file];
  assertEquals(p.broadcast!.status, "unknown", s.err.join("\n"));
  assert(s.err.join("\n").includes("result unknown"), s.err.join("\n"));
  assertEquals(s.chains.ecx.broadcasts!.length, 1); // it really did get out
  // Next run: the chain is asked first, the transaction is there, nothing is sent again.
  s.chains.ecx.broadcastFailure = undefined;
  s.out.length = 0;
  await s.run("broadcast", s.id, "--yes");
  const txid = (await progressOf(s.planDir)).txs[testTx(s).file].verified!.txid;
  // (The rest of the chain is released now that the test is on the network: other transactions.)
  assertEquals(
    s.chains.ecx.broadcasts!.filter((b) => b.txid === txid).length,
    1,
    "the test transaction itself is not sent again",
  );
  const after = (await progressOf(s.planDir)).txs[testTx(s).file];
  assertEquals(after.broadcast!.status, "accepted", s.out.join("\n"));
});

Deno.test("a 503 that relayed nothing: unknown, and the next broadcast sends it", async () => {
  const s = await verified();
  s.chains.ecx.broadcastFailure = { status: 503 };
  assertEquals(await s.run("broadcast", s.id, "--yes"), 1);
  assertEquals((await progressOf(s.planDir)).txs[testTx(s).file].broadcast!.status, "unknown");
  s.chains.ecx.broadcastFailure = undefined;
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals((await progressOf(s.planDir)).txs[testTx(s).file].broadcast!.status, "accepted");
  assertEquals(s.chains.ecx.broadcasts!.length, 1);
});

Deno.test("a node still starting (RPC -28) is unknown, not a refusal", async () => {
  const s = await verified();
  await s.useBackend("rpc");
  s.chains.ecx.broadcastFailure = { status: 500 };
  assertEquals(await s.run("broadcast", s.id, "--yes"), 1);
  assertEquals((await progressOf(s.planDir)).txs[testTx(s).file].broadcast!.status, "unknown");
});

Deno.test("the server's own refusal (HTTP 400) is still 'rejected' and not sent again", async () => {
  const s = await verified();
  s.chains.ecx.accept = () => "min relay fee not met";
  assertEquals(await s.run("broadcast", s.id, "--yes"), 1);
  assertEquals((await progressOf(s.planDir)).txs[testTx(s).file].broadcast!.status, "rejected");
});
