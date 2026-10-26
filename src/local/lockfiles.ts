// Package managers a repo needs on the Sprite. npm comes with Node; the others only
// get there through remote.tools, so a detach checks for them up front instead of
// letting the agent hit a missing command on the Sprite.

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Lockfile → the tool that installs from it. Same order as the remote briefing's. */
const LOCKFILES: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["uv.lock", "uv"],
];

/** Tools that come with the Sprite's base setup (bootstrap.sh). */
const ALWAYS_THERE = new Set(["npm"]);

/**
 * The package manager the folder's project uses (the folder first, then the repo
 * root, first lockfile wins, as the briefing picks its install command) when it is
 * not in remote.tools; undefined when there is none or it will be on the Sprite.
 */
export function missingPackageManager(
  folder: string,
  repoRoot: string,
  tools: readonly string[],
): { tool: string; lockfile: string } | undefined {
  for (const dir of [folder, repoRoot]) {
    for (const [lockfile, tool] of LOCKFILES) {
      if (!existsSync(join(dir, lockfile))) continue;
      if (ALWAYS_THERE.has(tool) || tools.includes(tool)) return undefined;
      return { tool, lockfile: dir === folder ? lockfile : join(dir, lockfile) };
    }
  }
  return undefined;
}
