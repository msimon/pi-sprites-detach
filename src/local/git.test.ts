import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyIndex, parseOrigin, projectPathspecs, pushNewJobBranch } from "./git.ts";

test("copyIndex keeps the index's timestamps, so git still re-checks racily clean entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-detach-index-test-"));
  try {
    const from = join(root, "index");
    writeFileSync(from, "x");
    const past = new Date(Date.parse("2026-01-01T00:00:00Z"));
    utimesSync(from, past, past);
    await copyIndex(from, join(root, "copy"));
    assert.equal(statSync(join(root, "copy")).mtimeMs, past.getTime());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pushNewJobBranch: concurrent pushes of the same commit get different branches", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-detach-git-test-"));
  try {
    const g = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    g(root, "init", "-q", "--bare", origin);
    g(root, "init", "-q", "-b", "main", work);
    g(work, "remote", "add", "origin", origin);
    writeFileSync(join(work, "a.txt"), "a\n");
    g(work, "add", "a.txt");
    g(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    const head = g(work, "rev-parse", "HEAD");
    const info = { repoRoot: work, branch: "main", head, originUrl: origin, cloneUrl: origin, repoKey: "t/work" };

    const branches = await Promise.all([1, 2, 3].map(() => pushNewJobBranch(info, info.head)));
    assert.deepEqual([...branches].sort(), ["main-detach-1", "main-detach-2", "main-detach-3"]);
    assert.equal(await pushNewJobBranch(info, info.head), "main-detach-4");
    // A window that read origin before another pushed the same commit: git calls the
    // push up to date, which must not count as creating the branch.
    assert.equal(await pushNewJobBranch(info, info.head, { startAt: 4 }), "main-detach-5");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseOrigin: GitHub SSH and HTTPS become an HTTPS clone URL", () => {
  for (const url of [
    "git@github.com:msimon/pi-handoff.git",
    "https://github.com/msimon/pi-handoff.git",
    "https://github.com/msimon/pi-handoff",
    "ssh://git@github.com/msimon/pi-handoff.git",
  ]) {
    assert.deepEqual(parseOrigin(url), {
      cloneUrl: "https://github.com/msimon/pi-handoff.git",
      repoKey: "msimon/pi-handoff",
    });
  }
});

test("parseOrigin: other hosts keep their URL", () => {
  assert.deepEqual(parseOrigin("git@gitlab.com:group/sub/repo.git"), {
    cloneUrl: "git@gitlab.com:group/sub/repo.git",
    repoKey: "sub/repo",
  });
});

test("projectPathspecs: names at any depth, folders, anchored paths", () => {
  assert.deepEqual(projectPathspecs([".env*", ".scratch/", "config/local.json", "/top.txt"]), [
    ":(glob)**/.env*",
    ":(glob)**/.scratch/**",
    ":(glob)config/local.json",
    ":(glob)top.txt",
  ]);
});
