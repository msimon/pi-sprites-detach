// returnBriefing: what the pulled conversation's model is told about where the work is.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocalJob } from "./jobs.ts";
import { returnBriefing } from "./pull.ts";
import type { WayBack } from "./wayback.ts";

const job = {
  jobId: "h9",
  protocol: "git",
  folder: "/Users/m/repo",
  jobBranch: "feat-detach-1",
  baseBranch: "feat",
} as LocalJob;
const way = (kind: WayBack["kind"], text: string): WayBack => ({ kind, text, where: "x" });

test("fast-forwarded: the work is in the folder", () => {
  const text = returnBriefing(job, undefined, way("fast-forwarded", "feat was fast-forwarded to the job's work (2 commits)."));
  assert.match(text, /The job's work is in the working directory \/Users\/m\/repo now: feat was fast-forwarded/);
});

test("pr: the folder does not have it until the PR is merged", () => {
  const text = returnBriefing(job, undefined, way("pr", "The job opened pull request #7: u. Merge it, then git pull on feat."));
  assert.match(text, /pull request #7.*Until then the working directory \/Users\/m\/repo does not have the work\./);
});

test("pending or manual: on origin, why, and do not merge it yourself", () => {
  for (const kind of ["pending", "manual"] as const) {
    const text = returnBriefing(job, undefined, way(kind, "Not brought into /Users/m/repo: it is on main, not feat."));
    assert.match(text, /fetched here as origin\/feat-detach-1; the working directory \/Users\/m\/repo does not have it\. Not brought into .* Do not merge it yourself unless the user asks\./);
  }
});

test("worktree: the worktree is the working directory", () => {
  const text = returnBriefing(job, "/wt/h9", way("worktree", "x"));
  assert.match(text, /checked out in the local worktree \/wt\/h9, which is the working directory now/);
});

test("no git: only the conversation came back", () => {
  assert.match(returnBriefing({ ...job, protocol: "none" } as LocalJob, undefined), /only this conversation was/);
});
