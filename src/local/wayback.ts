// How a pulled git job's work gets back to the user's branch (git protocol: the way back).
//
// - pr: auto and the job opened a pull request: the PR is the way back (merge it, then
//   git pull); nothing local changes.
// - Otherwise: fast-forward the base branch to the job branch, when the folder is still
//   on that branch at the commit the job started from. Uncommitted changes there are fine: the
//   job branch starts with them (the snapshot commit), and anything edited since is
//   merged back on top, uncommitted, unless it conflicts with the job's changes.
// - Anything else changes nothing and says why. `pending` cases (wrong branch checked
//   out, conflicting edits, gh failing) can be retried with /detach pull <job>.

import { lstatSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runOk } from "./exec.ts";
import { copyIndex, indexFile, worktreeTree } from "./git.ts";
import type { LocalJob } from "./jobs.ts";

export type WayBackKind = "fast-forwarded" | "pr" | "worktree" | "pending" | "manual";

export interface WayBack {
  kind: WayBackKind;
  /** What happened or what to do, for the user and for the model alike. */
  text: string;
  /** Where the work is, in a few words (the return line). */
  where: string;
  /** fast-forwarded: the commit the base branch points at now. */
  jobHead?: string;
  /** fast-forwarded: the job branch is gone from origin (and its fetched ref here). */
  branchDeleted?: boolean;
}

export interface PullRequestInfo {
  state: "OPEN" | "MERGED" | "CLOSED";
  number: number;
  url: string;
}

export type FindPullRequest = (repoRoot: string, branch: string) => Promise<PullRequestInfo | undefined>;

/** The job branch's pull request: an open one first, then a merged one. Throws when gh fails. */
export const findPullRequest: FindPullRequest = async (repoRoot, branch) => {
  const out = await runOk(
    "gh",
    ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,url", "--limit", "20"],
    { cwd: repoRoot, timeoutMs: 30_000 },
  );
  let prs: PullRequestInfo[];
  try {
    prs = JSON.parse(out === "" ? "[]" : out) as PullRequestInfo[];
  } catch (error: unknown) {
    throw new Error(`gh pr list returned something unreadable: ${(error as Error).message}`);
  }
  return prs.find((p) => p.state === "OPEN") ?? prs.find((p) => p.state === "MERGED") ?? prs[0];
};

/** A pulled job whose work could not be brought back yet, and can be retried. */
export const needsWayBack = (job: Pick<LocalJob, "state" | "wayBack">): boolean =>
  job.state === "pulled" && job.wayBack === "pending";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Bring the fetched job branch (origin/<jobBranch>) back; never throws for an expected refusal. */
