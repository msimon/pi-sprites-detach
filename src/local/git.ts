// The laptop side of the git protocol. Nothing here moves a local ref, the index or
// the working tree: the job branch exists only on origin.

import { copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { run, runOk } from "./exec.ts";

export interface GitInfo {
  repoRoot: string;
  /** Current branch, or undefined when HEAD is detached. */
  branch: string | undefined;
  head: string;
  originUrl: string;
  /** URL the Sprite clones from: HTTPS for GitHub, so the gh token is used. */
  cloneUrl: string;
  /** `<owner>/<repo>`, the cached clone's folder under ~/repos. */
  repoKey: string;
}

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
  runOk("git", args, env === undefined ? { cwd } : { cwd, env: { ...process.env, ...env } });

/** Parse an origin URL into the clone URL and the repo key. */
export function parseOrigin(url: string): { cloneUrl: string; repoKey: string } {
  const match = /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/.exec(url.trim());
  if (match === null) throw new Error(`cannot parse origin URL: ${url}`);
  const host = match[1] as string;
  const path = match[2] as string;
  const parts = path.split("/").filter((p) => p !== "");
  const repoKey = parts.slice(-2).join("/");
  const cloneUrl = host === "github.com" ? `https://github.com/${path}.git` : url;
  return { cloneUrl, repoKey };
}

/** Git details for a folder, or undefined when it is not in a git work tree. */
export async function detectGit(folder: string): Promise<GitInfo | undefined> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: folder });
  if (top.code !== 0) return undefined;
  const repoRoot = top.stdout.trim();

  // The configured URL, not `remote get-url`, which applies the laptop's insteadOf rules.
  const origin = await run("git", ["config", "--get", "remote.origin.url"], { cwd: repoRoot });
  if (origin.code !== 0) {
    throw new Error(
      `${repoRoot} has no "origin" remote. pi-handoff moves the work through a branch pushed to origin, which the Sprite clones. Add one (git remote add origin <url>, for example a private GitHub repo) and run /handoff again.`,
    );
  }
  const head = await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  if (head.code !== 0) {
    throw new Error(`${repoRoot} has no commits yet. pi-handoff needs one to branch from: commit something and run /handoff again.`);
  }
  const branch = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repoRoot });

  const originUrl = origin.stdout.trim();
  return {
    repoRoot,
    branch: branch.code === 0 ? branch.stdout.trim() : undefined,
    head: head.stdout.trim(),
    originUrl,
    ...parseOrigin(originUrl),
  };
}

/**
 * Commit uncommitted work (tracked changes and untracked, non-ignored files) with a
 * temporary index, so the real index and working tree are untouched (S8).
 * Returns HEAD when there is nothing to commit.
 */
export async function snapshotCommit(info: GitInfo): Promise<{ sha: string; snapshot: boolean }> {
  const tree = await worktreeTree(info.repoRoot);
  const headTree = await git(info.repoRoot, ["rev-parse", "HEAD^{tree}"]);
  if (tree === headTree) return { sha: info.head, snapshot: false };
  const sha = await git(info.repoRoot, [
    "commit-tree",
    tree,
    "-p",
    info.head,
    "-m",
    "pi-handoff: snapshot of uncommitted work\n\nCommitted by /handoff so the work travels with the job.",
  ]);
  return { sha, snapshot: true };
}

/**
 * The working tree as a tree object: tracked changes and untracked, non-ignored
 * files, written through a temporary index so the real one is untouched (S8).
 */
