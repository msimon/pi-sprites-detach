// Where things live, on the laptop and on the Sprite.

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = homedir();

/** pi-handoff's install on the laptop: config, job records, the Sprite folder. */
export const HANDOFF_HOME = join(HOME, ".pi-handoff");
export const CONFIG_FILE = join(HANDOFF_HOME, "config.json");
export const JOBS_DIR = join(HANDOFF_HOME, "jobs");
/** Everything the Sprite needs, built from the package; synced as-is to REMOTE_HANDOFF_HOME. */
export const SPRITE_BUILD_DIR = join(HANDOFF_HOME, "sprite");

/** Root of this package (the repository, or the installed package). */
export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const SPRITE_HOME = "/home/sprite";
/** The Sprite's copy of SPRITE_BUILD_DIR. Replaced wholesale on update; holds no state. */
export const REMOTE_HANDOFF_HOME = `${SPRITE_HOME}/.pi-handoff`;
/** Job and sync state on the Sprite. */
export const REMOTE_STATE = `${SPRITE_HOME}/.handoff`;

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
