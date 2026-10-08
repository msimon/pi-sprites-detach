import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The jobs folder comes from HOME when paths.ts loads, so point HOME at a temp folder
// before importing (each test file runs in its own process).
const home = mkdtempSync(join(tmpdir(), "pi-handoff-list-jobs-"));
process.env.HOME = home;
const { listJobs, reserveJobId } = await import("./jobs.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("listJobs skips a reserved id whose handoff has not written its record yet", async () => {
  const dir = join(home, ".pi-handoff", "jobs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "h1.json"), `${JSON.stringify({ jobId: "h1", state: "done" })}\n`);
  writeFileSync(join(dir, "h3.json"), "not json\n");
  assert.equal(await reserveJobId(), "h4");
  assert.deepEqual(
    (await listJobs()).map((j) => j.jobId),
    ["h1"],
  );
});
