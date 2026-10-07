// The laptop side of the git protocol. Nothing here moves a local ref, the index or
// the working tree: the job branch exists only on origin.

import { copyFile, mkdtemp, rm } from "node:fs/promises";
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

  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
  if (origin.code !== 0) {
    throw new Error(`${repoRoot} has no origin remote. pi-handoff needs one to move the work (see the plan's open questions).`);
  }
  const head = await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  if (head.code !== 0) throw new Error(`${repoRoot} has no commits yet.`);
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
  const tmp = await mkdtemp(join(tmpdir(), "pi-handoff-index-"));
  try {
    const indexPath = await git(info.repoRoot, ["rev-parse", "--git-path", "index"]);
    const realIndex = isAbsolute(indexPath) ? indexPath : join(info.repoRoot, indexPath);
    const tmpIndex = join(tmp, "index");
    try {
      await copyFile(realIndex, tmpIndex);
    } catch {
      // No index yet: git builds one from scratch.
    }
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(info.repoRoot, ["add", "-A"], env);
    const tree = await git(info.repoRoot, ["write-tree"], env);
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
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** `<base>-handoff-<n>` with the next n not taken on origin. */
export async function nextJobBranch(info: GitInfo): Promise<string> {
  const base = info.branch ?? `detached-${info.head.slice(0, 7)}`;
  const prefix = `${base}-handoff-`;
  const out = await git(info.repoRoot, ["ls-remote", "--heads", "origin", `refs/heads/${prefix}*`]);
  let max = 0;
  for (const line of out.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref === undefined) continue;
    const n = Number(ref.slice(`refs/heads/${prefix}`.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

/**
 * Push a commit straight to a new branch on origin; no local branch is created.
 * --no-verify: a snapshot of work in progress would trip pre-push checks.
 */
export async function pushJobBranch(info: GitInfo, sha: string, branch: string): Promise<void> {
  await git(info.repoRoot, ["push", "--no-verify", "origin", `${sha}:refs/heads/${branch}`]);
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
  ]);
  return out.split("\0").filter((f) => f !== "");
}
