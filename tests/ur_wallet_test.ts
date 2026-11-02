import { assert, assertEquals } from "./assert.ts";
import { hex } from "@scure/base";
import { MAIN_NETWORK, parseDescriptor, REGTEST_NETWORK } from "../src/core/descriptors.ts";
import { URDecoder, URError } from "../src/core/ur.ts";
import {
  asDestination,
  decodeWalletUr,
  multisigDescriptor,
  parseWalletText,
  readCbor,
  singleSigDescriptor,
  type WalletKey,
  WalletQrError,
} from "../src/core/ur_wallet.ts";

/** testdata/seedsigner_ur.json: frames from SeedSigner 0.8.7's own encoder, expectations from embit. */
interface Case {
  name: string;
  kind: "account" | "static" | "cosigners" | "output";
  frames?: string[];
  cosigners?: { frames: string[]; fingerprint: string; path: string; xpub: string }[];
  script?: "wsh" | "sh-wsh";
  threshold?: number;
  fingerprint?: string;
  path?: string;
  xpub?: string;
  descriptor: string;
  firstAddress: string;
}
const fixtures: { cases: Case[] } = JSON.parse(
  await Deno.readTextFile(new URL("../testdata/seedsigner_ur.json", import.meta.url)),
);

function decodeFrames(frames: string[]) {
  const d = new URDecoder();
  for (const f of frames) {
    d.receive(f);
    if (d.isComplete) break;
  }
  assert(d.isComplete, "all frames decode");
  const { type, cbor } = d.result;
  return decodeWalletUr(type, cbor, MAIN_NETWORK);
}

const firstAddress = (desc: string) =>
  parseDescriptor(desc, MAIN_NETWORK).branches[0].derive(0).address;

for (const c of fixtures.cases) {
  Deno.test(`SeedSigner fixture: ${c.name}`, () => {
    if (c.kind === "account" || c.kind === "static") {
      const r = c.kind === "account"
        ? decodeFrames(c.frames!)
        : parseWalletText(c.frames![0], MAIN_NETWORK);
      assertEquals(r.kind, "account");
      if (r.kind !== "account") return;
      assertEquals(r.keys.length, 1);
      const { script, key } = r.keys[0];
      assertEquals(key.fingerprint, c.fingerprint);
      assertEquals(key.path, c.path);
      assertEquals(key.xpub, c.xpub);
      const desc = singleSigDescriptor(script, key, "import");
      assertEquals(desc, c.descriptor);
      assertEquals(firstAddress(desc), c.firstAddress);
      // The destination form scans the receive branch only.
      assertEquals(firstAddress(singleSigDescriptor(script, key, "dest")), c.firstAddress);
    } else if (c.kind === "cosigners") {
      const keys: WalletKey[] = [];
      for (const cos of c.cosigners!) {
        const r = decodeFrames(cos.frames);
        assert(r.kind === "account");
        if (r.kind !== "account") return;
        assertEquals(r.keys.length, 1);
        assertEquals(r.keys[0].script, c.script);
        assertEquals(r.keys[0].key.xpub, cos.xpub);
        keys.push(r.keys[0].key);
      }
      const desc = multisigDescriptor({
        script: c.script!,
        threshold: c.threshold!,
        sorted: true,
        keys,
        purpose: "import",
      });
      assertEquals(desc, c.descriptor);
      assertEquals(firstAddress(desc), c.firstAddress);
      // sortedmulti: the scan order doesn't matter.
      const reversed = multisigDescriptor({
        script: c.script!,
        threshold: 2,
        sorted: true,
        keys: [...keys].reverse(),
        purpose: "import",
      });
      assertEquals(firstAddress(reversed), c.firstAddress);
    } else {
      const r = decodeFrames(c.frames!);
      assert(r.kind === "output");
      if (r.kind !== "output") return;
      assertEquals(r.descriptor, c.descriptor);
      assertEquals(firstAddress(r.descriptor), c.firstAddress);
      assertEquals(firstAddress(asDestination(r.descriptor)), c.firstAddress);
    }
  });
}

