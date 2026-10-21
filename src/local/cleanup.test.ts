import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canCleanup, cleanupJob } from "./cleanup.ts";
import { g, has, setupPulledJob as setup } from "./git-fixture.ts";
import type { LocalJob } from "./jobs.ts";

const quiet = () => {};

test("canCleanup: a pulled git job that is not cleaned up yet", () => {
  const base = { jobId: "h1", protocol: "git", jobBranch: "b" } as LocalJob;
  assert.equal(canCleanup({ ...base, state: "pulled" }), true);
  assert.equal(canCleanup({ ...base, state: "pulled", cleanedAt: "2026-01-01" }), false);
  assert.equal(canCleanup({ ...base, state: "done" }), false);
  assert.equal(canCleanup({ ...base, state: "pulled", protocol: "none" }), false);
});

test("a merged job: the worktree, local branch and fetched ref go; origin keeps its branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-cleanup-"));
  try {
    const { origin, work, wt, job } = setup(root, { merged: true });
    const { job: after, removed } = await cleanupJob(job, { discard: false, remote: false }, quiet);
    assert.equal(existsSync(wt), false);
    assert.equal(has(work, "refs/heads/main-handoff-1"), false);
    assert.equal(has(work, "refs/remotes/origin/main-handoff-1"), false);
    assert.match(g(work, "worktree", "list"), /^[^\n]*work\s/);
    assert.equal(g(work, "worktree", "list").split("\n").length, 1);
    assert.ok(g(origin, "branch").includes("main-handoff-1"), "origin keeps the branch");
    assert.equal(after.worktree, undefined);
    assert.ok(after.cleanedAt);
    assert.equal(removed.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unmerged work is refused, and removed with discard", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-cleanup-"));
  try {
    const { work, wt, job } = setup(root, { merged: false });
    await assert.rejects(cleanupJob(job, { discard: false, remote: false }, quiet), /1 commit that main does not have yet/);
    assert.equal(existsSync(wt), true, "nothing was removed");
    assert.equal(has(work, "refs/heads/main-handoff-1"), true);
    await cleanupJob(job, { discard: true, remote: false }, quiet);
    assert.equal(existsSync(wt), false);
    assert.equal(has(work, "refs/heads/main-handoff-1"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work in the local base only (pull's fast-forward, not pushed yet) counts as merged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-cleanup-"));
  try {
    const { work, wt, job } = setup(root, { merged: false });
    g(work, "merge", "-q", "--ff-only", "main-handoff-1");
    await cleanupJob(job, { discard: false, remote: false }, quiet);
    assert.equal(existsSync(wt), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncommitted changes in the worktree are refused, even when the work is merged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-cleanup-"));
  try {
    const { wt, job } = setup(root, { merged: true });
    writeFileSync(join(wt, "scratch.txt"), "not committed\n");
    await assert.rejects(cleanupJob(job, { discard: false, remote: false }, quiet), /uncommitted changes.*scratch\.txt/);
    assert.equal(existsSync(join(wt, "scratch.txt")), true);
    await cleanupJob(job, { discard: true, remote: false }, quiet);
    assert.equal(existsSync(wt), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote: also deletes the branch on origin, only for merged work or with discard", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-cleanup-"));
  try {
    mkdirSync(join(root, "u"));
    mkdirSync(join(root, "m"));
    const unmerged = setup(join(root, "u"), { merged: false });
    await assert.rejects(cleanupJob(unmerged.job, { discard: false, remote: true }, quiet), /does not have yet/);
    assert.ok(g(unmerged.origin, "branch").includes("main-handoff-1"));

    const merged = setup(join(root, "m"), { merged: true });
    const { removed } = await cleanupJob(merged.job, { discard: false, remote: true }, quiet);
    assert.ok(removed.some((line) => line.includes("on origin")));
    assert.equal(g(merged.origin, "branch").includes("main-handoff-1"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
