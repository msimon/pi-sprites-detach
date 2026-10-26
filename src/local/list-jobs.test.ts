import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The jobs folder comes from HOME when paths.ts loads, so point HOME at a temp folder
// before importing (each test file runs in its own process).
const home = mkdtempSync(join(tmpdir(), "pi-detach-list-jobs-"));
process.env.HOME = home;
const { listJobs, reserveJobId } = await import("./jobs.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const record = (dir: string, id: string, startedAt: string): void => {
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify({ jobId: id, state: "done", startedAt })}\n`);
};

test("listJobs skips a reserved id whose job has not written its record yet", async () => {
  const dir = join(home, ".pi-sprites-detach", "jobs");
  mkdirSync(dir, { recursive: true });
  record(dir, "d1", "2026-10-01T00:00:00Z");
  writeFileSync(join(dir, "d3.json"), "not json\n");
  assert.equal(await reserveJobId(), "d4");
  assert.deepEqual(
    (await listJobs()).map((j) => j.jobId),
    ["d1"],
  );
});

test("new ids are d + base 36, counted apart from the h ids from before the rename", async () => {
  const dir = join(home, ".pi-sprites-detach", "jobs");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  record(dir, "hz", "2026-10-01T00:00:00Z");
  assert.equal(await reserveJobId(), "d1");
  record(dir, "d8", "2026-10-02T00:00:00Z");
  assert.equal(await reserveJobId(), "d9");
  record(dir, "d9", "2026-10-03T00:00:00Z");
  assert.equal(await reserveJobId(), "da");
  record(dir, "dz", "2026-10-05T00:00:00Z");
  assert.equal(await reserveJobId(), "d10");
  record(dir, "d10", "2026-10-06T00:00:00Z");
  record(dir, "da", "2026-10-04T00:00:00Z");
  // Not job records: ignored by both.
  writeFileSync(join(dir, "dX.json"), "{}\n");
  writeFileSync(join(dir, "d-1.json"), "{}\n");
  writeFileSync(join(dir, "x1.json"), "{}\n");
  assert.equal(await reserveJobId(), "d11");
  // In start order, old and new ids together.
  assert.deepEqual(
    (await listJobs()).map((j) => j.jobId),
    ["hz", "d8", "d9", "da", "dz", "d10"],
  );
});