Deno.test("Hummingbird vector: output-descriptor 'Satoshi's Stash' (40308, template with @n)", () => {
  // From sparrowwallet/hummingbird UROutputDescriptorTest; expected values computed with embit.
  const cbor = hex.decode(
    "d99d74a301781c77736828736f727465646d756c746928322c40302c40312c403229290283d99d6fa5035821021c0b479ecf6e67713ddf0c43b634592f51c037b6f951fb1dc6361a98b1e5735e0458206b3a4cfb6a45f6305efe6e0e976b5d26ba27f7c344d7fc7abef7be2d06d52dfd06d99d70a201881830f500f500f502f5021adc56727607d99d70a101838400f401f480f4081a18f8c2e7d99d6fa50358210397fcf2274abd243d42d42d3c248608c6d1935efca46138afef43af08e9712896045820c887c72d9d8ac29cddd5b2b060e8b0239039a149c784abe6079e24445db4aa8a06d99d70a201881830f500f500f502f5021af245ae3807d99d70a101838400f401f480f4081a221eb5a0d99d6fa5035821028342f5f7773f6fab374e1c2d3ccdba26bc0933fc4f63828b662b4357e4cc37910458205afed56d755c088320ec9bc6acd84d33737b580083759e0a0ff8f26e429e0b7706d99d70a201881830f500f500f502f5021ac5d8729707d99d70a101838400f401f480f4081a1c0ae906036f5361746f7368692773205374617368",
  );
  const r = decodeWalletUr("output-descriptor", cbor, MAIN_NETWORK);
  assert(r.kind === "output");
  if (r.kind !== "output") return;
  assertEquals(r.name, "Satoshi's Stash");
  assertEquals(
    r.descriptor,
    "wsh(sortedmulti(2,[dc567276/48h/0h/0h/2h]xpub6DiYrfRwNnjeX4vHsWMajJVFKrbEEnu8gAW9vDuQzgTWEsEHE16sGWeXXUV1LBWQE1yCTmeprSNcqZ3W74hqVdgDbtYHUv3eM4W2TEUhpan/<0;1>/*,[f245ae38/48h/0h/0h/2h]xpub6DnT4E1fT8VxuAZW29avMjr5i99aYTHBp9d7fiLnpL5t4JEprQqPMbTw7k7rh5tZZ2F5g8PJpssqrZoebzBChaiJrmEvWwUTEMAbHsY39Ge/<0;1>/*,[c5d87297/48h/0h/0h/2h]xpub6DjrnfAyuonMaboEb3ZQZzhQ2ZEgaKV2r64BFmqymZqJqviLTe1JzMr2X2RfQF892RH7MyYUbcy77R7pPu1P71xoj8cDUMNhAMGYzKR4noZ/<0;1>/*))",
  );
  assertEquals(
    firstAddress(r.descriptor),
    "bc1q4taqq6q6l8fvguva6ftvrz3qgdjy6p3w2s0ds0nl6qrjw7t0hfhqgrqcwd",
  );
});

Deno.test("Hummingbird vectors: single fixed keys are refused, with a reason", () => {
  for (
    const [type, h] of [
      [
        "crypto-output",
        "d90193d90132a103582102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
      ],
      [
        "output-descriptor",
        "d99d74a20166706b284030290281d99d72a103582103e220e776d811c44075a4a260734445c8967865f5357ba98ead3bc6a6552c36f2",
      ],
    ]
  ) {
    try {
      decodeWalletUr(type, hex.decode(h), MAIN_NETWORK);
      throw new Error("expected a refusal");
    } catch (e) {
      assert(e instanceof WalletQrError, String(e));
    }
  }
});

// A tiny CBOR writer for hand-made negative cases.
type W = number | boolean | Uint8Array | W[] | { m: [number, W][] } | { t: number; v: W };
function enc(x: W): number[] {
  const head = (major: number, n: number) =>
    n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [
      (major << 5) | 26,
      (n >>> 24) & 255,
      (n >>> 16) & 255,
      (n >>> 8) & 255,
      n & 255,
    ];
  if (typeof x === "boolean") return [x ? 0xf5 : 0xf4];
  if (typeof x === "number") return head(0, x);
  if (x instanceof Uint8Array) return [...head(2, x.length), ...x];
  if (Array.isArray(x)) return [...head(4, x.length), ...x.flatMap(enc)];
  if ("m" in x) return [...head(5, x.m.length), ...x.m.flatMap(([k, v]) => [...enc(k), ...enc(v)])];
  return [...head(6, x.t), ...enc(x.v)];
}
const pub = new Uint8Array(33).fill(1);
pub[0] = 2;
const cc = new Uint8Array(32).fill(7);
const origin = { t: 304, v: { m: [[1, [84, true, 0, true, 0, true]], [2, 0x73c5da0a]] } } as W;
const account = (key: W) =>
  new Uint8Array(enc({ m: [[1, 0x73c5da0a], [2, [{ t: 404, v: { t: 303, v: key } }]]] }));

