/**
 * Alerts that settle or can be acknowledged (`track --ack`, archiving), a CONFLICT whose spend
 * left the chain, and the wording around fee bumps that lost the race.
 */
import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { fakeSend, spendReal } from "./fakes.ts";
import {
  backdateSends,
  type BackendKind,
  bumpAndSend,
  drop,
  mine,
  progressOf,
  sentTestFirst,
  type Tx1,
} from "./e2e.ts";

type Rec = { kind: string; resolved?: string; acknowledged?: string };
const recordsOf = async (dir: string, file: string) =>
  ((await progressOf(dir)).txs[file].reorgs ?? []) as Rec[];
const inputOf = (t: Tx1) => (t as Tx1 & { inputs: { txid: string; vout: number }[] }).inputs[0];

Deno.test("finding 4+5: a stranger's CONFLICT can be acknowledged; when that spend leaves the chain the split can be sent again", async () => {
  const { s, test, old } = await sentTestFirst();
  drop(s.chains.ecx, old);
  const input = inputOf(test);
  const stranger = spendReal(s.chains.ecx, input.txid, input.vout, undefined, 7);
  assertEquals(await s.run("track", s.id), 1);
  assert(s.err.join("\n").includes("track " + s.id + " --ack"), s.err.join("\n"));
  // It stays loud on every run until acknowledged...
  assertEquals(await s.run("track", s.id), 1);
  // ...and acknowledging asks first: "no" changes nothing.
  s.answer.yes = false;
  s.questions.length = 0;
  s.out.length = 0;
  assertEquals(await s.run("track", s.id, "--ack"), 1);
  assert(s.questions[0].startsWith(`Acknowledge 1 open alert(s) of plan ${s.id}?`), s.questions[0]);
  assert(s.questions[0].includes(`ECX ${test.file}: CONFLICT of`), s.questions[0]);
  assert(s.out.join("\n").includes("Nothing acknowledged."));
  s.answer.yes = true;
  s.out.length = 0;
  s.err.length = 0;
  assertEquals(await s.run("track", s.id, "--ack", "--yes"), 0, s.err.join("\n"));
  assert(s.out.join("\n").includes("Acknowledged 1 alert(s)."), s.out.join("\n"));
  assert(s.out.join("\n").includes("Acknowledged alert: ECX"), s.out.join("\n"));
  let recs = await recordsOf(s.planDir, test.file);
  assertEquals(recs.map((r) => r.kind), ["conflict"]);
  assert(recs[0].acknowledged && !recs[0].resolved);
  // Muted from now on: still shown, exit 0.
  s.out.length = 0;
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assert(s.out.join("\n").includes("(acknowledged"), s.out.join("\n"));
  assertEquals((await progressOf(s.planDir)).txs[test.file].broadcast!.status, "conflict");

  // Finding 5: the stranger's spend falls out of the mempool. The coin is shared again: a new,
  // loud alert, the conflict is over, and the split may be sent again.
  drop(s.chains.ecx, stranger);
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 1);
  const err = s.err.join("\n");
  assert(
    err.includes(`ECX ${test.file}: DROPPED: The transaction that spent this split's input`),
    err,
  );
  assert(err.includes("has left the chain and the mempool"), err);
  let p = (await progressOf(s.planDir)).txs[test.file];
  assertEquals(p.broadcast!.status, "unknown");
  recs = await recordsOf(s.planDir, test.file);
  assertEquals(recs.map((r) => r.kind), ["conflict", "evicted"]);
  assert(recs[0].resolved, "the conflict is over");
  // Repeats, recorded once.
  assertEquals(await s.run("track", s.id), 1);
  assertEquals((await recordsOf(s.planDir, test.file)).length, 2);
  // Broadcast verified sends it again, with its checks.
  const n = s.chains.ecx.broadcasts!.length;
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals(s.chains.ecx.broadcasts!.length, n + 1);
  assertEquals(s.chains.ecx.broadcasts!.at(-1)!.txid, old);
  p = (await progressOf(s.planDir)).txs[test.file];
  assertEquals(p.broadcast!.status, "accepted");
  // Deep: resolved, and track is quiet.
  mine(s.chains.ecx);
  mine(s.chains.xbt);
  s.chains.ecx.tip += 59;
  s.chains.xbt.tip += 59;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assert((await recordsOf(s.planDir, test.file)).every((r) => r.resolved));
});

