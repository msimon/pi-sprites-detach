import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOrigin, projectPathspecs } from "./git.ts";

test("parseOrigin: GitHub SSH and HTTPS become an HTTPS clone URL", () => {
  for (const url of [
    "git@github.com:msimon/pi-handoff.git",
    "https://github.com/msimon/pi-handoff.git",
    "https://github.com/msimon/pi-handoff",
    "ssh://git@github.com/msimon/pi-handoff.git",
  ]) {
    assert.deepEqual(parseOrigin(url), {
      cloneUrl: "https://github.com/msimon/pi-handoff.git",
      repoKey: "msimon/pi-handoff",
    });
  }
});

test("parseOrigin: other hosts keep their URL", () => {
  assert.deepEqual(parseOrigin("git@gitlab.com:group/sub/repo.git"), {
    cloneUrl: "git@gitlab.com:group/sub/repo.git",
    repoKey: "sub/repo",
  });
});

test("projectPathspecs: names at any depth, folders, anchored paths", () => {
  assert.deepEqual(projectPathspecs([".env*", ".scratch/", "config/local.json", "/top.txt"]), [
    ":(glob)**/.env*",
    ":(glob)**/.scratch/**",
    ":(glob)config/local.json",
    ":(glob)top.txt",
  ]);
});
