// bringWorkBack: the way back on pull, against real repos (a bare origin, the user's
// folder, and a clone standing in for the Sprite).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { g, has } from "./git-fixture.ts";
import { snapshotCommit } from "./git.ts";
import type { LocalJob } from "./jobs.ts";
import { bringWorkBack, type FindPullRequest } from "./wayback.ts";

// snapshotCommit runs plain git: give it an identity without touching any config.
for (const key of ["GIT_AUTHOR", "GIT_COMMITTER"]) {
  process.env[`${key}_NAME`] = "t";
  process.env[`${key}_EMAIL`] = "t@t";
}

const root = mkdtempSync(join(tmpdir(), "pi-detach-wayback-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let count = 0;

const write = (dir: string, file: string, text: string): void => writeFileSync(join(dir, file), text);
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
// Not g(): it trims, which eats the leading space of " M file".
const status = (dir: string): string[] =>
  execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).split("\n").filter((l) => l !== "");
const noPr: FindPullRequest = async () => undefined;

interface Fixture {
  work: string;
  origin: string;
  job: LocalJob;
  /** The job's work on the Sprite: commit `files` and push the job branch. */
  jobCommits: (files: Record<string, string>) => void;
  /** pull: fetch the job branch into origin/<jobBranch>. */
  fetch: () => void;
}

/**
 * The user's folder on feat (a.txt, b.txt, .gitignore'd *.log), `dirty` applied before
 * the handoff, then a handoff as push.ts makes it: snapshot, job branch on origin.
 */
async function handoff(dirty: (work: string) => void = () => {}, pr: "auto" | "never" = "never"): Promise<Fixture> {
  const dir = join(root, String(++count));
  mkdirSync(dir);
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  const sprite = join(dir, "sprite");
  g(dir, "init", "-q", "--bare", "-b", "main", origin);
  g(dir, "init", "-q", "-b", "feat", work);
  g(work, "remote", "add", "origin", origin);
  write(work, "a.txt", "a1\na2\na3\n");
  write(work, "b.txt", "b1\nb2\nb3\n");
  write(work, ".gitignore", "*.log\n");
  g(work, "add", ".");
  g(work, "commit", "-qm", "base");
  dirty(work);

  const head = g(work, "rev-parse", "HEAD");
  const info = { repoRoot: work, branch: "feat", head, originUrl: origin, cloneUrl: origin, repoKey: "t/work" };
  const { sha, snapshot } = await snapshotCommit(info);
  const jobBranch = "feat-detach-1";
  g(work, "push", "-q", "origin", `${sha}:refs/heads/${jobBranch}`);
  g(dir, "clone", "-q", "-b", jobBranch, origin, sprite);

  const job = {
    jobId: "h9",
    jobName: "t [h9]",
    state: "pulled",
    protocol: "git",
    folder: work,
    jobBranch,
    baseBranch: "feat",
    baseHead: info.head,
    ...(snapshot ? { snapshotSha: sha } : {}),
    pr,
  } as LocalJob;
  return {
    work,
    origin,
    job,
    jobCommits: (files) => {
      for (const [file, text] of Object.entries(files)) write(sprite, file, text);
      g(sprite, "add", ".");
      g(sprite, "commit", "-qm", "job work");
      g(sprite, "push", "-q", "origin", jobBranch);
    },
    fetch: () => g(work, "fetch", "-q", "origin", `+refs/heads/${jobBranch}:refs/remotes/origin/${jobBranch}`),
  };
}

const originHas = (f: Fixture): boolean => has(f.origin, `refs/heads/${f.job.jobBranch}`);
const tip = (f: Fixture, ref = "HEAD"): string => g(f.work, "rev-parse", ref);

test("ff clean: the branch moves to the job's work, its branch is deleted", async () => {
  const f = await handoff();
  f.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
  f.fetch();
  const jobHead = tip(f, `origin/${f.job.jobBranch}`);
  const back = await bringWorkBack(f.job, { findPr: noPr });
  assert.equal(back.kind, "fast-forwarded", back.text);
  assert.equal(back.jobHead, jobHead);
  assert.equal(tip(f), jobHead);
  assert.equal(read(f.work, "b.txt"), "b1\nB2\nb3\n");
  assert.deepEqual(status(f.work), []);
  assert.equal(originHas(f), false);
  assert.equal(has(f.work, `refs/remotes/origin/${f.job.jobBranch}`), false);
  assert.match(back.text, /feat was fast-forwarded to the job's work \(1 commit\)\. Deleted feat-detach-1 on origin\. feat is not pushed yet\./);
});

test("ff with only the snapshot's changes in the folder: they become the snapshot commit", async () => {
  const f = await handoff((work) => {
    write(work, "a.txt", "a1\nA2\na3\n");
    write(work, "new.txt", "new\n");
  });
  assert.ok(f.job.snapshotSha);
  f.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
  f.fetch();
  const back = await bringWorkBack(f.job, { findPr: noPr });
  assert.equal(back.kind, "fast-forwarded", back.text);
  assert.deepEqual(status(f.work), []);
  assert.equal(read(f.work, "a.txt"), "a1\nA2\na3\n");
  assert.equal(read(f.work, "new.txt"), "new\n");
  assert.equal(read(f.work, "b.txt"), "b1\nB2\nb3\n");
  assert.match(back.text, /2 commits.*snapshot commit/);
  assert.doesNotMatch(back.text, /still there, uncommitted/);
});

test("ff with edits since the handoff: they stay on top, uncommitted, untracked stays untracked", async () => {
  const f = await handoff((work) => write(work, "a.txt", "a1\nA2\na3\n"));
  f.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
  // After the handoff: more in a snapshot file, another tracked file, a new file.
  write(f.work, "a.txt", "a1\nA2\na3\na4\n");
  write(f.work, "b.txt", "b0\nb1\nb2\nb3\n");
  write(f.work, "later.txt", "later\n");
  write(f.work, "debug.log", "ignored\n");
  f.fetch();
  const jobHead = tip(f, `origin/${f.job.jobBranch}`);
  const back = await bringWorkBack(f.job, { findPr: noPr });
  assert.equal(back.kind, "fast-forwarded", back.text);
  assert.equal(tip(f), jobHead);
  assert.equal(g(f.work, "log", "-1", "--format=%s"), "job work");
  assert.equal(read(f.work, "a.txt"), "a1\nA2\na3\na4\n");
  assert.equal(read(f.work, "b.txt"), "b0\nb1\nB2\nb3\n");
  assert.equal(read(f.work, "later.txt"), "later\n");
  assert.equal(read(f.work, "debug.log"), "ignored\n");
  assert.deepEqual(status(f.work).sort(), [" M a.txt", " M b.txt", "?? later.txt"]);
  assert.match(back.text, /still there, uncommitted/);
});

test("no snapshot, edits since the handoff in other files: ff keeps them", async () => {
  const f = await handoff();
  assert.equal(f.job.snapshotSha, undefined);
  f.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
  write(f.work, "a.txt", "a1\na2\na3\na4\n");
  f.fetch();
  const back = await bringWorkBack(f.job, { findPr: noPr });
  assert.equal(back.kind, "fast-forwarded", back.text);
  assert.equal(read(f.work, "b.txt"), "b1\nB2\nb3\n");
  assert.deepEqual(status(f.work), [" M a.txt"]);
});

test("edits since the handoff that conflict with the job's: nothing changes", async () => {
  const f = await handoff((work) => write(work, "a.txt", "a1\nA2\na3\n"));
  f.jobCommits({ "b.txt": "b1\nJOB\nb3\n" });
  write(f.work, "b.txt", "b1\nMINE\nb3\n");
  f.fetch();
  const back = await bringWorkBack(f.job, { findPr: noPr });
  assert.equal(back.kind, "pending");
  assert.match(back.text, /conflict with the job's in b\.txt/);
  assert.equal(tip(f), f.job.baseHead);
  assert.equal(read(f.work, "b.txt"), "b1\nMINE\nb3\n");
  assert.equal(read(f.work, "a.txt"), "a1\nA2\na3\n");
  assert.equal(originHas(f), true);
});

test("an ignored file where the job adds one: refused, ref and index put back", async () => {
  const f = await handoff((work) => write(work, "a.txt", "a1\nA2\na3\n"));
  // The job force-adds a file that .gitignore ignores; the folder has its own copy.
  const sprite = join(f.work, "..", "sprite");
  write(sprite, "out.log", "from the job\n");
  g(sprite, "add", "-f", "out.log");
  g(sprite, "commit", "-qm", "log");
  g(sprite, "push", "-q", "origin", f.job.jobBranch as string);
  write(f.work, "out.log", "mine\n");
  f.fetch();
  const before = status(f.work);
  const back = await bringWorkBack(f.job, { findPr: noPr });
  assert.equal(back.kind, "pending", back.text);
  assert.match(back.text, /the job adds out\.log, which already exist there untracked/);
  assert.equal(tip(f), f.job.baseHead);
  assert.equal(read(f.work, "out.log"), "mine\n");
  assert.deepEqual(status(f.work), before);
  assert.equal(originHas(f), true);
});

test("local commits since the handoff: nothing changes, merge yourself", async () => {
  const f = await handoff();
  f.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
  write(f.work, "a.txt", "a1\na2\na3\na4\n");
  g(f.work, "commit", "-qam", "local");
  f.fetch();
  const back = await bringWorkBack(f.job, { findPr: noPr });
  assert.equal(back.kind, "manual");
  assert.match(back.text, /feat has 1 commit since the handoff\. Merge origin\/feat-detach-1 into it yourself\./);
  assert.equal(g(f.work, "log", "-1", "--format=%s"), "local");
});

test("folder on another branch: nothing changes; back on the branch, the retry works", async () => {
  const f = await handoff();
  f.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
  g(f.work, "switch", "-q", "-c", "other");
  f.fetch();
  const back = await bringWorkBack(f.job, { findPr: noPr });
  assert.equal(back.kind, "pending");
  assert.match(back.text, /it is on other, not feat\. Switch back to feat and run \/handoff pull h9 again\./);
  assert.equal(tip(f, "feat"), f.job.baseHead);
  g(f.work, "switch", "-q", "feat");
  assert.equal((await bringWorkBack(f.job, { findPr: noPr })).kind, "fast-forwarded");
});

test("pr: auto with an open or merged PR: no ff; with none, ff; gh failing: no ff", async () => {
  for (const state of ["OPEN", "MERGED"] as const) {
    const f = await handoff(undefined, "auto");
    f.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
    f.fetch();
    const back = await bringWorkBack(f.job, { findPr: async () => ({ state, number: 7, url: "https://x/pull/7" }) });
    assert.equal(back.kind, "pr");
    assert.match(back.text, state === "OPEN" ? /Merge it, then git pull on feat/ : /is merged .*git pull on feat/);
    assert.equal(tip(f), f.job.baseHead);
    assert.equal(originHas(f), true);
  }
  const none = await handoff(undefined, "auto");
  none.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
  none.fetch();
  assert.equal((await bringWorkBack(none.job, { findPr: noPr })).kind, "fast-forwarded");

  const broken = await handoff(undefined, "auto");
  broken.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
  broken.fetch();
  const back = await bringWorkBack(broken.job, {
    findPr: async () => {
      throw new Error("gh: not logged in");
    },
  });
  assert.equal(back.kind, "pending");
  assert.match(back.text, /Could not check GitHub .*gh: not logged in/);
  assert.equal(tip(broken), broken.job.baseHead);
});

test("pr: never never asks GitHub", async () => {
  const f = await handoff();
  f.jobCommits({ "b.txt": "b1\nB2\nb3\n" });
  f.fetch();
  const back = await bringWorkBack(f.job, { findPr: async () => assert.fail("must not ask gh") });
  assert.equal(back.kind, "fast-forwarded");
});
