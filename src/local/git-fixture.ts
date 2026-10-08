// Test helper: real git repositories for the cleanup tests. Not a test file itself.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalJob } from "./jobs.ts";

export const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export function has(cwd: string, ref: string): boolean {
  try {
    g(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * A repo with an origin, a pushed job branch `main-handoff-1` and a worktree for it,
 * made as `pull --worktree` makes it. `merged`: the branch is merged into main and
 * main is pushed. `root` must exist.
 */
export function setupPulledJob(root: string, { merged }: { merged: boolean }) {
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const wt = join(root, "wt", "h1");
  g(root, "init", "-q", "--bare", origin);
  g(root, "init", "-q", "-b", "main", work);
  g(work, "remote", "add", "origin", origin);
  writeFileSync(join(work, "a.txt"), "a\n");
  g(work, "add", "a.txt");
  g(work, "commit", "-qm", "a");
  g(work, "push", "-q", "origin", "main");
  g(work, "switch", "-q", "-c", "main-handoff-1");
  writeFileSync(join(work, "b.txt"), "b\n");
  g(work, "add", "b.txt");
  g(work, "commit", "-qm", "b");
  g(work, "push", "-q", "origin", "main-handoff-1");
  g(work, "switch", "-q", "main");
  g(work, "branch", "-q", "-D", "main-handoff-1");
  g(work, "fetch", "-q", "origin");
  g(work, "worktree", "add", "-q", "--track", "-b", "main-handoff-1", wt, "origin/main-handoff-1");
  if (merged) {
    g(work, "merge", "-q", "--no-ff", "-m", "merge", "main-handoff-1");
    g(work, "push", "-q", "origin", "main");
  }
  const job = {
    jobId: "h1",
    jobName: "Test job [h1]",
    state: "pulled",
    protocol: "git",
    folder: work,
    jobBranch: "main-handoff-1",
    baseBranch: "main",
    worktree: wt,
  } as LocalJob;
  return { origin, work, wt, job };
}
