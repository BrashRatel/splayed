import { assert, assertEquals } from "./assert.ts";
import { join } from "node:path";
import { type CliIO, main } from "../src/cli/main.ts";
import { protectedTxids } from "../src/core/donors.ts";

const ID = "20261101T120000000-abc123";

function io(answer = true) {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const cli: CliIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: (q) => {
      questions.push(q);
      return answer;
    },
    env: {},
  };
  return { cli, out, err, questions, text: () => [...out, ...err].join("\n") };
}

/** A minimal plan folder: what the admin commands and donor rules read. */
async function writePlan(
  dataDir: string,
  id: string,
  txs: { chain: string; file: string; replaces?: unknown }[],
  progress: Record<string, unknown> = {},
) {
  const dir = join(dataDir, "plans", id);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "plan.json"),
    JSON.stringify({ id, createdAt: "2026-11-01T12:00:00.000Z", transactions: txs }),
  );
  await Deno.writeTextFile(
    join(dir, "progress.json"),
    JSON.stringify({ version: 1, txs: progress }),
  );
  return dir;
}

const exists = async (p: string) => {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test("plans archive / unarchive keep the folder and move it between list sections", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const dir = await writePlan(dataDir, ID, [{ chain: "ecx", file: "ecx/001-aaaa.psbt" }]);
  const a = io();
  assertEquals(await main(["--data-dir", dataDir, "plans", "archive", ID], a.cli), 0);
  assert(await exists(join(dir, "plan.json")), "folder kept");
  assert(await exists(join(dir, "archived.json")));

  const list = io();
  assertEquals(await main(["--data-dir", dataDir, "plans"], list.cli), 0);
  assert(list.text().includes("Archived (1):"));
  assert(list.text().includes(`  ${ID}`));

  // Archiving twice is an error; unarchive brings it back.
  assertEquals(await main(["--data-dir", dataDir, "plans", "archive", ID], io().cli), 1);
  assertEquals(await main(["--data-dir", dataDir, "plans", "unarchive", ID], io().cli), 0);
  assertEquals(await exists(join(dir, "archived.json")), false);
  const again = io();
  await main(["--data-dir", dataDir, "plans"], again.cli);
  assertEquals(again.text().includes("Archived"), false);
});

Deno.test("plans delete: refused while a sent transaction isn't confirmed deep enough", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const dir = await writePlan(dataDir, ID, [{ chain: "ecx", file: "ecx/001-aaaa.psbt" }], {
    "ecx/001-aaaa.psbt": {
      broadcast: { status: "accepted", at: "x", backend: "b", attempts: 1 },
      confirmations: { depth: 12, at: "x" },
    },
  });
  const r = io();
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID, "--yes"], r.cli), 1);
  assert(r.text().includes("aren't confirmed yet"), r.text());
  assert(r.text().includes("12 of 50 confirmations"), r.text()); // ECX default is 50
  assertEquals(r.questions.length, 0, "refuses before asking");
  assert(await exists(dir));
});

Deno.test("plans delete: a fee-bumped original never settles, so it's kept", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  await writePlan(dataDir, ID, [{ chain: "xbt", file: "xbt/001-bbbb.psbt" }], {
    "xbt/001-bbbb.psbt": {
      broadcast: { status: "replaced", at: "x", backend: "b", attempts: 1 },
      replacedBy: { plan: `${ID}-bump1`, file: "xbt/001-cccc.psbt" },
    },
  });
  const r = io();
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID, "--yes"], r.cli), 1);
  assert(r.text().includes("replaced by plan"), r.text());
});

Deno.test("plans delete: asks first, notes what is lost, and deletes once confirmed deep", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const dir = await writePlan(dataDir, ID, [
    { chain: "ecx", file: "ecx/001-aaaa.psbt" },
    { chain: "xbt", file: "xbt/001-bbbb.psbt" },
  ], {
    "ecx/001-aaaa.psbt": {
      verified: { at: "x", txid: "aa".repeat(32), finalHex: "00", checks: [] },
      broadcast: { status: "accepted", at: "x", backend: "b", attempts: 1 },
      confirmations: { depth: 60, at: "x" },
    },
    // Refused by every backend and never seen: nothing to follow up.
    "xbt/001-bbbb.psbt": { broadcast: { status: "rejected", at: "x", backend: "b", attempts: 1 } },
  });
  const declined = io(false);
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID], declined.cli), 1);
  assertEquals(declined.questions.length, 1);
  assert(declined.text().includes("donors may stop qualifying"), declined.text());
  assert(await exists(dir), "kept after declining");

  const yes = io(true);
  assertEquals(await main(["--data-dir", dataDir, "plans", "delete", ID], yes.cli), 0);
  assertEquals(await exists(dir), false);
});

Deno.test("plans delete/archive refuse anything that isn't a plan id", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  // A plan-looking folder outside the plans directory must never be touched.
  const outside = await Deno.makeTempDir({ prefix: "splayed-outside-" });
  await Deno.writeTextFile(join(outside, "plan.json"), JSON.stringify({ transactions: [] }));
  for (const bad of [outside, "../outside", "a/b", ".hidden", ""]) {
    for (const action of ["delete", "archive"]) {
      const r = io();
      const code = await main(["--data-dir", dataDir, "plans", action, bad, "--yes"], r.cli);
      assert(code !== 0, `${action} ${bad}`);
    }
  }
  assert(await exists(join(outside, "plan.json")));
  // Unknown id.
  const r = io();
  assertEquals(
    await main(["--data-dir", dataDir, "plans", "delete", "nope-123", "--yes"], r.cli),
    1,
  );
  assert(r.text().includes('No plan "nope-123"'));
});

Deno.test("archived plans still count for the donor rules", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-plans-" });
  const txid = "ab".repeat(32);
  // Ungated and accepted: its outputs are XBT-only, which is what the donor rules look for.
  await writePlan(dataDir, ID, [{ chain: "xbt", file: "xbt/001-abab.psbt" }], {
    "xbt/001-abab.psbt": {
      verified: { at: "x", txid, finalHex: "00", checks: [] },
      broadcast: { status: "accepted", at: "x", backend: "b", attempts: 1 },
    },
  });
  const before = await protectedTxids(dataDir, "xbt");
  assertEquals([...before], [txid]);
  assertEquals(await main(["--data-dir", dataDir, "plans", "archive", ID], io().cli), 0);
  assertEquals(await protectedTxids(dataDir, "xbt"), before);
});
