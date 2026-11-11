// Regenerates the screenshots in docs/images/web-ui/ by driving the real web UI against in-memory
// test chains (the same fakes as `deno task demo-ui`). See docs/dev/docs-screenshots.md.
//
//   deno run -A --no-lock scripts/docs_screenshots.ts [output-dir]
//
// Playwright is loaded at run time (not a project dependency) and pinned to PLAYWRIGHT below, so
// the browser it expects is known. Install that browser once with
// `deno run -A npm:playwright@1.64.1 install chromium`, or point SPLAYED_SHOTS_CHROMIUM at a
// Chromium binary you already have.
// deno-lint-ignore-file no-explicit-any
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer";
import { type CliIO, main } from "../src/cli/main.ts";
import { concatBytes, fromHex, toHex } from "../src/core/bytes.ts";
import { parseDescriptor } from "../src/core/descriptors.ts";
import {
  decodePsbt,
  encodePsbtBase64,
  findValues,
  IN_BIP32_DERIVATION,
  IN_WITNESS_UTXO,
  kv,
} from "../src/core/psbt.ts";
import { unifiedSignatureHash } from "../src/core/unified_sighash.ts";
import { startUi } from "../src/ui/server.ts";
import { fakeChain, FakeEsploraTransport, fund } from "../tests/fakes.ts";

/** Pinned: each Playwright release drives one browser build. Keep in step with the docs. */
const PLAYWRIGHT = "npm:playwright@1.64.1";
const OUT = Deno.args[0] ?? "docs/images/web-ui";
await Deno.mkdir(OUT, { recursive: true });
const seed = (w: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(w));
const S = seed(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const O = seed("legal winner thank year wave sausage worth useful legal winner thank yellow");
const fp = (k: HDKey) => k.fingerprint.toString(16).padStart(8, "0");
const SRC = `wpkh([${fp(S)}/84h/0h/0h]${S.derive("m/84'/0'/0'").publicExtendedKey}/<0;1>/*)`;
const ECX_DEST = `wpkh([${fp(O)}/84h/0h/0h]${O.derive("m/84'/0'/0'").publicExtendedKey}/0/*)`;
const XBT_DEST = `tr([${fp(O)}/86h/0h/0h]${O.derive("m/86'/0'/0'").publicExtendedKey}/0/*)`;
const src = parseDescriptor(SRC);
const privFor = new Map<string, Uint8Array>([0, 1, 2, 3].map((i) => {
  const k = S.derive(`m/84'/0'/0'/0/${i}`);
  return [toHex(k.publicKey!), k.privateKey!];
}));
function stockSign(b64: string): string {
  const tx = Transaction.fromPSBT(Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0)));
  for (let i = 0; i < tx.inputsLength; i++) {
    for (const [pub, priv] of privFor) {
      if (tx.getInput(i).bip32Derivation?.some(([p]) => toHex(p) === pub)) tx.signIdx(priv, i);
    }
  }
  return btoa(String.fromCharCode(...tx.toPSBT()));
}
function unifiedSign(b64: string): string {
  const hashType = 0x21;
  const psbt = decodePsbt(b64);
  const spent = psbt.inputs.map((m) => {
    const v = findValues(m, IN_WITNESS_UTXO)[0].value;
    return {
      amount: new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true),
      script: v.slice(9),
    };
  });
  const utx = {
    version: psbt.tx.version,
    lockTime: psbt.tx.lockTime,
    inputs: psbt.tx.inputs.map((i) => ({
      txid: fromHex(i.txid),
      index: i.vout,
      sequence: i.sequence,
    })),
    outputs: psbt.tx.outputs.map((o) => ({ amount: o.value, script: o.script })),
  };
  psbt.inputs.forEach((m, i) => {
    const pub = findValues(m, IN_BIP32_DERIVATION)[0].key.slice(1);
    const code = concatBytes(
      Uint8Array.of(0x76, 0xa9, 0x14),
      spent[i].script.slice(2),
      Uint8Array.of(0x88, 0xac),
    );
    const digest = unifiedSignatureHash(utx, i, hashType, spent, {
      scriptType: 1,
      scriptCode: code,
    })!;
    const der = secp256k1.sign(digest, privFor.get(toHex(pub))!, {
      prehash: false,
      format: "der",
      lowS: true,
    });
    m.push(kv(0x02, pub, concatBytes(der, Uint8Array.of(hashType))));
  });
  return encodePsbtBase64(psbt);
}

const btc = fakeChain("btc", 975_000),
  xbt = fakeChain("xbt", 970_000),
  ecx = fakeChain("ecx", 974_500);