Deno.test("private keys are refused before anything else", () => {
  const priv = new Uint8Array(33);
  priv[1] = 9;
  for (
    const key of [
      { m: [[2, true], [3, pub], [4, cc], [6, origin]] }, // is-private flag
      { m: [[3, priv], [4, cc], [6, origin]] }, // 0x00-prefixed private key data
    ] as W[]
  ) {
    try {
      decodeWalletUr("crypto-account", account(key), MAIN_NETWORK);
      throw new Error("expected a refusal");
    } catch (e) {
      assert(e instanceof WalletQrError && /PRIVATE/u.test(e.message), String(e));
    }
  }
  for (
    const text of [
      "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi",
    ]
  ) {
    try {
      parseWalletText(text, MAIN_NETWORK);
      throw new Error("expected a refusal");
    } catch (e) {
      assert(e instanceof WalletQrError && /PRIVATE/u.test(e.message), String(e));
    }
  }
});

Deno.test("network mismatch, other transfer types and duplicate cosigners are refused", () => {
  const c = fixtures.cases.find((x) => x.kind === "account")!;
  const d = new URDecoder();
  for (const f of c.frames!) {
    d.receive(f);
    if (d.isComplete) break;
  }
  const { type, cbor } = d.result;
  try {
    decodeWalletUr(type, cbor, REGTEST_NETWORK);
    throw new Error("expected a refusal");
  } catch (e) {
    assert(e instanceof WalletQrError && /mainnet/u.test(e.message), String(e));
  }
  try {
    decodeWalletUr("crypto-psbt", cbor, MAIN_NETWORK);
    throw new Error("expected a refusal");
  } catch (e) {
    assert(e instanceof WalletQrError && /not a wallet export/u.test(e.message), String(e));
  }
  const cos = fixtures.cases.find((x) => x.kind === "cosigners")!;
  const one = decodeFrames(cos.cosigners![0].frames);
  assert(one.kind === "account");
  if (one.kind !== "account") return;
  try {
    multisigDescriptor({
      script: "wsh",
      threshold: 2,
      sorted: true,
      keys: [one.keys[0].key, one.keys[0].key],
      purpose: "import",
    });
    throw new Error("expected a refusal");
  } catch (e) {
    assert(e instanceof WalletQrError && /twice/u.test(e.message), String(e));
  }
  for (const threshold of [0, 3]) {
    try {
      multisigDescriptor({
        script: "wsh",
        threshold,
        sorted: true,
        keys: [one.keys[0].key, { ...one.keys[0].key, xpub: "other" }],
        purpose: "import",
      });
      throw new Error("expected a refusal");
    } catch (e) {
      assert(e instanceof WalletQrError && /threshold/u.test(e.message), String(e));
    }
  }
  // A multisig key can't be used as a single-sig wallet.
  try {
    singleSigDescriptor("wsh", one.keys[0].key, "import");
    throw new Error("expected a refusal");
  } catch (e) {
    assert(e instanceof WalletQrError && /cosigner/u.test(e.message), String(e));
  }
  // Frames from another transfer are refused by the decoder itself.
  const other = fixtures.cases.find((x) => x.kind === "output")!;
  const mixed = new URDecoder();
  mixed.receive(c.frames![0]);
  try {
    mixed.receive(other.frames![0]);
    throw new Error("expected a refusal");
  } catch (e) {
    assert(e instanceof URError, String(e));
  }
});