Deno.test("finding 4: archiving a plan acknowledges its open alerts", async () => {
  const { s, test, old } = await sentTestFirst();
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n")); // seen in the mempool
  drop(s.chains.ecx, old);
  await backdateSends(s.planDir);
  assertEquals(await s.run("track", s.id), 1); // DROPPED
  s.out.length = 0;
  assertEquals(await s.run("plans", "archive", s.id), 0, s.err.join("\n"));
  assert(s.out.join("\n").includes("1 open alert(s) of this plan acknowledged"), s.out.join("\n"));
  const recs = await recordsOf(s.planDir, test.file);
  assert(recs[0].acknowledged && !recs[0].resolved);
  s.out.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assert(s.out.join("\n").includes("Acknowledged alert: ECX"), s.out.join("\n"));
  // Sent again and dropped again: a new drop is loud again.
  assertEquals(await s.run("plans", "unarchive", s.id), 0);
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n")); // in the mempool: muted
  drop(s.chains.ecx, old);
  assertEquals(await s.run("track", s.id), 1);
});

/** Bump sent, then the original won instead (the bump fell out, the original came back). */
async function originalBack(confirm: boolean) {
  const { s, test, old } = await sentTestFirst();
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  const b = await bumpAndSend(s, s.id, 9, old);
  assertEquals((await progressOf(s.planDir)).txs[test.file].broadcast!.status, "replaced");
  drop(s.chains.ecx, b.txid);
  const hex = JSON.parse(await Deno.readTextFile(join(s.planDir, "progress.json")))
    .txs[test.file].verified.finalHex;
  assertEquals(fakeSend(s.chains.ecx, hex, "test").txid, old);
  if (confirm) {
    mine(s.chains.ecx);
    mine(s.chains.xbt);
  }
  return { s, test, old, b };
}

Deno.test("finding 4: the original confirming instead of its fee bump is settled once, not an alert forever", async () => {
  const { s, test, old, b } = await originalBack(true);
  s.out.length = 0;
  s.err.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  const out = s.out.join("\n");
  assert(out.includes(`the original confirmed even though plan ${b.bumpId}`), out);
  const p = (await progressOf(s.planDir)).txs[test.file];
  assertEquals(p.broadcast!.status, "accepted");
  assertEquals(p.replacedBy, undefined);
  assertEquals(p.confirmations!.depth, 1);
  // The bump plan's transaction is superseded by the original, consistently.
  const bumpPlan = JSON.parse(await Deno.readTextFile(join(b.bumpDir, "plan.json")));
  const bp = (await progressOf(b.bumpDir)).txs[bumpPlan.transactions[0].file] as {
    broadcast?: { status: string };
    supersededBy?: { plan: string; txid: string };
  };
  assertEquals(bp.broadcast!.status, "superseded");
  assertEquals(bp.supersededBy!.plan, s.id);
  assertEquals(bp.supersededBy!.txid, old);
  // Quiet from now on, on both plans; deep, the bump plan can be deleted.
  s.out.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  assert(!s.out.join("\n").includes("the original confirmed"), s.out.join("\n"));
  s.out.length = 0;
  assertEquals(await s.run("track", b.bumpId), 0, s.err.join("\n"));
  assert(s.out.join("\n").includes(`superseded by plan ${s.id}`), s.out.join("\n"));
  s.chains.ecx.tip += 60;
  s.chains.xbt.tip += 60;
  assertEquals(await s.run("track", b.bumpId), 0, s.err.join("\n"));
  assertEquals(await s.run("plans", "delete", b.bumpId, "--yes"), 0, s.err.join("\n"));
});

Deno.test("finding 7c: a replaced original back in the mempool is described as itself", async () => {
  const { s, b } = await originalBack(false);
  s.out.length = 0;
  assertEquals(await s.run("track", s.id), 0, s.err.join("\n"));
  const out = s.out.join("\n");
  assert(!out.includes(`the coin was then spent by plan ${s.id}`), out);
  assert(out.includes(`back instead of its replacement (plan ${b.bumpId})`), out);
  assert(out.includes("Whichever confirms first stands"), out);
});

