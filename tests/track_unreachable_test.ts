/**
 * `track` is the safety net for reorgs, drops and conflicts, so it must never look like a success
 * when it couldn't look: a chain with no reachable, identity-checked backend is reported and makes
 * the run exit 1, like a failed lookup does.
 */
import { assert, assertEquals } from "./assert.ts";
import { progressOf, setup, signAll } from "./e2e.ts";

Deno.test("track with no usable backend for a chain says so and exits 1", async () => {
  const s = await setup();
  await signAll(s.planDir, s.plan);
  assertEquals(await s.run("verify", s.id), 0, s.err.join("\n"));
  assertEquals(await s.run("broadcast", s.id, "--yes"), 0, s.err.join("\n"));
  const ecxOnly = async () =>
    JSON.stringify(
      Object.entries((await progressOf(s.planDir)).txs).filter(([file]) => file.startsWith("ecx/")),
    );
  const before = await ecxOnly();
  // Every request to ECX now fails: no backend passes the identity check.
  s.chains.ecx.fail = /./u;
  s.out.length = 0;
  s.err.length = 0;
  const code = await s.run("track", s.id);
  const text = s.out.join("\n") + "\n" + s.err.join("\n");
  assertEquals(code, 1, text);
  assert(/ECX.*(no (reachable|usable|verified) backend|couldn't be checked)/su.test(text), text);
  assert(!text.includes("When every split is deep enough"), text);
  // Nothing recorded for ECX on the strength of a look that never happened.
  assertEquals(await ecxOnly(), before);
});