Deno.test("readCbor bounds: depth, length and trailing bytes", () => {
  let deep: W = 1;
  for (let i = 0; i < 20; i++) deep = [deep];
  for (
    const bad of [
      new Uint8Array(enc(deep)),
      new Uint8Array(enc(Array.from({ length: 65 }, () => 0))),
      new Uint8Array([...enc(1), 0]),
      new Uint8Array([0x5f]), // indefinite-length bytes
    ]
  ) {
    try {
      readCbor(bad);
      throw new Error("expected a refusal");
    } catch (e) {
      assert(e instanceof WalletQrError, String(e));
    }
  }
});

Deno.test("UI endpoints: /api/wallet/qr decodes in batches; /api/wallet/preview builds and checks", async () => {
  const { startUi } = await import("../src/ui/server.ts");
  const { main } = await import("../src/cli/main.ts");
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-walletqr-" });
  const ui = startUi({ dataDir, run: main, baseIO: { env: {} } });
  const call = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ui.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    // Animated SeedSigner multisig exports, a few frames at a time, for three cosigners.
    const cos = fixtures.cases.find((x) => x.kind === "cosigners" && x.script === "wsh")!;
    const keys: unknown[] = [];
    for (const [n, c] of cos.cosigners!.entries()) {
      const session = `test-session-${n}`;
      const first = await call("/api/wallet/qr", { session, frames: c.frames.slice(0, 2) });
      assertEquals(first.status, 200);
      assertEquals(first.json.complete, false);
      assert(first.json.progress.percent > 0);
      const rest = await call("/api/wallet/qr", { session, frames: c.frames.slice(2) });
      assertEquals(rest.json.complete, true, JSON.stringify(rest.json));
      assertEquals(rest.json.result.kind, "account");
      keys.push(rest.json.result.keys[0].key);
    }
    const multi = await call("/api/wallet/preview", {
      mode: "multisig",
      script: "wsh",
      threshold: 2,
      sorted: true,
      keys,
      purpose: "import",
    });
    assertEquals(multi.status, 200, JSON.stringify(multi.json));
    assertEquals(multi.json.descriptor, cos.descriptor);
    assertEquals(multi.json.firstAddresses[0], cos.firstAddress);
    assertEquals(multi.json.branches, 2);

    // SeedSigner "Static" text needs no session state.
    const st = fixtures.cases.find((x) => x.kind === "static")!;
    const s = await call("/api/wallet/qr", { session: "static-0001", frames: st.frames });
    assertEquals(s.json.complete, true);
    const single = await call("/api/wallet/preview", {
      mode: "single",
      script: s.json.result.keys[0].script,
      key: s.json.result.keys[0].key,
      purpose: "dest",
    });
    assertEquals(single.json.descriptor.endsWith("/0/*)"), true);
    assertEquals(single.json.firstAddresses, [st.firstAddress]);

    // Whole wallet from a coordinator, as a fork destination: receive branch only.
    const out = fixtures.cases.find((x) => x.kind === "output")!;
    const o = await call("/api/wallet/qr", { session: "output-0001", frames: out.frames });
    const dest = await call("/api/wallet/preview", {
      mode: "output",
      descriptor: o.json.result.descriptor,
      purpose: "dest",
    });
    assertEquals(dest.json.branches, 1);
    assertEquals(dest.json.firstAddresses, [out.firstAddress]);

    // Refusals come back as 400 with a reason.
    const priv = await call("/api/wallet/qr", {
      session: "priv-00001",
      frames: [
        "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi",
      ],
    });
    assertEquals(priv.status, 400);
    assert(/PRIVATE/u.test(priv.json.error));
    const noSession = await call("/api/wallet/qr", { frames: [] });
    assertEquals(noSession.status, 400);
    const badKey = await call("/api/wallet/preview", {
      mode: "single",
      script: "wpkh",
      key: { fingerprint: "73c5da0a", path: "84h/0h/0h", xpub: "xpub) , evil(" },
    });
    assertEquals(badKey.status, 400);
    const mixed = await call("/api/wallet/qr", {
      session: "mixed-0001",
      frames: [cos.cosigners![0].frames[0], out.frames![0]],
    });
    assertEquals(mixed.status, 400);
    assert(/another transfer/u.test(mixed.json.error));
  } finally {
    await ui.server.shutdown();
  }
});