const all = [btc, xbt, ecx];
[100_000, 250_000, 1_200_000].forEach((v, i) =>
  fund(all, [{ ...src.branches[0].derive(i), value: v }], 900_000 + i, i + 1)
);
const chains = { btc, xbt, ecx } as const;
const dir = await Deno.makeTempDir();
// Default scan settings (gap limit 20, jitter 150-900 ms), so the Scan settings card shows what a
// new install shows; the jitter makes each scan take about a minute here.
await Deno.writeTextFile(`${dir}/splayed.toml`, "");
/** Delay per backend request, to catch a progress box while a command runs. */
let slowMs = 0;
const io = {
  out: () => {},
  err: () => {},
  confirm: () => true,
  env: {},
  tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
  transportFactory: (_c: unknown, chain: "btc" | "xbt" | "ecx") => {
    const inner = new FakeEsploraTransport(chains[chain]);
    return {
      route: inner.route,
      request: async (spec: any) => {
        if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
        return inner.request(spec);
      },
    };
  },
} as unknown as CliIO;
const { out: _o, err: _e, confirm: _c, ...baseIO } = io;
const TOKEN = "shots-token-shots-token-shots-token-shots-t";
const ui = startUi({ dataDir: dir, run: main, baseIO, port: 8766, token: TOKEN });

const { chromium } = await import(PLAYWRIGHT);
type Page = any;
type Locator = any;
// SPLAYED_SHOTS_CHROMIUM: a Chromium (or chrome-headless-shell) binary to use instead of the one
// `playwright install` puts in Playwright's cache, e.g. when that one can't be downloaded.
const executablePath = Deno.env.get("SPLAYED_SHOTS_CHROMIUM") || undefined;
const browser = await chromium.launch({ executablePath });
const VIEWPORT = { width: 1280, height: 800 };
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const page: Page = await ctx.newPage();
await page.goto(`http://127.0.0.1:8766/#token=${TOKEN}`);
await page.waitForSelector("#view *");
let n = 0;
/** The whole page (full = true) or what is in the window. */
async function shot(name: string, full = true) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
  n++;
}
/** One element (a card) only. */
async function shotOf(name: string, loc: Locator) {
  await page.waitForTimeout(500);
  await loc.scrollIntoViewIfNeeded();
  await loc.screenshot({ path: join(OUT, `${name}.png`) });
  n++;
}
/** The top of the window down to the bottom of `loc` (header, tabs and that element). */
async function shotDownTo(name: string, loc: Locator) {
  await page.waitForTimeout(500);
  const box = await loc.boundingBox();
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.ceil(box.y + box.height + 16) },
  });
  n++;
}
/** A dialog overlay: the window grows to fit it, so nothing is cut off. */
async function shotDialog(name: string, box: Locator) {
  await page.waitForTimeout(500);
  const b = await box.boundingBox();
  const height = Math.max(VIEWPORT.height, Math.ceil(b.y + b.height + 40));
  await page.setViewportSize({ width: VIEWPORT.width, height });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.setViewportSize(VIEWPORT);
  n++;
}
/** The card whose heading starts with `title`. */
function card(title: string): Locator {
  return page.locator(".card", { has: page.locator("h2", { hasText: title }) });
}
async function tab(t: string) {
  await page.click(`#tabs button[data-tab=${t}]`);
  await page.waitForTimeout(500);
}
// Page-side checks. Passed as functions, not strings (the UI's CSP forbids eval), and run in the
// page, so each one is self-contained.
const pageState = (want: "idle" | "busy" | "asked-or-idle") => {
  const d = (globalThis as any).document;
  const idle = /^idle/i.test(d.querySelector("#job-state")?.textContent?.trim() ?? "");
  const asked = !!d.querySelector("#modal:not(.hidden)");
  return want === "idle" ? idle : want === "busy" ? !idle : asked || idle;
};
async function idle() {
  await page.waitForFunction(pageState, "idle", { timeout: 180_000 });
  await page.waitForTimeout(600);
}
/** Answers question dialogs with Yes until the command ends (photographing the first). */
async function answerYes(firstShot?: string) {
  // The command may not have started yet (or may already be done).
  await page.waitForFunction(pageState, "busy", { timeout: 3000 }).catch(() => {});
  for (let i = 0; i < 8; i++) {
    // Either a question is up or the command has finished.
    await page.waitForFunction(pageState, "asked-or-idle", { timeout: 180_000 });
    if (!(await page.$("#modal:not(.hidden)"))) break;
    if (firstShot) {
      await shot(firstShot, false);
      firstShot = undefined;
    }
    await page.click("#modal-yes");
    await page.waitForTimeout(400);
  }
  await idle();
}
/** Click a button; answer any confirmation dialogs with Yes. */
async function clickAndConfirm(loc: Locator, firstShot?: string) {
  await loc.click();
  await answerYes(firstShot);
}
/** Where a plan's files are, by plan id. */
async function planIds() {
  const ids: string[] = [];
  for await (const e of Deno.readDir(join(dir, "plans"))) ids.push(e.name);
  return ids.sort();
}
/** The fake chain forgets a transaction: neither in a block nor in the mempool any more. */
function dropFromMempool(c: typeof ecx, txid: string) {
  c.txs.delete(txid);
  for (const [k, v] of c.spends) if (v.txid === txid) c.spends.delete(k);
}