export async function bringWorkBack(job: LocalJob, deps: { findPr?: FindPullRequest } = {}): Promise<WayBack> {
  const branch = job.jobBranch;
  if (job.protocol !== "git" || branch === undefined) {
    return { kind: "manual", where: "conversation only", text: "No git branch: only the conversation came back." };
  }
  const repoRoot = await runOk("git", ["rev-parse", "--show-toplevel"], { cwd: job.folder });
  const git = (args: string[]) => run("git", args, { cwd: repoRoot, timeoutMs: 120_000 });
  const gitOk = (args: string[]) => runOk("git", args, { cwd: repoRoot, timeoutMs: 120_000 });
  const remoteRef = `refs/remotes/origin/${branch}`;
  const jobHead = await gitOk(["rev-parse", "--verify", remoteRef]);
  const onOrigin = `origin/${branch}`;
  const again = `run /detach pull ${job.jobId} again`;
  const yourself = `merge origin/${branch} yourself`;
  const pending = (text: string): WayBack => ({ kind: "pending", where: onOrigin, text });
  const manual = (text: string): WayBack => ({ kind: "manual", where: onOrigin, text });
  const base = job.baseBranch;

  // pr: auto: a pull request, if the job opened one, is the way back.
  if ((job.pr ?? "auto") === "auto") {
    let pr: PullRequestInfo | undefined;
    try {
      pr = await (deps.findPr ?? findPullRequest)(repoRoot, branch);
    } catch (error: unknown) {
      return pending(
        `Could not check GitHub for a pull request from ${branch} (${(error as Error).message}), so the work was not brought into ${job.folder}. Fix gh (gh auth status) and ${again}, or ${yourself}.`,
      );
    }
    if (pr?.state === "OPEN") {
      return { kind: "pr", where: `PR #${pr.number}`, text: `The job opened pull request #${pr.number}: ${pr.url}. Merge it, then git pull on ${base ?? "its base branch"}.` };
    }
    if (pr?.state === "MERGED") {
      return { kind: "pr", where: `PR #${pr.number}`, text: `The job's pull request #${pr.number} is merged (${pr.url}): git pull on ${base ?? "its base branch"} to get it.` };
    }
  }

  const baseHead = job.baseHead;
  if (base === undefined || baseHead === undefined) {
    return manual(`The handoff was made from a detached HEAD, so there is no branch to fast-forward: ${yourself}.`);
  }
  const current = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const on = current.code === 0 ? current.stdout.trim() : undefined;
  if (on !== base) {
    return pending(`Not brought into ${job.folder}: it is ${on === undefined ? "on a detached HEAD" : `on ${on}`}, not ${base}. Switch back to ${base} and ${again}.`);
  }
  const head = await gitOk(["rev-parse", "HEAD"]);
  if (head !== baseHead) {
    const count = await git(["rev-list", "--count", `${baseHead}..HEAD`]);
    const n = Number(count.stdout.trim());
    const moved = count.code === 0 && n > 0 ? `has ${plural(n, "commit")} since detaching` : "moved since detaching";
    return manual(`Not brought into ${job.folder}: ${base} ${moved}. Merge origin/${branch} into it yourself.`);
  }
  if ((await git(["merge-base", "--is-ancestor", baseHead, jobHead])).code !== 0) {
    return manual(`origin/${branch} no longer builds on the commit the job started from: ${yourself}.`);
  }

  // S: where the folder's uncommitted work started (the snapshot, or the commit the job started from).
  const start = job.snapshotSha ?? (job.snapshot === true ? await oldSnapshot(gitOk, baseHead, jobHead) : baseHead);
  if (start === undefined) return manual(`Cannot tell the changes that went with the job from later ones: ${yourself}.`);
  // W: the folder now. Merged with the job's work (J) from S, without touching anything.
  const now = await worktreeTree(repoRoot);
  const kept = now !== (await gitOk(["rev-parse", `${start}^{tree}`]));
  const merged = await git(["merge-tree", "--write-tree", "--name-only", `--merge-base=${start}`, jobHead, now]);
  const [resultTree = "", ...rest] = merged.stdout.split("\n");
  if (merged.code === 1) {
    const files = rest.slice(0, rest.indexOf("") === -1 ? undefined : rest.indexOf("")).filter((f) => f !== "");
    return pending(
      `Not brought into ${job.folder}: the changes made there since detaching conflict with the job's in ${files.join(", ") || "some files"}. Commit or stash them and ${yourself}, or undo them and ${again}.`,
    );
  }
  const Again = `${again[0]?.toUpperCase()}${again.slice(1)}`;
  if (merged.code !== 0) return pending(`Not brought into ${job.folder}: git merge-tree failed (${merged.stderr.trim()}). ${Again} once fixed, or ${yourself}.`);

  // git read-tree -u overwrites ignored files without a word: refuse first.
  const blocking = await pathsInTheWay(repoRoot, now, resultTree);
  if (blocking.length > 0) {
    return pending(
      `Not brought into ${job.folder}: the job adds ${blocking.join(", ")}, which already exist there untracked (git-ignored). Move them aside and ${again}, or ${yourself}.`,
    );
  }
  const applied = await applyFastForward(repoRoot, base, baseHead, jobHead, now, resultTree, branch);
  if (applied !== undefined) return pending(`Not brought into ${job.folder}: ${applied}. ${Again} once that is fixed, or ${yourself}.`);

  const n = Number(await gitOk(["rev-list", "--count", `${baseHead}..${jobHead}`]));
  const deleted = await run("git", ["push", "--no-verify", "origin", "--delete", branch], { cwd: repoRoot, timeoutMs: 120_000 });
  if (deleted.code === 0) await git(["update-ref", "-d", remoteRef]);
  const parts = [
    n === 0 ? `The job made no commits; ${base} is unchanged.` : `${base} was fast-forwarded to the job's work (${plural(n, "commit")}).`,
    ...(job.snapshotSha !== undefined || job.snapshot === true ? ["The uncommitted changes that went with the detach are in it as a snapshot commit."] : []),
    ...(kept ? ["Changes made in the folder since detaching are still there, uncommitted."] : []),
    deleted.code === 0
      ? `Deleted ${branch} on origin.`
      : `Could not delete ${branch} on origin (${(deleted.stderr || deleted.stdout).trim()}): /detach cleanup ${job.jobId} --remote removes it.`,
    ...(n === 0 ? [] : [`${base} is not pushed yet.`]),
  ];
  return { kind: "fast-forwarded", where: `on ${base}`, text: parts.join(" "), jobHead, branchDeleted: deleted.code === 0 };
}

