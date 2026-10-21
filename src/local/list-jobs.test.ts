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

test("job ids count on in base 36 and list in order", async () => {
  const dir = join(home, ".pi-handoff", "jobs");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const record = (id: string): void => {
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify({ jobId: id, state: "done" })}\n`);
  };
  record("h8");
  assert.equal(await reserveJobId(), "h9");
  record("h9");
  assert.equal(await reserveJobId(), "ha");
  record("hz");
  assert.equal(await reserveJobId(), "h10");
  record("h10");
  record("ha");
  // Not job records: ignored by both.
  writeFileSync(join(dir, "hX.json"), "{}\n");
  writeFileSync(join(dir, "h-1.json"), "{}\n");
  assert.equal(await reserveJobId(), "h11");
  assert.deepEqual(
    (await listJobs()).map((j) => j.jobId),
    ["h8", "h9", "ha", "hz", "h10"],
  );
});
