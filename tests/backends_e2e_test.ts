/**
 * The risky end-to-end paths (broadcast, track, own spends, the TEST FIRST step) on every kind of
 * backend: Esplora and Electrum name the transaction that spent an output; node RPC never does,
 * and without txindex can't see a confirmed transaction at all.
 */
import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { spendReal } from "./fakes.ts";
import {
  BACKEND_KINDS,
  type BackendKind,
  drop,
  ecxTx,
  mine,
  progressOf,
  setup,
  signAll,
  type Tx1,
} from "./e2e.ts";

Deno.test("every backend: verify -> TEST FIRST -> the rest -> track deep", async () => {
  for (const kind of BACKEND_KINDS) {
    const s = await setup({ backend: kind });
    await signAll(s.planDir, s.plan);
    assertEquals(await s.run("verify", s.id), 0, `${kind}: ${s.err.join("\n")}`);
    assertEquals(await s.run("broadcast", s.id, "--yes"), 0, `${kind}: ${s.err.join("\n")}`);
    assertEquals(s.chains.ecx.broadcasts!.length, 1, kind);
    assertEquals(await s.run("track", s.id), 0, `${kind}: ${s.err.join("\n")}`);
    mine(s.chains.ecx);
    mine(s.chains.xbt);
    s.questions.length = 0;
    assertEquals(await s.run("broadcast", s.id, "--yes"), 0, `${kind}: ${s.err.join("\n")}`);
    assertEquals(s.chains.ecx.broadcasts!.length, 2, kind);
    assertEquals(s.chains.xbt.broadcasts!.length, 2, kind);
    mine(s.chains.ecx);
    mine(s.chains.xbt);
    s.out.length = 0;
    assertEquals(await s.run("track", s.id), 0, `${kind}: ${s.err.join("\n")}`);
    const p = await progressOf(s.planDir);
    const d = p.txs[ecxTx(s, 2).file].confirmations?.depth;
    assertEquals(d, 1, `${kind}: ${s.out.join("\n")}`);
    assert(s.contacted.length > 0);
  }
});

/** Writes a second plan for the same coins (all, or only `coins`), signed and verified. */
async function secondPlan(s: Awaited<ReturnType<typeof setup>>, coins: string[] = []) {
  assertEquals(
    await s.run(
      "plan",
      "--xbt-signer",
      "knots",
      "--fee-rate",
      "ecx=2,xbt=3",
      ...coins.flatMap((c) => ["--coin", c]),
      "--yes",
    ),
    0,
    s.err.join("\n"),
  );
  const ids: string[] = [];
  for await (const e of Deno.readDir(join(s.dir, "plans"))) ids.push(e.name);
  const id = ids.sort().find((x) => x !== s.id && !x.includes("bump"))!;
  const dir = join(s.dir, "plans", id);
  const plan = JSON.parse(await Deno.readTextFile(join(dir, "plan.json")));
  await signAll(dir, plan);
  assertEquals(await s.run("verify", id), 0, s.err.join("\n"));
  return { id, dir, plan };
}

/** Both plans sent; on ECX the second plan's splits got in instead of the first plan's. */
async function supersededOnEcx(kind: BackendKind) {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  const p2 = await secondPlan(s);
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, s.err.join("\n"));
  const first = (await progressOf(s.planDir)).txs;
  for (const t of s.plan.transactions.filter((t: Tx1) => t.chain === "ecx")) {
    drop(s.chains.ecx, first[t.file].verified!.txid);
  }
  assertEquals(await s.run("broadcast", p2.id, "--all", "--yes"), 0, s.err.join("\n"));
  mine(s.chains.ecx);
  mine(s.chains.xbt);
  if (kind !== "esplora") await s.useBackend(kind);
  return { s, p2 };
}

Deno.test("finding 1: superseded stays superseded on node RPC (with and without txindex); no false CONFLICT", async () => {
  for (const kind of BACKEND_KINDS) {
    // Recorded as superseded on Esplora, then followed on another backend (a switch, or a
    // fail-over to the next backend).
    const { s, p2 } = await supersededOnEcx("esplora");
    assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
    if (kind !== "esplora") await s.useBackend(kind);
    s.out.length = 0;
    s.err.length = 0;
    assertEquals(await s.run("track", s.id), 0, `${kind}: ${s.err.join("\n")}`);
    const out = s.out.join("\n");
    assert(!s.err.join("\n").includes("CONFLICT"), `${kind}: ${s.err.join("\n")}`);
    assert(!out.includes("no longer superseded"), `${kind}: ${out}`);
    assert(out.includes(`superseded by plan ${p2.id}`), `${kind}: ${out}`);
    for (const t of s.plan.transactions.filter((t: Tx1) => t.chain === "ecx")) {
      const p = (await progressOf(s.planDir)).txs[t.file];
      assertEquals(p.broadcast!.status, "superseded", `${kind} ${t.file}`);
      assertEquals(p.reorgs, undefined, `${kind} ${t.file}`);
    }
    // Nothing is sent again or marked in conflict by the next broadcast either.
    const n = s.chains.ecx.broadcasts!.length;
    assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, `${kind}: ${s.err}`);
    assertEquals(s.chains.ecx.broadcasts!.length, n, kind);
    for (const t of s.plan.transactions.filter((t: Tx1) => t.chain === "ecx")) {
      assertEquals(
        (await progressOf(s.planDir)).txs[t.file].broadcast!.status,
        "superseded",
        `${kind} ${t.file}`,
      );
    }
  }
});

