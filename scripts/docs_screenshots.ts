// Regenerates the screenshots in docs/images/web-ui/ by driving the real web UI against in-memory
// test chains (the same fakes as `deno task demo-ui`). See docs/dev/docs-screenshots.md.
//
//   deno run -A --no-lock scripts/docs_screenshots.ts [output-dir]
//
// Playwright is loaded at run time (not a project dependency); install its browser first with
// `deno run -A npm:playwright install chromium`.
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
await Deno.writeTextFile(`${dir}/splayed.toml`, "[scan]\njitter_min_ms = 0\njitter_max_ms = 0\n");
const io = {
  out: () => {},
  err: () => {},
  confirm: () => true,
  env: {},
  tor: () => Promise.resolve({ host: "127.0.0.1", port: 9050 }),
  transportFactory: (_c: unknown, chain: "btc" | "xbt" | "ecx") =>
    new FakeEsploraTransport(chains[chain]),
} as unknown as CliIO;
const { out: _o, err: _e, confirm: _c, ...baseIO } = io;
const TOKEN = "shots-token-shots-token-shots-token-shots-t";
const ui = startUi({ dataDir: dir, run: main, baseIO, port: 8766, token: TOKEN });

const playwright = "npm:playwright";
const { chromium } = await import(playwright);
type Page = any;
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
const page: Page = await ctx.newPage();
await page.goto(`http://127.0.0.1:8766/#token=${TOKEN}`);
await page.waitForSelector("#view *");
let n = 0;
async function shot(name: string, full = true) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
  n++;
}
async function tab(t: string) {
  await page.click(`#tabs button[data-tab=${t}]`);
  await page.waitForTimeout(500);
}
async function idle() {
  await page
    .waitForFunction(
      `/^(idle|done|exit|finished|ok)/i.test(document.querySelector("#job-state")?.textContent?.trim() ?? "")`,
      null,
      { timeout: 30000 },
    )
    .catch(() => {});
  await page.waitForTimeout(600);
}
/** Click a button; answer any confirmation dialogs with Yes. */
async function clickAndConfirm(loc: ReturnType<Page["locator"]>, firstShot?: string) {
  await loc.click();
  for (let i = 0; i < 6; i++) {
    const opened = await page.waitForSelector("#modal:not(.hidden)", { timeout: 2500 }).catch(() =>
      null
    );
    if (!opened) break;
    if (firstShot && i === 0) {
      await shot(firstShot, false);
      firstShot = undefined;
    }
    await page.click("#modal-yes");
    await page.waitForTimeout(400);
  }
  await idle();
}

// 1. first launch: network gate
await shot("01-network");
await clickAndConfirm(
  page.getByRole("button", { name: "Check servers & confirm" }),
  "02-network-confirm",
);
await shot("03-network-confirmed");
// 2. wallet
await tab("wallet");
await page.locator("textarea").first().fill(SRC);
await page.locator("input[placeholder='label (optional)']").first().fill("cold storage");
await clickAndConfirm(page.getByRole("button", { name: "Import", exact: true }));
await shot("04-wallet-imported");
const taAll = page.locator("textarea");
await taAll.nth(1).fill(ECX_DEST);
await page.getByRole("button", { name: "Set destination" }).nth(0).click();
await idle();
await page.locator("textarea").nth(2).fill(XBT_DEST);
await page.getByRole("button", { name: "Set destination" }).nth(1).click();
await idle();
await shot("05-wallet-destinations");
// 3. coins
await tab("coins");
await clickAndConfirm(page.getByRole("button", { name: "Scan now" }));
await shot("06-coins-scanned");
// 4. plan
await tab("plans");
await shot("07-plan-form");
await page.locator("select").first().selectOption({
  label: "Bitcoin Knots wallet (walletprocesspsbt)",
}).catch(async () => {
  await page.locator("select").first().selectOption({ index: 1 });
});
await page.locator("input").nth(0).fill("2").catch(() => {});
await clickAndConfirm(page.getByRole("button", { name: "Create plan" }));
await shot("08-plan-created");
// QR dialog
await page.getByRole("button", { name: "QR", exact: true }).first().click();
await page.waitForTimeout(1500);
await shot("09-qr-export", false);
await page.locator(".qr-modal").getByRole("button", { name: "Close" }).click();
await page.waitForTimeout(400);
// 5. sign outside, upload
const plansDir = join(dir, "plans");
let id = "";
for await (const e of Deno.readDir(plansDir)) id = e.name;
const planDir = join(plansDir, id);
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
await shot("10-signed-uploaded");
// 6. verify
await clickAndConfirm(page.getByRole("button", { name: "Verify signed files" }));
await shot("11-verified");
// 7. broadcast (test first)
await clickAndConfirm(
  page.getByRole("button", { name: "Broadcast verified" }),
  "12-broadcast-confirm",
);
await shot("13-broadcast-test-first");
// mine test txs, broadcast the rest
for (const c of [ecx, xbt]) {
  for (const [k, v] of c.spends) {
    if (v.height === undefined) {
      c.spends.set(k, { ...v, height: c.tip });
      c.txs.get(v.txid)!.height = c.tip;
    }
  }
}
await clickAndConfirm(page.getByRole("button", { name: "Broadcast verified" }));
await shot("14-broadcast-all");
// 8. track
const trackBtn = page.getByRole("button", { name: /track/i }).first();
await clickAndConfirm(trackBtn);
await shot("15-tracked");
await page.click("#advanced-toggle");
await tab("donors");
await shot("16-donors-tab");
await browser.close();
ui.server.shutdown?.();
console.log(`saved ${n} screenshots to ${OUT}`);
Deno.exit(0);
