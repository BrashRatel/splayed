/**
 * Downloads the pinned Tor Expert Bundle and unpacks it to vendor/tor/<os>-<arch>/.
 *
 *   deno task fetch-tor              # this machine's platform
 *   deno task fetch-tor --all        # every pinned platform (release builds)
 *
 * Every archive is checked against the SHA-256 in vendor/tor-manifest.json before it's unpacked.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_DIRS: Record<string, string> = {
  "linux-x86_64": "linux-x86_64",
  "macos-x86_64": "darwin-x86_64",
  "macos-aarch64": "darwin-aarch64",
  "windows-x86_64": "windows-x86_64",
};

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await Deno.readTextFile(join(root, "vendor", "tor-manifest.json")));
if (!manifest.version || !Object.keys(manifest.files).length) {
  console.error(
    "vendor/tor-manifest.json has no pinned hashes yet. Run `deno task update-tor-manifest <version>` first.",
  );
  Deno.exit(1);
}
const here = `${Deno.build.os === "darwin" ? "macos" : Deno.build.os}-${
  Deno.build.arch === "aarch64" ? "aarch64" : "x86_64"
}`;
const wanted = Deno.args.includes("--all") ? Object.keys(manifest.files) : [here];

for (const platform of wanted) {
  const entry = manifest.files[platform];
  if (!entry) {
    console.error(`No pinned Tor bundle for ${platform}; it will use a system Tor instead.`);
    continue;
  }
  const url = `${manifest.baseUrl}/${manifest.version}/${entry.file}`;
  console.log(`Downloading ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== entry.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${entry.file}: got ${digest}, pinned ${entry.sha256}. Not unpacking.`,
    );
  }
  const tmp = await Deno.makeTempDir();
  await Deno.writeFile(join(tmp, entry.file), bytes);
  const untar = await new Deno.Command("tar", { args: ["-xzf", join(tmp, entry.file), "-C", tmp] })
    .output();
  if (!untar.success) throw new Error(`tar failed: ${new TextDecoder().decode(untar.stderr)}`);
  const dest = join(root, "vendor", "tor", PLATFORM_DIRS[platform]);
  await Deno.remove(dest, { recursive: true }).catch(() => {});
  await Deno.mkdir(dest, { recursive: true });
  // The bundle's tor/ directory holds the binary and (on Linux/Windows) its libraries.
  for await (const e of Deno.readDir(join(tmp, "tor"))) {
    await Deno.copyFile(join(tmp, "tor", e.name), join(dest, e.name)).catch(async () => {
      // Subdirectories (e.g. pluggable transports) are copied with tar to keep it simple.
      const cp = await new Deno.Command("tar", {
        args: ["-cf", "-", "-C", join(tmp, "tor"), e.name],
        stdout: "piped",
      }).output();
      const x = new Deno.Command("tar", { args: ["-xf", "-", "-C", dest], stdin: "piped" }).spawn();
      const w = x.stdin.getWriter();
      await w.write(cp.stdout);
      await w.close();
      await x.status;
    });
  }
  if (Deno.build.os !== "windows") {
    await Deno.chmod(join(dest, platform.startsWith("windows") ? "tor.exe" : "tor"), 0o755).catch(
      () => {},
    );
  }
  console.log(`Tor ${manifest.version} for ${platform} -> ${dest}`);
}
