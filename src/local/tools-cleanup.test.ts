import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { has, setupPulledJob } from "./git-fixture.ts";

// Job records live under HOME, set before the modules that read it are loaded.
const home = mkdtempSync(join(tmpdir(), "pi-detach-tool-"));
process.env.HOME = home;
const { registerHandoffTools } = await import("./tools.ts");
const { readJob, writeJob } = await import("./jobs.ts");
after(() => rmSync(home, { recursive: true, force: true }));

type Tool = { execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> };
const tools = new Map<string, Tool>();
registerHandoffTools(
  { registerTool: (t: Tool & { name: string }) => tools.set(t.name, t) } as never,
  { refreshStatusLine: async () => {}, poll: async () => {} } as never,
);

const asked: string[] = [];
let answer = true;
const ctx = (hasUI: boolean) => ({ hasUI, ui: { confirm: async (_title: string, message: string) => (asked.push(message), answer) } });
const cleanup = async (job: string, c = ctx(true)): Promise<string> => {
  try {
    return (await tools.get("handoff_cleanup")!.execute("id", { job }, undefined, undefined, c)).content[0]!.text;
  } catch (error) {
    return `THROWS: ${(error as Error).message}`;
  }
};

function fresh(name: string, merged: boolean) {
  const root = join(home, name);
  mkdirSync(root);
  return setupPulledJob(root, { merged });
}

test("handoff_cleanup is registered", () => {
  assert.ok(tools.has("handoff_cleanup"));
});

test("unmerged work: refused without asking, with the command that can force it", async () => {
  const { job, wt } = fresh("unmerged", false);
  await writeJob(job);
  asked.length = 0;
  const result = await cleanup("h1");
  assert.match(result, /Not cleaned up: .*does not have yet/);
  assert.match(result, /\/handoff cleanup h1 --discard/);
  assert.equal(asked.length, 0);
  assert.equal(existsSync(wt), true);
});

test("merged work: declined removes nothing; no UI refuses; confirmed removes and marks the job", async () => {
  const { job, wt, work } = fresh("merged", true);
  await writeJob(job);

  answer = false;
  asked.length = 0;
  assert.match(await cleanup("h1"), /The user declined/);
  assert.equal(existsSync(wt), true);
  assert.match(asked[0] ?? "", /the worktree .*h1/);
  assert.match(asked[0] ?? "", /the local branch main-detach-1/);

  assert.match(await cleanup("h1", ctx(false)), /THROWS: .*needs the user's confirmation/);
  assert.equal(existsSync(wt), true);

  answer = true;
  assert.match(await cleanup("h1"), /Cleaned up h1: removed worktree/);
  assert.equal(existsSync(wt), false);
  assert.equal(has(work, "refs/heads/main-detach-1"), false);
  assert.ok((await readJob("h1"))?.cleanedAt);

  assert.match(await cleanup("h1"), /already cleaned up/);
});

test("a job that is not pulled, or does not exist, is an error", async () => {
  const { job } = fresh("running", true);
  await writeJob({ ...job, jobId: "h2", state: "running" });
  assert.match(await cleanup("h2"), /THROWS: .*only a pulled job/);
  assert.match(await cleanup("h99"), /THROWS: no job h99/);
});