/**
 * Paths the merge adds that the folder already has outside git: W holds every
 * non-ignored file, so these are ignored files (or files where the job needs a folder).
 */
async function pathsInTheWay(repoRoot: string, worktree: string, result: string): Promise<string[]> {
  const added = await runOk("git", ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", worktree, result], { cwd: repoRoot });
  const blocking: string[] = [];
  for (const path of added.split("\0").filter((p) => p !== "")) {
    const parts = path.split("/");
    const clash = parts.some((_, i) => {
      const stat = lstatSync(join(repoRoot, ...parts.slice(0, i + 1)), { throwIfNoEntry: false });
      return stat !== undefined && (i === parts.length - 1 || !stat.isDirectory());
    });
    if (clash) blocking.push(path);
  }
  return blocking;
}

/** Records from before snapshotSha: the snapshot is the job branch's first commit. */
async function oldSnapshot(gitOk: (args: string[]) => Promise<string>, baseHead: string, jobHead: string): Promise<string | undefined> {
  const first = (await gitOk(["rev-list", "--reverse", "--first-parent", `${baseHead}..${jobHead}`])).split("\n")[0];
  if (first === undefined || first === "") return undefined;
  const subject = await gitOk(["log", "-1", "--format=%s", first]);
  // Either name: snapshots from before and after the rename.
  return /^(pi-handoff|pi-sprites-detach): snapshot/.test(subject) ? first : undefined;
}

/**
 * Move the base branch from baseHead to the job's tip and the folder from tree W to
 * the merged tree R: the ref first (refused if the branch moved), then the files
 * (refused if an untracked or ignored file is in the way), then the index to the new
 * HEAD so later edits show as unstaged and new files as untracked. On a refusal the
 * ref and the index are put back. Returns why it was refused, or undefined.
 */
async function applyFastForward(
  repoRoot: string,
  base: string,
  baseHead: string,
  jobHead: string,
  worktree: string,
  result: string,
  branch: string,
): Promise<string | undefined> {
  const git = (args: string[]) => run("git", args, { cwd: repoRoot, timeoutMs: 300_000 });
  const ref = `refs/heads/${base}`;
  const moved = await git(["update-ref", "-m", `pi-sprites-detach: fast-forward to ${branch}`, ref, jobHead, baseHead]);
  if (moved.code !== 0) return `${base} moved while the work was being brought back (${moved.stderr.trim()})`;

  const index = await indexFile(repoRoot);
  const tmp = await mkdtemp(join(tmpdir(), "pi-detach-wayback-"));
  const backup = join(tmp, "index");
  let hadIndex = true;
  try {
    await copyIndex(index, backup).catch(() => {
      hadIndex = false;
    });
    const steps: string[][] = [["read-tree", worktree], ["update-index", "-q", "--refresh"], ["read-tree", "-m", "-u", worktree, result]];
    for (const step of steps) {
      const done = await git(step);
      // update-index --refresh exits 1 when entries need updating; read-tree -m checks for itself.
      if (done.code !== 0 && step[0] !== "update-index") {
        await git(["update-ref", "-m", "pi-sprites-detach: fast-forward undone", ref, baseHead, jobHead]);
        if (hadIndex) await copyIndex(backup, index);
        else await rm(index, { force: true });
        return (done.stderr || done.stdout).trim().split("\n")[0] ?? "git read-tree failed";
      }
    }
    await git(["reset", "-q"]);
    return undefined;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
