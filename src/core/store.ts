import { join } from "node:path";

export function defaultDataDir(): string {
  const env = Deno.env.get("FORKSPLIT_DATA_DIR");
  if (env) return env;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  switch (Deno.build.os) {
    case "windows":
      return join(Deno.env.get("APPDATA") ?? home, "forksplit");
    case "darwin":
      return join(home, "Library", "Application Support", "forksplit");
    default:
      return join(Deno.env.get("XDG_DATA_HOME") ?? join(home, ".local", "share"), "forksplit");
  }
}

export async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readTextIfExists(path);
  return text === undefined ? undefined : JSON.parse(text) as T;
}

/** Atomic write: temp file in the same directory, then rename. Files are private (0600). */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, text, { mode: 0o600 });
  try {
    await Deno.rename(tmp, path);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(value, null, 2) + "\n");
}