Deno.test("finding 1: node RPC can't name the spender, but this tool's own spend is still recognised", async () => {
  // First look after the switch: Esplora/Electrum name the other plan's transaction; RPC with
  // txindex can't, so its transactions spending the same coin are looked up by txid. Without
  // txindex nothing can be seen about either: unknown, and no alarm.
  for (const kind of BACKEND_KINDS) {
    const { s, p2 } = await supersededOnEcx(kind);
    s.out.length = 0;
    s.err.length = 0;
    assertEquals(await s.run("track", s.id), 0, `${kind}: ${s.err.join("\n")}`);
    assert(!s.err.join("\n").includes("CONFLICT"), `${kind}: ${s.err.join("\n")}`);
    const status = (await progressOf(s.planDir)).txs[ecxTx(s, 1).file].broadcast!.status;
    if (kind === "rpc") assertEquals(status, "accepted", kind);
    else {
      assertEquals(status, "superseded", kind);
      assert(s.out.join("\n").includes(`superseded by plan ${p2.id}`), kind);
    }
  }
});

Deno.test("finding 6: broadcast after a lost reply records a send that got through, on every backend", async () => {
  for (const kind of BACKEND_KINDS) {
    const s = await setup();
    await signAll(s.planDir, s.plan);
    assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
    assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
    const test = s.plan.transactions.find((t: Tx1) => t.chain === "ecx" && t.testFirst);
    // The send's reply was lost: progress says unknown, but it got through and confirmed.
    const po = JSON.parse(await Deno.readTextFile(join(s.planDir, "progress.json")));
    po.txs[test.file].broadcast.status = "unknown";
    await Deno.writeTextFile(join(s.planDir, "progress.json"), JSON.stringify(po));
    mine(s.chains.ecx);
    mine(s.chains.xbt);
    if (kind !== "esplora") await s.useBackend(kind);
    const n = s.chains.ecx.broadcasts!.length;
    s.out.length = 0;
    s.err.length = 0;
    assertEquals(await s.run("broadcast", s.id, "--yes"), 0, `${kind}: ${s.err.join("\n")}`);
    const p = (await progressOf(s.planDir)).txs[test.file];
    assertEquals(p.broadcast!.status, "accepted", `${kind}: ${s.out.join("\n")}`);
    assertEquals(s.chains.ecx.broadcasts!.length, n + 1, `${kind}: the test itself not sent again`);
    const out = s.out.join("\n");
    assert(out.includes("already on chain"), `${kind}: ${out}`);
    // The test is found already confirmed, so the rest goes in the same run (--yes answers).
    assert(!out.includes("goes first, alone, in this run"), `${kind}: ${out}`);
    assert(out.includes("TEST FIRST: the test spend went through."), `${kind}: ${out}`);
    assertEquals(s.chains.ecx.broadcasts!.length, n + 1, kind);
  }
});

Deno.test("finding 6: node RPC without txindex that can't see the earlier send holds it, never a conflict", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const test = s.plan.transactions.find((t: Tx1) => t.chain === "ecx" && t.testFirst);
  const testId = s.chains.ecx.broadcasts![0].txid;
  const po = JSON.parse(await Deno.readTextFile(join(s.planDir, "progress.json")));
  po.txs[test.file].broadcast.status = "unknown";
  await Deno.writeTextFile(join(s.planDir, "progress.json"), JSON.stringify(po));
  mine(s.chains.ecx);
  // The destination wallet already moved the split's output: a node without txindex sees
  // nothing of the split at all now.
  spendReal(s.chains.ecx, testId, 0, s.chains.ecx.tip, 3);
  await s.useBackend("rpc");
  s.out.length = 0;
  // The test can't be seen, so --yes doesn't answer for the rest: held, with the reason.
  assertEquals(await s.run("broadcast", s.id, "--yes"), 1, s.err.join("\n"));
  const p = (await progressOf(s.planDir)).txs[test.file];
  assertEquals(p.broadcast!.status, "unknown");
  assert(s.out.join("\n").includes("this backend can't tell"), s.out.join("\n"));
  assert(s.out.join("\n").includes("--yes doesn't answer for ECX"), s.out.join("\n"));
  assertEquals(s.chains.ecx.broadcasts!.length, 1);
});

Deno.test("finding 3: a lagging server that shows the input spent by the split itself is no CONFLICT", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const test = s.plan.transactions.find((t: Tx1) => t.chain === "ecx" && t.testFirst);
  const testId = s.chains.ecx.broadcasts![0].txid;
  mine(s.chains.ecx);
  // The status lookup doesn't find the transaction (an index behind), but the input's spend
  // names it.
  s.chains.ecx.txs.delete(testId);
  s.err.length = 0;
  s.out.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assert(!s.err.join("\n").includes("CONFLICT"), s.err.join("\n"));
  const p = (await progressOf(s.planDir)).txs[test.file];
  assertEquals(p.broadcast!.status, "accepted");
  assertEquals(p.confirmations!.depth, 1);
});
