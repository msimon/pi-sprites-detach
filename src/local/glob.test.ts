import assert from "node:assert/strict";
import { test } from "node:test";
import { createMatcher } from "./glob.ts";

test("a pattern without a slash matches a name at any depth", () => {
  const m = createMatcher([".venv", "*.lock"]);
  assert.equal(m(".agents/skills/google-workspace/.venv"), true);
  assert.equal(m(".agents/skills/google-workspace/.venv/bin/python"), true);
  assert.equal(m("a/b/yarn.lock"), true);
  assert.equal(m("a/b/lock.txt"), false);
});

test("** matches any number of folders, including none", () => {
  const m = createMatcher(["**/node_modules", "**/.DS_Store"]);
  assert.equal(m("node_modules/x"), true);
  assert.equal(m(".agents/skills/notion/node_modules/.bin/katex"), true);
  assert.equal(m(".pi/agent/.DS_Store"), true);
  assert.equal(m(".pi/agent/settings.json"), false);
});

test("~/ anchors at the home folder", () => {
  const m = createMatcher(["~/.agents/skills/gmail-perso"]);
  assert.equal(m(".agents/skills/gmail-perso/SKILL.md"), true);
  assert.equal(m("x/.agents/skills/gmail-perso/SKILL.md"), false);
});

test("* stays within one segment", () => {
  const m = createMatcher(["~/.pi/*/secret.json"]);
  assert.equal(m(".pi/agent/secret.json"), true);
  assert.equal(m(".pi/agent/sub/secret.json"), false);
});
