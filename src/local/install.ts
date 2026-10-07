// Builds ~/.pi-handoff/sprite/, the self-contained folder that is synced to the
// Sprite's ~/.pi-handoff/. pi has no install hook, so this runs on session_start and
// before every sync; it only rewrites the folder when the package's files changed.
//
//   bin/        handoff-run, handoff-sync-apply, lib.sh      (from sprite/bin)
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

/** Make sure ~/.pi-handoff/sprite/ matches the package. Cheap when nothing changed. */
export async function ensureSpriteBuild(): Promise<SpriteBuild> {
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