export async function worktreeTree(repoRoot: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "pi-handoff-index-"));
  try {
    const tmpIndex = join(tmp, "index");
    try {
      await copyIndex(await indexFile(repoRoot), tmpIndex);
    } catch {
      // No index yet: git builds one from scratch.
    }
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(repoRoot, ["add", "-A"], env);
    return await git(repoRoot, ["write-tree"], env);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Copy an index file with its timestamps. Git trusts an entry's stat data only when
 * the file changed before the index was written ("racy git"); a copy stamped now
 * would make a same-size edit from the same second look clean, and it would be missed.
 */
export async function copyIndex(from: string, to: string): Promise<void> {
  await copyFile(from, to);
  const { atime, mtime } = await stat(from);
  await utimes(to, atime, mtime);
}

/** The repo's (or linked worktree's) real index file. */
export async function indexFile(repoRoot: string): Promise<string> {
  const path = await git(repoRoot, ["rev-parse", "--git-path", "index"]);
  return isAbsolute(path) ? path : join(repoRoot, path);
}

/** Where origin's copy of a branch stands against local HEAD. */
export type OriginBranchState = "missing" | "same" | "behind" | "ahead";

/**
 * `behind`: origin's tip is in local history, so a plain push brings it up to date.
 * `ahead`: origin has commits local history lacks (ahead or diverged); not even
 * fetched means not in local history either.
 */
export async function originBranchState(info: GitInfo, branch: string): Promise<OriginBranchState> {
  const ref = `refs/heads/${branch}`;
  const out = await git(info.repoRoot, ["ls-remote", "--heads", "origin", ref]);
  const sha = out
    .split("\n")
    .find((line) => line.endsWith(`\t${ref}`))
    ?.split("\t")[0];
  if (sha === undefined) return "missing";
  if (sha === info.head) return "same";
  const ancestor = await run("git", ["merge-base", "--is-ancestor", sha, info.head], { cwd: info.repoRoot });
  return ancestor.code === 0 ? "behind" : "ahead";
}

export const CONTINUE_WITHOUT_PR = "Continue without a pull request";
export const CANCEL_TO_PULL = "Cancel: I'll git pull first";

export interface BaseDecision {
  pr: "auto" | "never";
  /** Said in the start message: why there is no PR, or that the base was pushed. */
  note?: string;
}

/** The user stopped the handoff (origin has commits the local branch lacks). */
export class HandoffCancelledError extends Error {}

/**
 * For a job that will open a pull request: make sure its base branch is on origin
 * with the local commits, so the PR has the right base. Pushes HEAD when origin's
 * branch is missing or behind (hooks run: it is the user's real branch; never forced).
 * A failed push fails the handoff. When origin has commits the local branch lacks, a
 * PR would mix them in: `ask` offers to continue without one or to cancel; with no
 * way to ask, the job goes without a PR.
 */
export async function prepareBase(
  info: GitInfo,
  branch: string,
  ask: ((title: string, options: string[]) => Promise<string | undefined>) | undefined,
  progress: (text: string) => void,
): Promise<BaseDecision> {
  progress(`checking ${branch} on origin…`);
  const state = await originBranchState(info, branch);
  if (state === "same") return { pr: "auto" };
  if (state === "ahead") {
    const why = `origin/${branch} has commits your local ${branch} does not, so a pull request from this job would mix them in`;
    if (ask === undefined) return { pr: "never", note: `No pull request: ${why}. The work comes back with /handoff pull.` };
    const choice = await ask(`${why}.`, [CONTINUE_WITHOUT_PR, CANCEL_TO_PULL]);
    if (choice === CONTINUE_WITHOUT_PR) return { pr: "never", note: `No pull request: ${why}.` };
    throw new HandoffCancelledError(`Handoff cancelled. Bring ${branch} up to date (git pull), then hand off again.`);
  }
  progress(`pushing ${branch} to origin…`);
  const ref = `refs/heads/${branch}`;
  const result = await run("git", ["push", "origin", `${info.head}:${ref}`], { cwd: info.repoRoot, timeoutMs: 600_000 });
  if (result.code !== 0) {
    throw new Error(
      `the job opens a pull request against ${branch}, which needs ${branch} on origin, and pushing it failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return { pr: "auto", note: `${state === "missing" ? "Pushed" : "Updated"} ${branch} on origin, the pull request's base.` };
}

/** The highest n of the `<base>-handoff-<n>` branches on origin, 0 when none. */
async function highestJobBranch(info: GitInfo, prefix: string): Promise<number> {
  const out = await git(info.repoRoot, ["ls-remote", "--heads", "origin", `refs/heads/${prefix}*`]);
  let max = 0;
  for (const line of out.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref === undefined) continue;
    const n = Number(ref.slice(`refs/heads/${prefix}`.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/**
 * Push a commit to a new branch on origin, `<base>-handoff-<n>` with the next free n,
 * and return its name; no local branch is created. Two windows handing off from the
 * same repo at the same moment must not share a branch, and their snapshot commits can
 * be identical (same tree, parent and second). So a push counts only if it created the
 * branch: the empty lease rejects one that exists with another commit, and git's
 * porcelain `=` (already up to date) means it exists with ours. Either way, the next n.
 * --no-verify: a snapshot of work in progress would trip pre-push checks.
 * `startAt` is for tests: the n to try first instead of origin's highest + 1.
 */
export async function pushNewJobBranch(
  info: GitInfo,
  sha: string,
  { attempts = 5, startAt }: { attempts?: number; startAt?: number } = {},
): Promise<string> {
  const base = info.branch ?? `detached-${info.head.slice(0, 7)}`;
  const prefix = `${base}-handoff-`;
  let n = startAt ?? (await highestJobBranch(info, prefix)) + 1;
  for (let attempt = 1; ; attempt++) {
    const branch = `${prefix}${n}`;
    const ref = `refs/heads/${branch}`;
    const result = await run(
      "git",
      ["push", "--porcelain", "--no-verify", `--force-with-lease=${ref}:`, "origin", `${sha}:${ref}`],
      { cwd: info.repoRoot },
    );
    const line = result.stdout.split("\n").find((l) => l.includes(`\t${sha}:${ref}\t`) || l.includes(`:${ref}\t`));
    const flag = line?.[0];
    if (result.code === 0 && flag !== "=" && flag !== "!") return branch;
    const taken = flag === "=" || flag === "!" || /stale info|already exists|\[rejected\]/.test(result.stderr);
    if (!taken || attempt >= attempts) {
      throw new Error(`git push of the job branch ${branch} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    n = Math.max(n + 1, (await highestJobBranch(info, prefix)) + 1);
  }
}

/** Pathspecs for `copyProjectFiles` patterns, gitignore-style. */
export function projectPathspecs(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => {
    const dir = pattern.endsWith("/");
    const p = pattern.replace(/\/+$/, "").replace(/^\/+/, "");
    const anchored = pattern.startsWith("/") || p.includes("/");
    const base = anchored ? p : `**/${p}`;
    return `:(glob)${dir ? `${base}/**` : base}`;
  });
}

/**
 * Dependency folders never hold project files worth copying (a package's own .env,
 * say), and the agent reinstalls them anyway.
 */
const NEVER_COPY = [":(glob,exclude)**/node_modules/**", ":(glob,exclude)**/.venv/**"];

/** Git-ignored files matching the patterns, relative to the repo root. */
export async function ignoredProjectFiles(info: GitInfo, patterns: readonly string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const out = await git(info.repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...projectPathspecs(patterns),
    ...NEVER_COPY,
  ]);
  return out.split("\0").filter((f) => f !== "");
}