Deno.test("finding 7b: broadcast's recheck recognises the original's own unrecorded fee bump", async () => {
  // RPC without txindex can see neither; the others name the spender or find it by txid.
  for (const kind of ["esplora", "electrum", "rpc-txindex"] as BackendKind[]) {
    const { s, test, old } = await sentTestFirst();
    const b = await bumpAndSend(s, s.id, 9, old);
    // Its reply was lost: the original knows nothing of it.
    const po = JSON.parse(await Deno.readTextFile(join(s.planDir, "progress.json")));
    delete po.txs[test.file].replacedBy;
    po.txs[test.file].broadcast.status = "accepted";
    await Deno.writeTextFile(join(s.planDir, "progress.json"), JSON.stringify(po));
    mine(s.chains.ecx);
    mine(s.chains.xbt);
    if (kind !== "esplora") await s.useBackend(kind);
    s.out.length = 0;
    s.questions.length = 0;
    assertEquals(await s.run("broadcast", s.id), 0, `${kind}: ${s.err.join("\n")}`);
    const p = (await progressOf(s.planDir)).txs[test.file];
    assertEquals(p.replacedBy?.plan, b.bumpId, `${kind}: ${s.out.join("\n")}`);
    assertEquals(p.broadcast!.status, "replaced", kind);
    assert(!s.out.join("\n").includes("not by this split"), `${kind}: ${s.out.join("\n")}`);
    assert(
      s.questions[0].includes(`was replaced by plan ${b.bumpId}, which is confirmed`),
      `${kind}: ${s.questions[0]}`,
    );
  }
});

Deno.test("finding 5: a split in conflict whose conflicting spend left the chain is flagged and can be sent again", async () => {
  for (const kind of ["esplora", "electrum", "rpc", "rpc-txindex"] as BackendKind[]) {
    const { s, test, old } = await sentTestFirst();
    drop(s.chains.ecx, old);
    const input = inputOf(test);
    const stranger = spendReal(s.chains.ecx, input.txid, input.vout, undefined, 7);
    if (kind !== "esplora") await s.useBackend(kind);
    // RPC can't see an unconfirmed stranger's spend as a conflict by itself: mark it as an earlier
    // run (on another backend) would have.
    if (kind === "esplora") assertEquals(await s.run("track", s.id), 1);
    else {
      const po = JSON.parse(await Deno.readTextFile(join(s.planDir, "progress.json")));
      po.txs[test.file].broadcast.status = "conflict";
      await Deno.writeTextFile(join(s.planDir, "progress.json"), JSON.stringify(po));
    }
    drop(s.chains.ecx, stranger);
    s.err.length = 0;
    assertEquals(await s.run("track", s.id), 1, kind);
    assert(s.err.join("\n").includes("has left the chain and the mempool"), `${kind}: ${s.err}`);
    assertEquals((await progressOf(s.planDir)).txs[test.file].broadcast!.status, "unknown", kind);
    const n = s.chains.ecx.broadcasts!.length;
    assertEquals(await s.run("broadcast", s.id, "--yes"), 0, `${kind}: ${s.err.join("\n")}`);
    assertEquals(s.chains.ecx.broadcasts!.length, n + 1, kind);
  }
});

Deno.test("track --ack --yes never mutes an alert first raised by the same run", async () => {
  const { s, test, old } = await sentTestFirst();
  drop(s.chains.ecx, old);
  const input = inputOf(test);
  spendReal(s.chains.ecx, input.txid, input.vout, undefined, 7);
  // The CONFLICT is first seen by this --ack run: it isn't acknowledged, and track exits 1.
  s.out.length = 0;
  assertEquals(await s.run("track", s.id, "--ack", "--yes"), 1, s.err.join("\n"));
  assert(s.out.join("\n").includes("first raised by this run"), s.out.join("\n"));
  let recs = await recordsOf(s.planDir, test.file);
  assertEquals(recs.map((r) => r.kind), ["conflict"]);
  assert(!recs[0].acknowledged);
  // Once it has been shown, a later --ack can acknowledge it, however close in time the runs are:
  // "earlier" means already on record, not an older clock reading. (It once compared timestamps,
  // which failed in CI when two runs started within the same millisecond.) A record stamped in the
  // future is the same case, made certain.
  const po = JSON.parse(await Deno.readTextFile(join(s.planDir, "progress.json")));
  po.txs[test.file].reorgs[0].at = "2099-01-01T00:00:00.000Z";
  await Deno.writeTextFile(join(s.planDir, "progress.json"), JSON.stringify(po));
  assertEquals(await s.run("track", s.id, "--ack", "--yes"), 0, s.err.join("\n"));
  recs = await recordsOf(s.planDir, test.file);
  assertEquals(recs.length, 1);
  assert(recs[0].acknowledged);
});
