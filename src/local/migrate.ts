// The laptop's state from before the rename (pi-handoff → pi-sprites-detach): moved
// once, when the extension loads. The Sprite moves its own at the next sync
// (migrate_legacy_state in sprite/bin/lib.sh).
//
// - ~/.pi-handoff/ (config, job records, the Sprite build, the user's extensions)
//   becomes ~/.pi-sprites-detach/, and the config's paths that pointed into it and
//   the package's own entry (msimon/pi-handoff) follow.
// - Worktrees made by pull --worktree stay in ~/pi-handoff/worktrees/: git records
//   their path, and each job record keeps its own, so they keep working there.

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DETACH_HOME, HOME } from "./paths.ts";

export const LEGACY_HOME = join(HOME, ".pi-handoff");

/** The config text with the paths and the package name from before the rename updated. */
export function migrateConfigText(text: string): string {
  return text
    .replace(/~\/\.pi-handoff(?=[/"])/g, "~/.pi-sprites-detach")
    .replace(/msimon\/pi-handoff(?![\w-])/g, "msimon/pi-sprites-detach");
}

/** Move the old folder to the new one; what to tell the user, or undefined when there was nothing to do. */
export async function migrateLegacyHome(from = LEGACY_HOME, to = DETACH_HOME): Promise<string | undefined> {
  if (!existsSync(from)) return undefined;
  const both = `${from} is still there next to ${to}, which is the one used. Move anything you need from it by hand, then delete it.`;
  if (existsSync(to)) return both;
  try {
    await rename(from, to);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined; // another pi window moved it first
    if (code === "EEXIST" || code === "ENOTEMPTY") return both;
    throw error;
  }
  const config = join(to, "config.json");
  if (existsSync(config)) {
    const text = await readFile(config, "utf8");
    const next = migrateConfigText(text);
    if (next !== text) await writeFile(config, next);
  }
  return `Moved ${from} to ${to}: pi-handoff is now pi-sprites-detach. Restart other pi windows so they use the new name.`;
}
