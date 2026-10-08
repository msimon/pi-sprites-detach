// /handoff cleanup: remove what a pull left on the laptop for a job: its worktree
// (pull --worktree), the local branch made for it, and the fetched origin/<branch>.
// With `remote` it also deletes the job branch on origin. Only once the work is
// merged, or with `discard`; never over uncommitted changes unless `discard`.

import { existsSync } from "node:fs";
import { run, runOk } from "./exec.ts";
import type { LocalJob } from "./jobs.ts";

/** A pulled job with a git branch, not cleaned up yet. */
export const canCleanup = (job: LocalJob): boolean =>
  job.state === "pulled" && job.protocol === "git" && job.jobBranch !== undefined && job.cleanedAt === undefined;

export interface CleanupOptions {
  /** Remove even with uncommitted changes in the worktree or commits that are not merged. */
  discard: boolean;
  /** Also delete the job branch on origin. */
  remote: boolean;
}

export interface CleanupPlan {
  repoRoot: string;
  branch: string;
  base: string | undefined;
  /** The job's worktree, when one exists on disk. */
  worktree: string | undefined;
  /** `git status --short` lines of that worktree. */
  dirty: string[];
  localBranch: boolean;
  trackingRef: boolean;
  /** Whether the branch's work is in the base branch; undefined when that cannot be told. */
  merged: boolean | undefined;
  /** Commits on the branch that the base does not have, when known. */
  unmerged: number | undefined;
}

const git = (cwd: string, args: string[], timeoutMs = 60_000) => run("git", args, { cwd, timeoutMs });

async function repoRootOf(job: LocalJob): Promise<string> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: job.folder });
  if (top.code !== 0) throw new Error(`${job.folder} is no longer a git repository`);
  return top.stdout.trim();
}

/** GitHub squash and rebase merges leave the branch tip outside the base: ask the pull request. */
async function mergedOnGitHub(cwd: string, branch: string): Promise<boolean> {
  try {
    const result = await run("gh", ["pr", "view", branch, "--json", "state", "-q", ".state"], { cwd, timeoutMs: 20_000 });
    return result.code === 0 && result.stdout.trim() === "MERGED";
  } catch {
    return false;
  }
}

