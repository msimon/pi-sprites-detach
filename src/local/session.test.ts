import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cloneForJob, lastCompletedLeaf } from "./session.ts";

const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() }) as never;
const assistant = (text: string, stopReason: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  }) as never;

test("lastCompletedLeaf: the last assistant message that ended its turn, not one mid-turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-detach-leaf-"));
  try {
    const main = SessionManager.create(dir, dir);
    assert.equal(lastCompletedLeaf(main.getBranch()), undefined);

    main.appendMessage(user("first question"));
    assert.equal(lastCompletedLeaf(main.getBranch()), undefined); // nothing answered yet

    main.appendMessage(assistant("first answer", "stop"));
    const finished = main.getLeafId()!;
    // A turn in progress: the trigger, then the model calling tools before its detach tool.
    main.appendMessage(user("hand this off"));
    main.appendMessage(assistant("let me look", "toolUse"));
    assert.equal(lastCompletedLeaf(main.getBranch()), finished);

    // The job's copy stops there: it has the first exchange and not the turn in progress.
    const job = cloneForJob(main.getSessionFile()!, finished, "test [h1]", dir);
    const copied = SessionManager.open(job.file)
      .getBranch()
      .filter((e) => e.type === "message")
      .map((e) => (e.type === "message" ? (e.message as { role: string }).role : ""));
    assert.deepEqual(copied, ["user", "assistant"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