// ---- 2. Network ----
// First launch: the setup guide, and the network gate.
await shotDownTo("01-setup-guide", page.locator(".card.guide"));
await shot("02-network");
// Check servers & confirm: the question, then the progress box while each server is checked.
slowMs = 700;
await page.getByRole("button", { name: "Check servers & confirm" }).click();
await page.waitForSelector("#modal:not(.hidden)", { timeout: 10_000 });
await shot("04-network-confirm", false);
await page.click("#modal-yes");
await page.waitForSelector(".inline-progress:not(.hidden)", { timeout: 10_000 });
await page.waitForTimeout(2500);
await shot("05-network-progress", false);
await answerYes();
slowMs = 0;
// Confirming moves on to the Wallet tab by itself; go back for the "confirmed" picture.
await tab("network");
await shot("06-network-confirmed", false);

// ---- 3. Wallet ----
await tab("wallet");
// Scan QR, multisig: three SeedSigner cosigner exports, read through the paste box (no camera
// here). The frames are the committed fixtures from SeedSigner's own encoder.
const qrCases = JSON.parse(await Deno.readTextFile("testdata/seedsigner_ur.json")).cases;
const ms = qrCases.find((c: any) => c.kind === "cosigners" && c.script === "wsh");
await page.getByRole("button", { name: "Scan QR" }).first().click();
const qrBox = page.locator(".qr-modal .modal-box");
for (const [i, cosigner] of ms.cosigners.entries()) {
  if (i > 0) await qrBox.getByRole("button", { name: "Add cosigner" }).click();
  await qrBox.locator("summary", { hasText: "Paste the QR text" }).click();
  await qrBox.locator("textarea").fill(cosigner.frames.join("\n"));
  await qrBox.getByRole("button", { name: "Read", exact: true }).click();
  await qrBox.getByRole("button", { name: "Add cosigner" }).waitFor();
}
await qrBox.locator(".big-address").waitFor();
const shown = (await qrBox.locator(".big-address").textContent())?.trim();
if (shown !== ms.firstAddress) throw new Error(`multisig address ${shown} != ${ms.firstAddress}`);
await shotDialog("07-wallet-qr-multisig", qrBox);
await qrBox.getByRole("button", { name: "Close" }).click();
await page.waitForTimeout(400);
// The wallet the demo coins are in (single-sig), pasted.
await page.locator("textarea").first().fill(SRC);
await page.locator("input[placeholder='label (optional)']").first().fill("cold storage");
await clickAndConfirm(page.getByRole("button", { name: "Import", exact: true }));
await shot("08-wallet-imported");
await page.locator("textarea").nth(1).fill(ECX_DEST);
await page.getByRole("button", { name: "Set destination" }).nth(0).click();
await idle();
await page.locator("textarea").nth(2).fill(XBT_DEST);
await page.getByRole("button", { name: "Set destination" }).nth(1).click();
await idle();
// Setting the last fork destination moves on to the Coins tab; go back for this picture.
await tab("wallet");
await shot("09-wallet-destinations");
// Scan settings, now that the estimate knows the wallet's address branches.
await tab("network");
await shotOf("03-scan-settings", card("Scan settings"));

// ---- 4. Coins ----
await tab("coins");
await page.getByRole("button", { name: "Scan now" }).click();
await page.waitForSelector(".inline-progress:not(.hidden)", { timeout: 10_000 });
await page.waitForTimeout(6000);
await shot("10-coins-scanning", false);
await answerYes();
await shot("11-coins-scanned");