/** Look at what is there, and whether it is safe to remove. Changes nothing but the base's tracking ref. */
export async function planCleanup(job: LocalJob, options: Pick<CleanupOptions, "remote">): Promise<CleanupPlan> {
  const branch = job.jobBranch;
  if (job.state !== "pulled") throw new Error(`${job.jobId} is not pulled yet: pull it first, then clean up`);
  if (job.protocol !== "git" || branch === undefined) throw new Error(`${job.jobId} has no git branch to clean up`);
  const repoRoot = await repoRootOf(job);

  const worktree = job.worktree !== undefined && existsSync(job.worktree) ? job.worktree : undefined;
  const dirty =
    worktree === undefined
      ? []
      : (await git(worktree, ["status", "--short"])).stdout.split("\n").filter((line) => line.trim() !== "");
  const exists = async (ref: string): Promise<boolean> =>
    (await git(repoRoot, ["rev-parse", "--verify", "--quiet", ref])).code === 0;
  const localBranch = await exists(`refs/heads/${branch}`);
  let trackingRef = await exists(`refs/remotes/origin/${branch}`);

  // Deleting on origin with nothing fetched: fetch it, so there is a tip to check.
  if (options.remote && !localBranch && !trackingRef) {
    await git(repoRoot, ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 120_000);
    trackingRef = await exists(`refs/remotes/origin/${branch}`);
  }

  const base = job.baseBranch;
  let merged: boolean | undefined;
  let unmerged: number | undefined;
  const tip = localBranch ? `refs/heads/${branch}` : trackingRef ? `refs/remotes/origin/${branch}` : undefined;
  if (tip !== undefined && base !== undefined) {
    // The base on origin may have moved since (the pull request was merged): bring it up to date.
    await git(repoRoot, ["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], 120_000);
    if (await exists(`refs/remotes/origin/${base}`)) {
      merged = (await git(repoRoot, ["merge-base", "--is-ancestor", tip, `refs/remotes/origin/${base}`])).code === 0;
      if (!merged) {
        const count = await git(repoRoot, ["rev-list", "--count", `refs/remotes/origin/${base}..${tip}`]);
        unmerged = Number(count.stdout.trim()) || undefined;
        if (await mergedOnGitHub(repoRoot, branch)) merged = true;
      }
    }
  }
  return { repoRoot, branch, base, worktree, dirty, localBranch, trackingRef, merged, unmerged };
}

/** Why this cleanup must not go ahead, empty when it is safe (or `discard` accepts the risk). */
export function blockers(plan: CleanupPlan, options: CleanupOptions): string[] {
  if (options.discard) return [];
  const reasons: string[] = [];
  if (plan.dirty.length > 0) {
    const shown = plan.dirty.slice(0, 5).join("; ");
    reasons.push(`the worktree ${plan.worktree} has uncommitted changes (${shown}${plan.dirty.length > 5 ? "; …" : ""})`);
  }
  if (plan.merged === false) {
    reasons.push(
      `${plan.branch} has ${plan.unmerged ?? "some"} commit${plan.unmerged === 1 ? "" : "s"} that ${plan.base ?? "the base branch"} does not have yet`,
    );
  } else if (plan.merged === undefined && (plan.localBranch || plan.trackingRef)) {
    reasons.push(`cannot tell whether ${plan.branch} is merged${plan.base === undefined ? " (no base branch recorded)" : ""}`);
  }
  return reasons;
}

/** What the cleanup will remove, one line each, for the confirmation. */
export function describePlan(plan: CleanupPlan, options: CleanupOptions): string[] {
  const lines: string[] = [];
  if (plan.worktree !== undefined) lines.push(`the worktree ${plan.worktree}`);
  if (plan.localBranch) lines.push(`the local branch ${plan.branch}`);
  if (plan.trackingRef) lines.push(`the fetched origin/${plan.branch}`);
  if (options.remote) lines.push(`the branch ${plan.branch} on origin (it cannot be undone from here)`);
  return lines;
}

export interface CleanupResult {
  job: LocalJob;
  removed: string[];
}

/** `known`: the plan the caller already made (to show it), so it is not made twice. */
export async function cleanupJob(
  job: LocalJob,
  options: CleanupOptions,
  progress: (text: string) => void,
  known?: CleanupPlan,
): Promise<CleanupResult> {
  progress("looking at what is there…");
  const plan = known ?? (await planCleanup(job, options));
  const reasons = blockers(plan, options);
  if (reasons.length > 0) {
    throw new Error(`not cleaning up ${job.jobId}: ${reasons.join("; and ")}. Fix that, or use --discard to remove it anyway.`);
  }
  const removed: string[] = [];

  if (job.worktree !== undefined) {
    progress("removing the worktree…");
    if (plan.worktree !== undefined) {
      await runOk("git", ["worktree", "remove", ...(options.discard ? ["--force"] : []), plan.worktree], { cwd: plan.repoRoot });
      removed.push(`worktree ${plan.worktree}`);
    }
    await git(plan.repoRoot, ["worktree", "prune"]);
  }
  if (plan.localBranch) {
    await runOk("git", ["branch", "-D", plan.branch], { cwd: plan.repoRoot });
    removed.push(`local branch ${plan.branch}`);
  }
  if (plan.trackingRef) {
    await runOk("git", ["update-ref", "-d", `refs/remotes/origin/${plan.branch}`], { cwd: plan.repoRoot });
    removed.push(`fetched origin/${plan.branch}`);
  }
  if (options.remote) {
    progress(`deleting ${plan.branch} on origin…`);
    await runOk("git", ["push", "--no-verify", "origin", "--delete", plan.branch], { cwd: plan.repoRoot, timeoutMs: 120_000 });
    removed.push(`${plan.branch} on origin`);
  }

  const { worktree: _gone, ...rest } = job;
  return { job: { ...rest, cleanedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, removed };
}
