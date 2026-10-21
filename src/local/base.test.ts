// prepareBase: the base branch on origin before a job that opens a pull request.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { g } from "./git-fixture.ts";
import { CANCEL_TO_PULL, CONTINUE_WITHOUT_PR, HandoffCancelledError, prepareBase, type GitInfo } from "./git.ts";

const root = mkdtempSync(join(tmpdir(), "pi-handoff-base-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let count = 0;

/** origin with main, and a local clone on feat with one commit. */
function setup(): { origin: string; work: string; other: string } {
  const dir = join(root, String(++count));
  mkdirSync(dir);
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  const other = join(dir, "other");
  g(dir, "init", "-q", "--bare", "-b", "main", origin);
  g(dir, "init", "-q", "-b", "main", work);
  g(work, "remote", "add", "origin", origin);
  commit(work, "a.txt");
  g(work, "push", "-q", "origin", "main");
  g(work, "switch", "-q", "-c", "feat");
  commit(work, "b.txt");
  return { origin, work, other };
}

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file}\n`);
  g(cwd, "add", file);
  g(cwd, "commit", "-qm", file);
  return g(cwd, "rev-parse", "HEAD");
}

const info = (work: string): GitInfo => ({
  repoRoot: work,
  branch: g(work, "symbolic-ref", "--short", "HEAD"),
  head: g(work, "rev-parse", "HEAD"),
  originUrl: "",
  cloneUrl: "",
  repoKey: "t/work",
});

const originTip = (origin: string, branch: string): string => g(origin, "rev-parse", `refs/heads/${branch}`);
const quiet = () => {};
const never = async (): Promise<string | undefined> => assert.fail("must not ask");

test("base missing on origin: pushed, PR kept", async () => {
  const { origin, work } = setup();
  const decision = await prepareBase(info(work), "feat", never, quiet);
  assert.equal(decision.pr, "auto");
  assert.match(decision.note ?? "", /Pushed feat/);
  assert.equal(originTip(origin, "feat"), info(work).head);
});

test("base behind on origin: pushed, PR kept", async () => {
  const { origin, work } = setup();
  g(work, "push", "-q", "origin", "feat");
  commit(work, "c.txt");
  const decision = await prepareBase(info(work), "feat", never, quiet);
  assert.equal(decision.pr, "auto");
  assert.match(decision.note ?? "", /Updated feat/);
  assert.equal(originTip(origin, "feat"), info(work).head);
});

test("base the same on origin: nothing pushed, nothing said", async () => {
  const { work } = setup();
  g(work, "push", "-q", "origin", "feat");
  assert.deepEqual(await prepareBase(info(work), "feat", never, quiet), { pr: "auto" });
});

/** origin/feat gets a commit the local feat does not have; `diverge`: local gets one too. */
function originAhead(diverge: boolean): { origin: string; work: string } {
  const { origin, work, other } = setup();
  g(work, "push", "-q", "origin", "feat");
  g(root, "clone", "-q", "-b", "feat", origin, other);
  commit(other, "d.txt");
  g(other, "push", "-q", "origin", "feat");
  if (diverge) commit(work, "c.txt");
  return { origin, work };
}

for (const diverge of [false, true]) {
  const name = diverge ? "diverged" : "ahead";

  test(`base ${name} on origin: Continue goes without a PR, origin untouched`, async () => {
    const { origin, work } = originAhead(diverge);
    const before = originTip(origin, "feat");
    let asked: string[] = [];
    const decision = await prepareBase(info(work), "feat", async (_title, options) => {
      asked = options;
      return CONTINUE_WITHOUT_PR;
    }, quiet);
    assert.deepEqual(asked, [CONTINUE_WITHOUT_PR, CANCEL_TO_PULL]);
    assert.equal(decision.pr, "never");
    assert.match(decision.note ?? "", /origin\/feat has commits your local feat does not/);
    assert.equal(originTip(origin, "feat"), before);
  });

  test(`base ${name} on origin: Cancel (or Esc) stops the handoff`, async () => {
    const { work } = originAhead(diverge);
    for (const answer of [CANCEL_TO_PULL, undefined]) {
      await assert.rejects(prepareBase(info(work), "feat", async () => answer, quiet), HandoffCancelledError);
    }
  });
}

test("base ahead on origin with no UI: goes without a PR", async () => {
  const { work } = originAhead(false);
  const decision = await prepareBase(info(work), "feat", undefined, quiet);
  assert.equal(decision.pr, "never");
  assert.match(decision.note ?? "", /comes back with \/handoff pull/);
});

test("a pre-push hook that rejects the push fails the handoff", async () => {
  const { origin, work } = setup();
  const hook = join(work, ".git", "hooks", "pre-push");
  writeFileSync(hook, "#!/bin/sh\necho 'secret found' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  await assert.rejects(prepareBase(info(work), "feat", never, quiet), /pushing it failed: .*secret found/s);
  assert.throws(() => originTip(origin, "feat"));
});
