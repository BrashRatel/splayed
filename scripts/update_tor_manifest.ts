/**
 * Maintainer tool: pins Tor Expert Bundle hashes for a Tor Browser release.
 *
 *   deno task update-tor-manifest 15.0.1
 *
 * Downloads sha256sums-signed-build.txt and its .asc from torproject.org and verifies the
 * signature with your local gpg against the Tor Browser Developers signing key. Only after a good
 * signature are the expert-bundle hashes written to vendor/tor-manifest.json. Review the diff and
 * commit it; fetch-tor then downloads and checks bundles against these pins.
 */
const TOR_BROWSER_SIGNING_KEY = "EF6E286DDA85EA2A4BA7DE684E2C6E8793298290"; // Tor Browser Developers (signing key)
const PLATFORMS = [
  "linux-x86_64",
  "linux-aarch64",
  "macos-x86_64",
  "macos-aarch64",
  "windows-x86_64",
];

const version = Deno.args[0];
if (!version || !/^\d+\.\d+(\.\d+)?(a\d+)?$/.test(version)) {
  console.error("usage: deno task update-tor-manifest <tor-browser-version>   e.g. 15.0.1");
  Deno.exit(2);
}
const manifestUrl = new URL("../vendor/tor-manifest.json", import.meta.url);
const manifest = JSON.parse(await Deno.readTextFile(manifestUrl));
const base = `${manifest.baseUrl}/${version}`;

async function download(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const dir = await Deno.makeTempDir();
const sums = await download(`${base}/sha256sums-signed-build.txt`);
await Deno.writeFile(`${dir}/sums.txt`, sums);
await Deno.writeFile(
  `${dir}/sums.txt.asc`,
  await download(`${base}/sha256sums-signed-build.txt.asc`),
);

const gpg = await new Deno.Command("gpg", {
  args: ["--status-fd", "1", "--verify", `${dir}/sums.txt.asc`, `${dir}/sums.txt`],
  stdout: "piped",
  stderr: "piped",
}).output();
const status = new TextDecoder().decode(gpg.stdout);
const valid = /\[GNUPG:\] VALIDSIG ([0-9A-F]{40})(?: \S+){8} ([0-9A-F]{40})/.exec(status);
const signer = valid?.[2] ?? valid?.[1];
if (!gpg.success || !signer || signer !== TOR_BROWSER_SIGNING_KEY) {
  console.error(new TextDecoder().decode(gpg.stderr));
  console.error(
    `Signature check failed (signer ${signer ?? "none"}). Import the Tor Browser Developers key ` +
      `(${TOR_BROWSER_SIGNING_KEY}) from a source you trust and retry.`,
  );
  Deno.exit(1);
}

const files: Record<string, { file: string; sha256: string }> = {};
for (const line of new TextDecoder().decode(sums).split("\n")) {
  const m = /^([0-9a-f]{64})\s+\*?(tor-expert-bundle-([a-z0-9_-]+)-[\d.a]+\.tar\.gz)$/.exec(
    line.trim(),
  );
  if (m && PLATFORMS.includes(m[3])) files[m[3]] = { file: m[2], sha256: m[1] };
}
for (const p of PLATFORMS) {
  if (!files[p]) console.warn(`warning: no expert bundle for ${p} in ${version}`);
}
manifest.version = version;
manifest.files = files;
await Deno.writeTextFile(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Pinned ${
    Object.keys(files).length
  } expert bundle(s) for Tor Browser ${version}. Review and commit vendor/tor-manifest.json.`,
);
