import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, jobActions, plainList, sortJobs } from "./browser.ts";
import type { JobState, LocalJob } from "./jobs.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

const job = (jobId: string, state: JobState, extra: Partial<LocalJob> = {}): LocalJob => ({
  jobId,
  jobName: `Job ${jobId} [${jobId}]`,
  sprite: "pi-handoff",
  protocol: "none",
  folder: "/tmp",
  mainSessionFile: "/tmp/s.jsonl",
  mainSessionId: "s",
  forkLeafId: "l",
  jobSessionId: "j",
  jobRoot: "/home/sprite/jobs/x",
  ownerPid: 1,
  state,
  startedAt: iso(30),
  updatedAt: iso(10),
  ...extra,
});

test("waiting jobs first (needs input, failed, done), then running, then history; newest first within", () => {
  const sorted = sortJobs([
    job("h1", "done"),
    job("h2", "running"),
    job("h3", "pulled"),
    job("h4", "done"),
    job("h5", "needs_input"),
    job("h6", "error"),
  ]);
  assert.deepEqual(
    sorted.map((j) => j.jobId),
    ["h5", "h6", "h4", "h1", "h2", "h3"],
  );
});

test("ages read naturally", () => {
  assert.equal(ago(iso(0), NOW), "just now");
  assert.equal(ago(iso(5), NOW), "5 min ago");
  assert.equal(ago(iso(150), NOW), "2 h ago");
  assert.equal(ago(iso(3 * 24 * 60), NOW), "3 d ago");
  assert.equal(ago(undefined, NOW), "");
});

test("actions follow the state", () => {
  assert.deepEqual(jobActions(job("h1", "done")), ["reply", "join", "show", "watch", "pullHere", "pullOpen", "pull"]);
  assert.deepEqual(jobActions(job("h1", "needs_input")), ["reply", "join", "show", "watch", "pullHere", "pullOpen", "pull"]);
  assert.deepEqual(jobActions(job("h1", "running")), ["watch", "abort"]);
  assert.deepEqual(jobActions(job("h1", "joined")), ["join", "abort"]);
  assert.deepEqual(jobActions(job("h1", "pulled")), []);
  assert.deepEqual(jobActions(job("h1", "pulled", { pulledSessionFile: "/tmp/x.jsonl" })), ["open", "here"]);
  // A pulled git job whose worktree and branches are still there can be cleaned up, until it is.
  const git = { protocol: "git", jobBranch: "main-handoff-1", pulledSessionFile: "/tmp/x.jsonl" } as const;
  assert.deepEqual(jobActions(job("h1", "pulled", git)), ["open", "here", "cleanup"]);
  assert.deepEqual(jobActions(job("h1", "pulled", { ...git, cleanedAt: "2026-10-08" })), ["open", "here"]);
});

test("plain list follows the filter", () => {
  const jobs = [job("h1", "done", { runEndedAt: iso(5) }), job("h2", "running")];
  assert.equal(plainList(jobs, "running", NOW), "☁ Handoff jobs (running)\nh2  running  Job h2  started 30 min ago");
  assert.equal(plainList(jobs, "pulled", NOW), "☁ No handoff jobs (pulled).");
});