Deno.test("Hummingbird account-descriptor: cosigner(…) multisig keys are kept, BIP45 sh() dropped", () => {
  // URAccountDescriptorTest.testSeed: pkh, sh(wpkh), wpkh, sh(cosigner), sh(wsh(cosigner)),
  // wsh(cosigner), tr.
  const r = decodeWalletUr(
    "account-descriptor",
    hex.decode(
      "a2011a37b5eed40287d99d74a20167706b68284030290281d99d6fa403582103eb3e2863911826374de86c231a4b76f0b89dfa174afb78d7f478199884d9dd320458206456a5df2db0f6d9af72b2a1af4b25f45200ed6fcc29c3440b311d4796b70b5b06d99d70a20186182cf500f500f5021a37b5eed4081a99f9cdf7d99d74a2016c73682877706b6828403029290281d99d6fa403582102c7e4823730f6ee2cf864e2c352060a88e60b51a84e89e4c8c75ec22590ad6b690458209d2f86043276f9251a4a4f577166a5abeb16b6ec61e226b5b8fa11038bfda42d06d99d70a201861831f500f500f5021a37b5eed4081aa80f7cdbd99d74a2016877706b68284030290281d99d6fa403582103fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f04582072ede7334d5acf91c6fda622c205199c595a31f9218ed30792d301d5ee9e3a8806d99d70a201861854f500f500f5021a37b5eed4081a0d5de1d7d99d74a20170736828636f7369676e657228403029290281d99d6fa4035821035ccd58b63a2cdc23d0812710603592e7457573211880cb59b1ef012e168e059a04582088d3299b448f87215d96b0c226235afc027f9e7dc700284f3e912a34daeb1a2306d99d70a20182182df5021a37b5eed4081a37b5eed4d99d74a2017573682877736828636f7369676e65722840302929290281d99d6fa4035821032c78ebfcabdac6d735a0820ef8732f2821b4fb84cd5d6b26526938f90c0507110458207953efe16a73e5d3f9f2d4c6e49bd88e22093bbd85be5a7e862a4b98a16e0ab606d99d70a201881830f500f500f501f5021a37b5eed4081a59b69b2ad99d74a2017177736828636f7369676e657228403029290281d99d6fa40358210260563ee80c26844621b06b74070baf0e23fb76ce439d0237e87502ebbd3ca3460458202fa0e41c9dc43dc4518659bfcef935ba8101b57dbc0812805dd983bc1d34b81306d99d70a201881830f500f500f502f5021a37b5eed4081a59b69b2ad99d74a201667472284030290281d99d6fa403582102bbb97cf9efa176b738efd6ee1d4d0fa391a973394fbc16e4c5e78e536cd14d2d0458204b4693e1f794206ed1355b838da24949a92b63d02e58910bf3bd3d9c242281e606d99d70a201861856f500f500f5021a37b5eed4081acec7070c",
    ),
    MAIN_NETWORK,
  );
  assert(r.kind === "account");
  if (r.kind !== "account") return;
  assertEquals(r.keys.map((k) => k.script), ["pkh", "sh-wpkh", "wpkh", "sh-wsh", "wsh", "tr"]);
  assertEquals(r.keys.find((k) => k.script === "wsh")!.key.path, "48h/0h/0h/2h");
  assertEquals(r.keys.find((k) => k.script === "sh-wsh")!.key.path, "48h/0h/0h/1h");
});

