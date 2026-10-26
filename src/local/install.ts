// Builds ~/.pi-sprites-detach/sprite/, the self-contained folder that is synced to the
// Sprite's ~/.pi-sprites-detach/sprite/. pi has no install hook, so this runs on session_start and
// before every sync; it only rewrites the folder when the package's files changed.
//
//   bin/        detach-run, -sync-apply, -stop, -pull, -clean, lib.sh   (from sprite/bin)
//   setup/      bootstrap.sh, install-tool.sh, tools/*.sh     (from sprite/setup)
//   extension/  the remote extension, loaded with pi -e        (from src/remote)
//   manifest.json { version, hash }

import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { PACKAGE_ROOT, SPRITE_BUILD_DIR } from "./paths.ts";

interface Source {
  /** Path inside the build folder. */
  target: string;
  /** Absolute source path. */
  source: string;
  mode: number;
}

export interface SpriteBuild {
  dir: string;
  hash: string;
  version: string;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

async function sources(): Promise<Source[]> {
  const out: Source[] = [];
  const add = async (fromDir: string, toDir: string, keep: (file: string) => boolean): Promise<void> => {
    for (const file of await walk(join(PACKAGE_ROOT, fromDir))) {
      if (!keep(file)) continue;
      out.push({ target: join(toDir, relative(join(PACKAGE_ROOT, fromDir), file)), source: file, mode: (await stat(file)).mode & 0o777 });
    }
  };
  await add("sprite/bin", "bin", () => true);
  await add("sprite/setup", "setup", () => true);
  await add("src/remote", "extension", (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  return out.sort((a, b) => a.target.localeCompare(b.target));
}

async function packageVersion(): Promise<string> {
  try {
    const text = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
    return (JSON.parse(text) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function readManifest(): Promise<{ hash?: string } | undefined> {
  try {
    return JSON.parse(await readFile(join(SPRITE_BUILD_DIR, "manifest.json"), "utf8")) as { hash?: string };
  } catch {
    return undefined;
  }
}

/**
 * Make sure ~/.pi-sprites-detach/sprite/ matches the package. Cheap when nothing changed.
 * `onNote` hears about a stale lock that had to be removed.
 */
export async function ensureSpriteBuild(onNote?: (note: string) => void): Promise<SpriteBuild> {
  return withBuildLock(buildIfStale, onNote);
}

/**
 * Make sure the build is current, then `use` it (pack it for upload) while no other
 * pi window can rebuild it underneath.
 */
export async function withSpriteBuild<T>(
  use: (build: SpriteBuild) => Promise<T>,
  onNote?: (note: string) => void,
): Promise<T> {
  return withBuildLock(async () => use(await buildIfStale()), onNote);
}

// Building and packing take well under a second; a lock older than this was left by a
// pi process that died while holding it.
const LOCK_FILE = `${SPRITE_BUILD_DIR}.lock`;
const STALE_MS = 10_000;

/**
 * Run `fn` holding ~/.pi-sprites-detach/sprite.lock, created exclusively with the holder's
 * pid and time. Another holder, in this process or another pi window, is waited for;
 * a stale lock (holder gone, or older than STALE_MS) is removed.
 */
async function withBuildLock<T>(fn: () => Promise<T>, onNote?: (note: string) => void): Promise<T> {
  await mkdir(join(LOCK_FILE, ".."), { recursive: true });
  for (;;) {
    try {
      await writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await readLock();
    if (holder === undefined) continue; // released (or half-written) meanwhile: try again
    const age = Date.now() - holder.at;
    if (age > STALE_MS || !processAlive(holder.pid)) {
      await rm(LOCK_FILE, { force: true });
      onNote?.(`removed a stale build lock (pi process ${holder.pid}, ${Math.round(age / 1000)} s old)`);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    return await fn();
  } finally {
    await rm(LOCK_FILE, { force: true });
  }
}

async function readLock(): Promise<{ pid: number; at: number } | undefined> {
  try {
    const lock = JSON.parse(await readFile(LOCK_FILE, "utf8")) as { pid?: unknown; at?: unknown };
    return typeof lock.pid === "number" && typeof lock.at === "number" ? { pid: lock.pid, at: lock.at } : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Rebuild the folder if its manifest does not match the package. Under the lock. */
async function buildIfStale(): Promise<SpriteBuild> {
  const files = await sources();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.target}\0${file.mode.toString(8)}\0`);
    hash.update(await readFile(file.source));
    hash.update("\0");
  }
  const digest = hash.digest("hex").slice(0, 16);
  const version = await packageVersion();
  if ((await readManifest())?.hash === digest) return { dir: SPRITE_BUILD_DIR, hash: digest, version };

  // Build next to the target and swap, so a half-built folder is never synced.
  const next = `${SPRITE_BUILD_DIR}.next`;
  await rm(next, { recursive: true, force: true });
  for (const file of files) {
    const target = join(next, file.target);
    await mkdir(join(target, ".."), { recursive: true });
    await cp(file.source, target);
    await chmod(target, file.mode);
  }
  await writeFile(join(next, "manifest.json"), `${JSON.stringify({ version, hash: digest }, null, 2)}\n`);
  await rm(SPRITE_BUILD_DIR, { recursive: true, force: true });
  await rename(next, SPRITE_BUILD_DIR);
  return { dir: SPRITE_BUILD_DIR, hash: digest, version };
}
