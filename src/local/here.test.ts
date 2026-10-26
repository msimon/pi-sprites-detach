import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { jobOwnEntries } from "./here.ts";
import { RETURN_MESSAGE } from "./outcome.ts";
import { cloneForJob } from "./session.ts";

const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() }) as never;
const assistant = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  }) as never;

const texts = (entries: ReturnType<typeof jobOwnEntries>): string[] =>
  entries.map((e) => {
    if (e.type !== "message") return e.type;
    const m = e.message as { content: unknown };
    return typeof m.content === "string" ? m.content : (m.content as Array<{ text?: string }>).map((b) => b.text).join("");
  });

test("jobOwnEntries: only what the job added after the handoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-detach-here-"));
  try {
    const main = SessionManager.create(dir, dir);
    main.appendMessage(user("shared question"));
    main.appendMessage(assistant("shared answer"));
    const mainFile = main.getSessionFile()!;
    const leaf = main.getLeafId()!;

    const job = cloneForJob(mainFile, leaf, "test [h1]", dir);
    const jobManager = SessionManager.open(job.file);
    jobManager.appendMessage(user("job prompt"));
    jobManager.appendMessage(assistant("job answer"));
    jobManager.appendCustomMessageEntry(RETURN_MESSAGE, "back on the laptop", true);

    // The main conversation went on after the handoff too.
    main.appendMessage(user("main went on"));
    main.appendMessage(assistant("main answer"));

    assert.deepEqual(texts(jobOwnEntries(job.file, main.getSessionFile()!)), ["job prompt", "job answer"]);
    // From the fork point alone: the main session file may have moved or been deleted.
    assert.deepEqual(texts(jobOwnEntries(job.file, "/nonexistent/main.jsonl", leaf)), ["job prompt", "job answer"]);
    // Without it, a missing main file means everything counts (nothing to compare with).
    assert.equal(jobOwnEntries(job.file, "/nonexistent/main.jsonl").length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
