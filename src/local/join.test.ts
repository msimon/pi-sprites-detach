import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobState, LocalJob } from "./jobs.ts";
import { attachCommand, canJoin, shellQuote } from "./join.ts";

const job = (state: JobState) => ({ state }) as LocalJob;

test("canJoin: finished jobs, and joined ones again; not running or pulled", () => {
  for (const state of ["done", "needs_input", "error", "aborted", "joined"] as const) assert.equal(canJoin(job(state)), true);
  for (const state of ["starting", "preparing", "running", "pulled"] as const) assert.equal(canJoin(job(state)), false);
});

test("attachCommand runs detach-attach over sprite exec --tty", () => {
  assert.equal(
    attachCommand({ jobId: "h3", sprite: "pi-handoff" }, "/Users/m/.local/bin/sprite"),
    "/Users/m/.local/bin/sprite exec -s pi-handoff --tty -- /home/sprite/.pi-sprites-detach/sprite/bin/detach-attach h3",
  );
});

test("shellQuote leaves plain words alone and quotes the rest", () => {
  assert.equal(shellQuote("pi-handoff"), "pi-handoff");
  assert.equal(shellQuote("/Users/Marc Simon/bin/sprite"), "'/Users/Marc Simon/bin/sprite'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});