// ---- 5. Plan ----
await tab("plans");
await shot("13-plan-form");
await page.locator("select").first().selectOption({
  label: "Bitcoin Knots wallet (walletprocesspsbt)",
}).catch(async () => {
  await page.locator("select").first().selectOption({ index: 1 });
});
await page.locator("input").nth(0).fill("2").catch(() => {});
await clickAndConfirm(page.getByRole("button", { name: "Create plan" }));
await shot("15-plan-created");
// QR dialog
await page.getByRole("button", { name: "QR", exact: true }).first().click();
await page.waitForTimeout(1500);
await shot("16-qr-export", false);
await page.locator(".qr-modal").getByRole("button", { name: "Close" }).click();
await page.waitForTimeout(400);

// ---- 6. Sign outside, upload ----
const [id] = await planIds();
const planDir = join(dir, "plans", id);
const plan = JSON.parse(await Deno.readTextFile(join(planDir, "plan.json")));
const signedDir = join(dir, "signed");
await Deno.mkdir(signedDir);
const files: string[] = [];
for (const t of plan.transactions) {
  const b64 = await Deno.readTextFile(join(planDir, t.file));
  const f = join(signedDir, t.file.replace(/^.*\//, "").replace(/\.psbt$/u, ".signed.psbt"));
  await Deno.writeTextFile(f, t.chain === "ecx" ? stockSign(b64) : unifiedSign(b64));
  files.push(f);
}
const inputs = page.locator("input[type=file]");
const ups = page.getByRole("button", { name: "Upload signed" });
for (let i = 0; i < files.length; i++) {
  await inputs.nth(i).setInputFiles(files[i]);
  await ups.nth(i).click();
  await idle();
}
await shot("17-signed-uploaded");

// ---- 7. Verify ----
await clickAndConfirm(page.getByRole("button", { name: "Verify signed files" }));
await shot("18-verified");

// ---- 8. Broadcast: TEST FIRST, then the rest ----
await clickAndConfirm(
  page.getByRole("button", { name: "Broadcast verified" }),
  "19-broadcast-confirm",
);
await shot("20-broadcast-test-first");
// The test transactions get mined; the next Broadcast verified says so and asks about the rest.
for (const c of [ecx, xbt]) {
  for (const [k, v] of c.spends) {
    if (v.height === undefined) {
      c.spends.set(k, { ...v, height: c.tip });
      c.txs.get(v.txid)!.height = c.tip;
    }
  }
}
await clickAndConfirm(
  page.getByRole("button", { name: "Broadcast verified" }),
  "21-test-first-question",
);
await shot("22-broadcast-all");

// ---- 9. Track ----
await clickAndConfirm(page.getByRole("button", { name: "Track confirmations" }).first());
await shot("23-tracked");

// ---- If something goes wrong: a split drops out of the mempool ----
const progress = JSON.parse(await Deno.readTextFile(join(planDir, "progress.json")));
const ecx3 = plan.transactions.find((t: any) => t.chain === "ecx" && t.order === 3);
dropFromMempool(ecx, progress.txs[ecx3.file].verified.txid);
await clickAndConfirm(page.getByRole("button", { name: "Track confirmations" }).first());
const planCard = card(`Plan ${id}`);
await planCard.locator(".alert").first().waitFor();
await shotOf("24-alert-dropped", planCard);

// ---- Coins that turn up later: a deposit to an old address, then a rescan ----
fund(all, [{ ...src.branches[0].derive(3), value: 500_000 }], 900_010, 4);
await tab("coins");
await clickAndConfirm(page.getByRole("button", { name: "Scan now" }));
await shot("12-new-shared-coins");
await page.getByRole("button", { name: "Plan these coins" }).click();
await page.waitForTimeout(600);
await shotDownTo("14-plan-these-coins", card("New plan"));

// ---- Archive the plan ----
await clickAndConfirm(planCard.getByRole("button", { name: "Archive", exact: true }));
const archived = page.locator(".card", { hasText: "Archived plans" });
await archived.locator("summary").click();
await shotOf("25-archived-plans", archived);

// ---- Burn history: the question, answered No ----
await page.click("#wipe-all");
await page.waitForSelector("#modal:not(.hidden)");
await shot("27-burn-history", false);
await page.click("#modal-no");

// ---- Advanced: donors ----
await page.click("#advanced-toggle");
await tab("donors");
// Opt-in first: the rules and the linkage, then the tab itself.
await shot("26-donors-opt-in");
await page.locator("#donor-optin-ack").check();
await page.getByRole("button", { name: "Turn on donor routes" }).click();
await page.getByRole("button", { name: "Turn donor routes off" }).waitFor();
await shot("26-donors-tab");
await browser.close();
ui.server.shutdown?.();
console.log(`saved ${n} screenshots to ${OUT}`);
Deno.exit(0);