Deno.test("review fixes: children paths, branch suffixes, duplicates, ranges, seeds", async () => {
  const { checkDescriptorBranches, publicKeyOf } = await import("../src/core/ur_wallet.ts");
  // Children other than <0;1>/* or 0/* would silently change the addresses: refused.
  const withChildren = (children: W) =>
    account({ m: [[3, pub], [4, cc], [6, origin], [7, { t: 304, v: { m: [[1, children]] } }]] });
  for (
    const [children, ok] of [
      [[[0, false, 1, false], [], false], true], // <0;1>/*
      [[0, false, [], false], true], // 0/*
      [[1, false, [], false], false], // 1/*
      [[[1, false, 0, false], [], false], false], // <1;0>/*
      [[[], false], false], // *
      [[0, true, [], false], false], // hardened below the account
    ] as [W, boolean][]
  ) {
    let accepted = true;
    try {
      decodeWalletUr("crypto-account", withChildren(children), MAIN_NETWORK);
    } catch (e) {
      assert(e instanceof WalletQrError, String(e));
      accepted = false;
    }
    assertEquals(accepted, ok, JSON.stringify(children));
  }
  // Whole-wallet descriptors with swapped or change-only branches are refused.
  const c = fixtures.cases.find((x) => x.kind === "output")!;
  checkDescriptorBranches(c.descriptor);
  for (
    const bad of [
      c.descriptor.replaceAll("<0;1>", "<1;0>"),
      asDestination(c.descriptor).replaceAll("/0/*", "/1/*"),
    ]
  ) {
    try {
      parseWalletText(bad, MAIN_NETWORK);
      throw new Error("expected a refusal");
    } catch (e) {
      assert(e instanceof WalletQrError && /only supports/u.test(e.message), String(e));
    }
  }
  // Repeated CBOR map keys can't hide a flag.
  try {
    readCbor(new Uint8Array(enc({ m: [[2, true], [2, false]] })));
    throw new Error("expected a refusal");
  } catch (e) {
    assert(e instanceof WalletQrError && /repeated/u.test(e.message), String(e));
  }
  // The same key with different metadata is still the same cosigner.
  const cos = fixtures.cases.find((x) => x.kind === "cosigners")!.cosigners![0];
  const raw = (await import("@scure/base")).createBase58check(
    (await import("@noble/hashes/sha2.js")).sha256,
  );
  const bytes = raw.decode(cos.xpub);
  bytes.set([0, 0, 0, 0], 5); // parent fingerprint zeroed
  const variant = raw.encode(bytes);
  assert(variant !== cos.xpub);
  assertEquals(publicKeyOf(variant), publicKeyOf(cos.xpub));
  try {
    multisigDescriptor({
      script: "wsh",
      threshold: 1,
      sorted: true,
      keys: [{ ...cos, xpub: cos.xpub }, { ...cos, xpub: variant }],
      purpose: "import",
    });
    throw new Error("expected a refusal");
  } catch (e) {
    assert(e instanceof WalletQrError && /twice/u.test(e.message), String(e));
  }
  // Origin steps of 2^31 or more are refused, in static text and in descriptors.
  try {
    parseWalletText(`[73c5da0a/84h/0h/2147483648h]${fixtures.cases[4].xpub}`, MAIN_NETWORK);
    throw new Error("expected a refusal");
  } catch (e) {
    assert(e instanceof WalletQrError, String(e));
  }
  try {
    parseDescriptor(
      `wpkh([73c5da0a/84h/0h/4294967295h]${fixtures.cases[0].xpub}/0/*)`,
      MAIN_NETWORK,
    );
    throw new Error("expected a refusal");
  } catch (e) {
    assert(/out of range/u.test((e as Error).message), String(e));
  }
  // A seed phrase or SeedQR digits get a clear warning, not "not a wallet export".
  for (
    const text of [
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "0".repeat(48),
    ]
  ) {
    try {
      parseWalletText(text, MAIN_NETWORK);
      throw new Error("expected a refusal");
    } catch (e) {
      assert(e instanceof WalletQrError && /SEED/u.test(e.message), String(e));
    }
  }
});

Deno.test("UI endpoint: a stray plain-text code doesn't throw away an animated scan", async () => {
  const { startUi } = await import("../src/ui/server.ts");
  const { main } = await import("../src/cli/main.ts");
  const dataDir = await Deno.makeTempDir({ prefix: "splayed-walletqr-" });
  const ui = startUi({ dataDir, run: main, baseIO: { env: {} } });
  const call = async (body: unknown) =>
    await (await fetch(`http://127.0.0.1:${ui.port}/api/wallet/qr`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ui.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json();
  try {
    const c = fixtures.cases.find((x) => x.kind === "account")!;
    const st = fixtures.cases.find((x) => x.kind === "static")!;
    const first = await call({ session: "stray-0001", frames: c.frames!.slice(0, 2) });
    assertEquals(first.complete, false);
    const rest = await call({
      session: "stray-0001",
      frames: [st.frames![0], ...c.frames!.slice(2)],
    });
    assertEquals(rest.complete, true);
    assertEquals(rest.result.keys[0].key.xpub, c.xpub);
  } finally {
    await ui.server.shutdown();
  }
});
