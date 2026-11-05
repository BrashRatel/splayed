// Builds the release archives for every platform from one machine:
//
//   deno task fetch-tor --all              # once: the pinned Tor bundles in vendor/tor/
//   deno run -A scripts/package_release.ts [out-dir] [--only name,name]  (default: dist/release)
//
// For each platform it cross-compiles the binary (`deno compile --target`), lays out
// splayed-<version>-<platform>/ with the binary, README, LICENSE, SECURITY.md and the matching
// vendor/tor/<os>-<arch>/ bundle (where one is pinned in vendor/tor-manifest.json), archives it
// (.zip for Windows, .tar.gz otherwise) and writes SHA256SUMS. Signing SHA256SUMS is a separate,
// manual step (docs/dev/releasing.md). See also: the Tor bundles are the same ones `fetch-tor`
// checked against the pinned hashes; this script only copies them. Windows and macOS bundles get
// their own README.txt and a double-click launcher from packaging/<windows|macos>/ instead of the
// generic README.md.
import { join } from "node:path";

interface Platform {
  /** Name used in the archive file name. */
  name: string;
  /** `deno compile --target` triple. */
  target: string;
  /** vendor/tor/<dir>, or undefined when no bundle is pinned for it (needs `tor` on PATH). */
  torDir?: string;
  exe: string;
  zip?: boolean;
  /** packaging/<launcher>/: a launcher script and README.txt used in place of README.md. */
  launcher?: "windows" | "macos";
}

const PLATFORMS: Platform[] = [
  {
    name: "linux-x86_64",
    target: "x86_64-unknown-linux-gnu",
    torDir: "linux-x86_64",
    exe: "splayed",
  },
  {
    name: "linux-aarch64",
    target: "aarch64-unknown-linux-gnu",
    torDir: "linux-aarch64",
    exe: "splayed",
  },
  {
    name: "macos-aarch64",
    target: "aarch64-apple-darwin",
    torDir: "darwin-aarch64",
    exe: "splayed",
    launcher: "macos",
  },
  {
    name: "macos-x86_64",
    target: "x86_64-apple-darwin",
    torDir: "darwin-x86_64",
    exe: "splayed",
    launcher: "macos",
  },
  {
    name: "windows-x86_64",
    target: "x86_64-pc-windows-msvc",
    torDir: "windows-x86_64",
    exe: "splayed.exe",
    zip: true,
    launcher: "windows",
  },
];

async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  const { code } = await new Deno.Command(cmd, { args, cwd, stdout: "inherit", stderr: "inherit" })
    .output();
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${code})`);
}

/**
 * Copies packaging/<kind>/* into the bundle, filling in {{VERSION}}. Windows files get CRLF line
 * endings (Notepad and cmd.exe expect them); the macOS .command file is made executable.
 */
async function addLauncher(dir: string, kind: "windows" | "macos", version: string) {
  const src = join(root, "packaging", kind);
  for await (const entry of Deno.readDir(src)) {
    if (!entry.isFile) continue;
    let text = (await Deno.readTextFile(join(src, entry.name))).replaceAll("{{VERSION}}", version);
    if (kind === "windows") text = text.replace(/\r?\n/g, "\r\n");
    const dest = join(dir, entry.name);
    await Deno.writeTextFile(dest, text);
    if (entry.name.endsWith(".command")) await Deno.chmod(dest, 0o755);
  }
}

const root = new URL("..", import.meta.url).pathname;
const version: string = JSON.parse(await Deno.readTextFile(join(root, "deno.json"))).version;
const args = [...Deno.args];
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? (args.splice(onlyAt, 2)[1] ?? "").split(",").filter(Boolean) : undefined;
if (args[0]?.startsWith("-") || (onlyAt >= 0 && !only?.length)) {
  console.log("usage: deno task package [out-dir] [--only name,name]   (default: dist/release)");
  console.log(`names: ${PLATFORMS.map((p) => p.name).join(", ")}`);
  Deno.exit(args[0] === "--help" || args[0] === "-h" ? 0 : 2);
}
const unknown = (only ?? []).filter((n) => !PLATFORMS.some((p) => p.name === n));
if (unknown.length) {
  console.error(`Unknown platform(s): ${unknown.join(", ")}`);
  Deno.exit(2);
}
const platforms = only ? PLATFORMS.filter((p) => only.includes(p.name)) : PLATFORMS;
const out = join(args[0] ?? join(root, "dist", "release"));
await Deno.remove(out, { recursive: true }).catch(() => {});
await Deno.mkdir(out, { recursive: true });

const sums: string[] = [];
for (const p of platforms) {
  const dirName = `splayed-${version}-${p.name}`;
  const dir = join(out, dirName);
  await Deno.mkdir(dir, { recursive: true });
  console.log(`\n== ${p.name}`);
  await run("deno", [
    "compile",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    "--include",
    "src/ui/static",
    "--target",
    p.target,
    "-o",
    join(dir, p.exe),
    "main.ts",
  ], root);
  for (
    const f of p.launcher ? ["LICENSE", "SECURITY.md"] : ["README.md", "LICENSE", "SECURITY.md"]
  ) {
    await Deno.copyFile(join(root, f), join(dir, f));
  }
  if (p.launcher) await addLauncher(dir, p.launcher, version);
  if (p.torDir) {
    const src = join(root, "vendor", "tor", p.torDir);
    try {
      await Deno.stat(src);
    } catch {
      throw new Error(`${src} is missing: run \`deno task fetch-tor --all\` first`);
    }
    await Deno.mkdir(join(dir, "vendor", "tor"), { recursive: true });
    await run("cp", ["-a", src, join(dir, "vendor", "tor", p.torDir)]);
  }
  const archive = p.zip ? `${dirName}.zip` : `${dirName}.tar.gz`;
  if (p.zip) await run("zip", ["-qr", archive, dirName], out);
  else await run("tar", ["czf", archive, dirName], out);
  await Deno.remove(dir, { recursive: true });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await Deno.readFile(join(out, archive))),
  );
  sums.push(`${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}  ${archive}`);
  console.log(`${archive}: ${p.torDir ? "Tor bundled" : "no bundled Tor (needs `tor` on PATH)"}`);
}
await Deno.writeTextFile(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(`\nWrote ${platforms.length} archives and SHA256SUMS to ${out}`);
console.log("Sign SHA256SUMS yourself (gpg --detach-sign --armor) before publishing.");
