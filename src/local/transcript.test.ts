import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTranscript, summarizeArgs, Transcript } from "./transcript.ts";

const feed = (transcript: Transcript, ...events: object[]): void => {
  for (const event of events) transcript.feed(JSON.stringify(event));
};
const update = (assistantMessageEvent: object) => ({ type: "message_update", assistantMessageEvent });
const plain = (transcript: Transcript, over: { width?: number; thinking?: boolean; expand?: boolean } = {}): string[] =>
  renderTranscript(transcript, { width: 60, thinking: false, expand: false, ...over });

const RUN = [
  { type: "session", cwd: "/work/app" },
  { type: "message_end", message: { role: "user", content: "Fix the bug" } },
  { type: "message_start", message: { role: "assistant" } },
  update({ type: "thinking_start", contentIndex: 0 }),
  update({ type: "thinking_delta", contentIndex: 0, delta: "Let me look" }),
  update({ type: "thinking_end", contentIndex: 0, content: "Let me look at the file." }),
  update({ type: "text_start", contentIndex: 1 }),
  update({ type: "text_delta", contentIndex: 1, delta: "I will " }),
  update({ type: "text_delta", contentIndex: 1, delta: "run the tests." }),
  { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test\nsecond line" } },
  { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial" }] } },
  {
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "bash",
    isError: false,
    durationMs: 1500,
    result: { content: [{ type: "text", text: "\u001b[32mok\u001b[0m 1\nok 2\nok 3\nok 4\nok 5\n" }] },
  },
];

test("a run: prompt, thinking folded, streamed text, a tool call with its output folded", () => {
  const t = new Transcript();
  feed(t, ...RUN);
  assert.deepEqual(plain(t), [
    "── run started in /work/app ──",
    "",
    "› Fix the bug",
    "",
    "✻ thinking (24 characters; t to show)",
    "",
    "I will run the tests.",
    "✓ bash  npm test  (1.5 s)",
    "    ok 1",
    "    ok 2",
    "    ok 3",
    "    … 2 more lines (e to show all)",
  ]);
});

test("thinking and tool output can be shown in full", () => {
  const t = new Transcript();
  feed(t, ...RUN);
  const lines = plain(t, { thinking: true, expand: true });
  assert.ok(lines.includes("✻ Let me look at the file."));
  assert.ok(lines.includes("    ok 5"));
  assert.ok(!lines.some((line) => line.includes("more lines")));
});

test("a tool still running, then the outcome of the run", () => {
  const t = new Transcript();
  feed(t, { type: "session", cwd: "" }, { type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "src/a.ts" } });
  assert.deepEqual(plain(t).slice(-1), ["… read  src/a.ts"]);
  feed(t, { type: "tool_execution_end", toolCallId: "t2", toolName: "read", isError: true, result: { content: [{ type: "text", text: "no such file" }] } });
  feed(t, { type: "watch_end", state: "error" });
  assert.deepEqual(plain(t).slice(-4), ["✗ read  src/a.ts", "    no such file", "", "── ended: error ──"]);
});

test("waiting for a run that has not started, a failed turn, and noise in the stream", () => {
  const t = new Transcript();
  t.feed("");
  t.feed("not json");
  t.feed("[1,2]");
  feed(t, { type: "watch_wait" });
  assert.deepEqual(plain(t), ["Waiting for the run to start…"]);
  feed(t, { type: "session", cwd: "/x" }, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" } });
  assert.ok(plain(t).includes("! rate limited"));
  assert.equal(t.phase, "live");
});

test("long lines wrap to the width, and a second run starts a new section", () => {
  const t = new Transcript();
  feed(t, { type: "session", cwd: "" }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "word ".repeat(30).trim() }] } });
  const lines = plain(t, { width: 30 });
  assert.ok(lines.every((line) => line.length <= 30), lines.join("|"));
  feed(t, { type: "session", cwd: "" });
  assert.equal(plain(t).filter((line) => line.startsWith("── run started")).length, 2);
});

test("summarizeArgs: the command, the path, or the arguments, on one line", () => {
  assert.equal(summarizeArgs("bash", { command: "ls -la\nsecond" }), "ls -la");
  assert.equal(summarizeArgs("read", { path: "a/b.ts" }), "a/b.ts");
  assert.equal(summarizeArgs("custom", { x: 1 }), '{"x":1}');
  assert.equal(summarizeArgs("bash", { command: "x".repeat(200) }).length, 120);
});
