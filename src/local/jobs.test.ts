import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationName, type JobState, matchesFilter, parseFilter } from "./jobs.ts";

const job = (state: JobState) => ({ state });

test("filters follow the states; all leaves out pulled, running includes its first seconds", () => {
  assert.equal(matchesFilter(job("done"), "all"), true);
  assert.equal(matchesFilter(job("pulled"), "all"), false);
  for (const state of ["starting", "preparing", "running"] as const) assert.equal(matchesFilter(job(state), "running"), true);
  assert.equal(matchesFilter(job("error"), "failed"), true);
  assert.equal(matchesFilter(job("needs_input"), "needs_input"), true);
  assert.equal(matchesFilter(job("done"), "needs_input"), false);
  assert.equal(matchesFilter(job("pulled"), "pulled"), true);
});

test("typed filters accept spaces, dashes and error", () => {
  assert.equal(parseFilter("needs-input"), "needs_input");
  assert.equal(parseFilter("Needs input"), "needs_input");
  assert.equal(parseFilter("error"), "failed");
  assert.equal(parseFilter("running"), "running");
  assert.equal(parseFilter("nope"), undefined);
});

test("conversation name drops the job suffix", () => {
  assert.equal(conversationName({ jobId: "h2", jobName: "Fix login [h2]" }), "Fix login");
  assert.equal(conversationName({ jobId: "h2", jobName: "Fix login" }), "Fix login");
});
