// The skill's frontmatter must stay valid YAML: pi drops a skill whose header fails to parse.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PACKAGE_ROOT } from "./paths.ts";

test("SKILL.md frontmatter: plain one-line values with no YAML-breaking ': ' or ' #'", () => {
  const text = readFileSync(join(PACKAGE_ROOT, "skills", "pi-handoff", "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "frontmatter between --- lines");
  const fields = Object.fromEntries(
    (match[1] as string).split("\n").map((line) => {
      const colon = line.indexOf(": ");
      assert.ok(colon > 0, `not a key: value line: ${line}`);
      return [line.slice(0, colon), line.slice(colon + 2)];
    }),
  );
  assert.equal(fields.name, "pi-handoff");
  for (const [key, value] of Object.entries(fields)) {
    assert.doesNotMatch(value as string, /: | #/, `${key} needs quoting to be valid YAML`);
  }
});
