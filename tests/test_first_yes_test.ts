/**
 * `broadcast --yes` and the TEST FIRST question: --yes answers it only while the TEST FIRST spend
 * (or a fee bump of it) is confirmed or in the mempool. In every other state the rest is not
 * sent, and says why; answering the question yourself is still allowed (a soft gate), and --all
 * still sends everything.
 */
import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { spendReal } from "./fakes.ts";
import { drop, ecxTx, mine, progressOf, setup, signAll, type Tx1 } from "./e2e.ts";

type S = Awaited<ReturnType<typeof setup>>;

const testOf = (s: S) =>
  s.plan.transactions.find((t: Tx1) => t.chain === "ecx" && t.testFirst) as Tx1;

/** ECX #2 is held, not sent, with --yes; the reason names the TEST FIRST state. */
async function expectHeldByYes(s: S, state: string) {
  const n = s.chains.ecx.broadcasts?.length ?? 0;
  s.out.length = 0;
  s.questions.length = 0;
  assertEquals(await s.run("broadcast", s.id, "--yes"), 1, s.err.join("\n"));
  assertEquals(s.chains.ecx.broadcasts?.length ?? 0, n, `${state}: nothing more on ECX`);
  const out = s.out.join("\n");
  assert(out.includes("TEST FIRST: the test spend has NOT gone out on ECX"), `${state}: ${out}`);
  assert(out.includes("--yes doesn't answer for ECX"), `${state}: ${out}`);
  assert(
    out.includes(`ECX #2 (${ecxTx(s, 2).file}): not sent: --yes only answers once`),
    `${state}: ${out}`,
  );
  assert(out.includes(state), `${state}: ${out}`);
  assertEquals((await progressOf(s.planDir)).txs[ecxTx(s, 2).file].broadcast, undefined, state);
  // Asked without --yes, the question says plainly that no test is out, and recommends no.
  s.questions.length = 0;
  s.recommends.length = 0;
  s.answer.yes = false;
  assertEquals(await s.run("broadcast", s.id), 1);
  s.answer.yes = true;
  const q = s.questions.find((x) => x.includes("TEST FIRST"))!;
  assert(q.startsWith("The TEST FIRST transaction has NOT gone out on ECX"), `${state}: ${q}`);
  assert(q.includes("Answering no is recommended"), q);
  assert(q.includes("anyway, without a TEST FIRST spend on the network?"), q);
  assertEquals(s.recommends[s.questions.indexOf(q)], "no", state);
  assertEquals(s.chains.ecx.broadcasts?.length ?? 0, n);
  // It is a soft gate: answering yes yourself sends the rest.
  assertEquals(await s.run("broadcast", s.id), 0, s.err.join("\n"));
  assertEquals(s.chains.ecx.broadcasts!.length, n + 1, `${state}: yes sends the rest`);
}

async function verified(only?: (t: Tx1) => boolean) {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  const files = only
    ? s.plan.transactions.filter(only).map((t: Tx1) =>
      join(s.planDir, t.file.replace(/\.psbt$/u, ".signed.psbt"))
    )
    : [];
  assertEquals(await s.run("verify", s.id, ...files), 0, s.err.join("\n"));
  return s;
}

Deno.test("--yes with an unverified TEST FIRST: the rest is not sent", async () => {
  const s = await verified((t) => !(t.chain === "ecx" && t.testFirst));
  await expectHeldByYes(s, "isn't verified yet");
});

Deno.test("--yes with a rejected TEST FIRST: the rest is not sent", async () => {
  const s = await verified();
  s.chains.ecx.accept = () => "min relay fee not met";
  assertEquals(await s.run("broadcast", s.id, "--yes"), 1);
  assertEquals((await progressOf(s.planDir)).txs[testOf(s).file].broadcast!.status, "rejected");
  s.chains.ecx.accept = undefined;
  await expectHeldByYes(s, "was rejected by the server");
});

Deno.test("--yes with a TEST FIRST in conflict: the rest is not sent", async () => {
  const s = await verified();
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const old = s.chains.ecx.broadcasts![0].txid;
  drop(s.chains.ecx, old);
  const input = (testOf(s) as Tx1 & { inputs: { txid: string; vout: number }[] }).inputs[0];
  spendReal(s.chains.ecx, input.txid, input.vout, s.chains.ecx.tip, 7);
  assertEquals(await s.run("track", s.id), 1); // CONFLICT
  await expectHeldByYes(s, "is in conflict");
});

Deno.test("--yes with a TEST FIRST superseded by another plan: the rest is not sent", async () => {
  const s = await verified();
  const test = testOf(s) as Tx1 & { inputs: { txid: string; vout: number }[] };
  const coin = `${test.inputs[0].txid}:${test.inputs[0].vout}`;
  // Only the test's coin planned again, and that plan sent first.
  assertEquals(
    await s.run("plan", "--xbt-signer", "knots", "--coin", coin, "--yes"),
    0,
    s.err.join("\n"),
  );
  const ids: string[] = [];
  for await (const e of Deno.readDir(join(s.dir, "plans"))) ids.push(e.name);
  const p2 = ids.sort().find((x) => x !== s.id)!;
  const p2Dir = join(s.dir, "plans", p2);
  await signAll(p2Dir, JSON.parse(await Deno.readTextFile(join(p2Dir, "plan.json"))));
  assertEquals(await s.run("verify", p2), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", p2, "--all", "--yes"), 0, s.err.join("\n"));
  // First run: the TEST FIRST transaction finds its coin spent by that plan. It can't go out, so
  // the rest is asked about right away (with --yes: held), not left waiting for a second run.
  s.out.length = 0;
  assertEquals(await s.run("broadcast", s.id, "--yes"), 1, s.err.join("\n"));
  assertEquals((await progressOf(s.planDir)).txs[test.file].broadcast!.status, "superseded");
  const out = s.out.join("\n");
  assert(out.includes("TEST FIRST: the test spend has NOT gone out on ECX"), out);
  assert(out.includes(`was superseded by plan ${p2}`), out);
  assert(!out.includes("goes first, alone, in this run"), out);
  await expectHeldByYes(s, `was superseded by plan ${p2}`);
});

Deno.test("--yes with the TEST FIRST in the mempool or confirmed: the rest is sent", async () => {
  for (const state of ["mempool", "confirmed"]) {
    const s = await verified();
    assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
    if (state === "confirmed") {
      mine(s.chains.ecx);
      mine(s.chains.xbt);
    }
    s.out.length = 0;
    assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
    assertEquals(s.chains.ecx.broadcasts!.length, 2, state);
    assertEquals(s.chains.xbt.broadcasts!.length, 2, state);
    assert(!s.out.join("\n").includes("NOT gone out"), state);
    assertEquals(s.questions.length, 0, "--yes asked nothing");
  }
});

Deno.test("--all sends everything whatever state the TEST FIRST is in", async () => {
  const s = await verified((t) => !(t.chain === "ecx" && t.testFirst));
  assertEquals(await s.run("broadcast", s.id, "--all", "--yes"), 0, s.err.join("\n"));
  assertEquals(s.chains.ecx.broadcasts!.length, 1); // the other ECX transaction
  assertEquals(s.chains.xbt.broadcasts!.length, 2);
});
