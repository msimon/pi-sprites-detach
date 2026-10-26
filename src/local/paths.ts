// Where things live, on the laptop and on the Sprite.

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = homedir();

/** pi-handoff's install on the laptop: config, job records, the Sprite folder. */
export const DETACH_HOME = join(HOME, ".pi-sprites-detach");
export const CONFIG_FILE = join(DETACH_HOME, "config.json");
export const JOBS_DIR = join(DETACH_HOME, "jobs");
/** Everything the Sprite needs, built from the package; synced as-is to the same path there. */
export const SPRITE_BUILD_DIR = join(DETACH_HOME, "sprite");
/** Marc's own extensions for the Sprite (remote.replace targets); synced like any sync path. */
export const USER_EXTENSIONS_DIR = join(DETACH_HOME, "extensions");
/** Local worktrees made by `/handoff pull --worktree`: <repo>/<jobId> under it. */
export const WORKTREES_DIR = join(HOME, "pi-sprites-detach", "worktrees");

/** Root of this package (the repository, or the installed package). */
export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const SPRITE_HOME = "/home/sprite";
/**
 * The Sprite's copy of SPRITE_BUILD_DIR, at the same path as on the laptop. Replaced
 * wholesale on update; holds no state. Its parent ~/.pi-sprites-detach/ also receives synced
 * user files such as ~/.pi-sprites-detach/extensions/, which an update never touches.
 */
export const REMOTE_DETACH_HOME = `${SPRITE_HOME}/.pi-sprites-detach/sprite`;
/** Job and sync state on the Sprite. */
export const REMOTE_STATE = `${SPRITE_HOME}/.detach`;

export function expandHome(path: string): string {
  if (path === "~") return HOME;
  if (path.startsWith("~/")) return join(HOME, path.slice(2));
  return path;
}

/** Same path on the Sprite: the laptop home prefix becomes the Sprite home. */
export function toSpritePath(path: string): string {
  if (path === HOME) return SPRITE_HOME;
  if (path.startsWith(`${HOME}/`)) return `${SPRITE_HOME}/${path.slice(HOME.length + 1)}`;
  return path;
}
