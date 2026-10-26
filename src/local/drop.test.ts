// dropJob: discard a finished job's work, keep its conversation. Real repos (a bare
// origin with the job branch, the user's folder); the Sprite is a fake.

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// Job records go under HOME (paths.ts reads it when it loads): a temp HOME first.
const root = mkdtempSync(join(tmpdir(), "pi-detach-drop-test-"));
process.env.HOME = root;
const { canDrop, DropRefusedError, dropJob } = await import("./drop.ts");
const { g, has } = await import("./git-fixture.ts");
const { matchesFilter, readJob } = await import("./jobs.ts");
type LocalJob = import("./jobs.ts").LocalJob;
type DropSprite = import("./drop.ts").DropSprite;
after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
const quiet = () => {};

/** A done job: the folder on feat, its job branch on origin, a session file "on the Sprite". */
function setup(state: LocalJob["state"] = "done") {
  const dir = join(root, String(++count));
  mkdirSync(dir);
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  g(dir, "init", "-q", "--bare", "-b", "main", origin);
  g(dir, "init", "-q", "-b", "feat", work);
  g(work, "remote", "add", "origin", origin);
  writeFileSync(join(work, "a.txt"), "a\n");
  g(work, "add", "a.txt");
  g(work, "commit", "-qm", "a");
  const head = g(work, "rev-parse", "HEAD");
  g(work, "push", "-q", "origin", `${head}:refs/heads/feat-detach-1`);
  g(work, "fetch", "-q", "origin", "+refs/heads/feat-detach-1:refs/remotes/origin/feat-detach-1");
  writeFileSync(join(work, "mine.txt"), "uncommitted\n");

  const sessions = join(dir, "sessions");
  mkdirSync(sessions);
  const remote = SessionManager.create(work, join(dir, "remote"));
  remote.appendMessage({ role: "user", content: "do the thing", timestamp: Date.now() } as never);
  const remoteFile = remote.getSessionFile() as string;

  const job = {
    jobId: `h${count}`,
    jobName: `t [h${count}]`,
    sprite: "s",
    protocol: "git",
    folder: work,
    mainSessionFile: join(sessions, "main.jsonl"),
    mainSessionId: "m",
    forkLeafId: "",
    jobSessionId: "j",
    jobBranch: "feat-detach-1",
    baseBranch: "feat",
    baseHead: head,
    jobRoot: "/home/sprite/jobs/x",
    ownerPid: 1,
    state,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as LocalJob;

  const calls: string[] = [];
  /** `running`: a run is alive on the Sprite until stop is called (`stops: false`: it survives). */
  const sprite = (over: Partial<DropSprite> = {}, live = { running: false, stops: true }): DropSprite => ({
    inspect: async () => ({ running: live.running, session: true }),
    stop: async () => {
      calls.push("stop");
      if (live.stops) live.running = false;
    },
    download: async (_job, to) => {
      calls.push("download");
      copyFileSync(remoteFile, to);
    },
    clean: async () => {
      calls.push("clean");
    },
    ...over,
  });
  return { origin, work, job, sprite, calls, head };
}

const onOrigin = (origin: string): boolean => has(origin, "refs/heads/feat-detach-1");

test("canDrop: any job still on the Sprite, running ones too", () => {
  const j = (state: LocalJob["state"]) => ({ state }) as LocalJob;
  for (const s of ["starting", "preparing", "running", "joined", "done", "needs_input", "error", "aborted"] as const) {
    assert.equal(canDrop(j(s)), true, s);
  }
  for (const s of ["pulled", "dropped"] as const) assert.equal(canDrop(j(s)), false, s);
});

test("drop: branch deleted, conversation saved with a briefing, Sprite cleaned, folder untouched", async () => {
  const f = setup("aborted");
  const { job, lines } = await dropJob(f.job, { keepBranch: false, stopRun: false }, quiet, f.sprite());
  assert.equal(job.state, "dropped");
  assert.ok(job.cleanedAt);
  assert.equal(job.cleanupPending, undefined);
  assert.equal(onOrigin(f.origin), false);
  assert.equal(has(f.work, "refs/remotes/origin/feat-detach-1"), false);
  // The folder: same commit, its uncommitted file still there.
  assert.equal(g(f.work, "rev-parse", "HEAD"), f.head);
  assert.equal(readFileSync(join(f.work, "mine.txt"), "utf8"), "uncommitted\n");
  assert.deepEqual(f.calls, ["download", "clean"]);

  const saved = job.pulledSessionFile as string;
  const entries = SessionManager.open(saved).getEntries();
  const last = entries.at(-1) as { customType?: string; content?: string };
  assert.equal(last.customType, "pi-handoff-return");
  assert.match(last.content ?? "", /dropped this job: its work was discarded.*branch feat-detach-1 was deleted on origin/);
  assert.equal(JSON.parse(readFileSync(saved, "utf8").split("\n")[0] as string).cwd, f.work);
  assert.match(lines.join(" "), /Deleted feat-detach-1 on origin\..*Removed from the Sprite\./);

  // Recorded, and hidden from "all" like a pulled job.
  const record = await readJob(f.job.jobId);
  assert.equal(record?.state, "dropped");
  assert.equal(matchesFilter({ state: "dropped" }, "all"), false);
  assert.equal(matchesFilter({ state: "dropped" }, "dropped"), true);
});

test("--keep-branch: the branch stays on origin, and the job is not marked cleaned up", async () => {
  const f = setup();
  const { job } = await dropJob(f.job, { keepBranch: true, stopRun: false }, quiet, f.sprite());
  assert.equal(job.state, "dropped");
  assert.equal(onOrigin(f.origin), true);
  assert.equal(job.cleanedAt, undefined);
});

test("a running job: its run is stopped first, then it is dropped", async () => {
  const f = setup("running");
  const { job } = await dropJob(f.job, { keepBranch: false, stopRun: true }, quiet, f.sprite({}, { running: true, stops: true }));
  assert.equal(job.state, "dropped");
  assert.deepEqual(f.calls, ["stop", "download", "clean"]);
  assert.equal(onOrigin(f.origin), false);
});

test("a run the user did not agree to stop (it started after they looked): refused, nothing changes", async () => {
  const f = setup();
  const sprite = f.sprite({}, { running: true, stops: true });
  await assert.rejects(dropJob(f.job, { keepBranch: false, stopRun: false }, quiet, sprite), DropRefusedError);
  assert.equal(onOrigin(f.origin), true);
  assert.deepEqual(f.calls, []);
  assert.equal(await readJob(f.job.jobId), undefined);
});

test("a run that does not stop: nothing is dropped", async () => {
  const f = setup("running");
  const sprite = f.sprite({}, { running: true, stops: false });
  await assert.rejects(dropJob(f.job, { keepBranch: false, stopRun: true }, quiet, sprite), /did not stop; nothing was dropped/);
  assert.equal(onOrigin(f.origin), true);
  assert.deepEqual(f.calls, ["stop"]);
});

test("a failed download stops the drop before anything is deleted", async () => {
  const f = setup();
  const sprite = f.sprite({
    download: async () => {
      throw new Error("network down");
    },
  });
  await assert.rejects(dropJob(f.job, { keepBranch: false, stopRun: false }, quiet, sprite), /network down/);
  assert.equal(onOrigin(f.origin), true);
  assert.deepEqual(f.calls, []);
});

test("a failed Sprite cleanup: dropped anyway, retried by the poll", async () => {
  const f = setup();
  const sprite = f.sprite({
    clean: async () => {
      throw new Error("sprite asleep");
    },
  });
  const { job, lines } = await dropJob(f.job, { keepBranch: false, stopRun: false }, quiet, sprite);
  assert.equal(job.state, "dropped");
  assert.equal(job.cleanupPending, true);
  assert.match(lines.join(" "), /sprite asleep.*retried/);
});

test("no session file left on the Sprite: dropped without a conversation", async () => {
  const f = setup();
  const sprite = f.sprite({ inspect: async () => ({ running: false, session: false }) });
  const { job, lines } = await dropJob(f.job, { keepBranch: false, stopRun: false }, quiet, sprite);
  assert.equal(job.state, "dropped");
  assert.equal(job.pulledSessionFile, undefined);
  assert.match(lines.join(" "), /no longer on the Sprite/);
});

test("a branch already gone from origin counts as deleted", async () => {
  const f = setup();
  g(f.work, "push", "-q", "origin", "--delete", "feat-detach-1");
  const { job, lines } = await dropJob(f.job, { keepBranch: false, stopRun: false }, quiet, f.sprite());
  assert.ok(job.cleanedAt);
  assert.match(lines.join(" "), /already gone from origin/);
});

test("a job already off the Sprite cannot be dropped", async () => {
  for (const state of ["pulled", "dropped"] as const) {
    const f = setup(state);
    await assert.rejects(dropJob(f.job, { keepBranch: false, stopRun: true }, quiet, f.sprite()), /no longer on the Sprite/);
  }
});
