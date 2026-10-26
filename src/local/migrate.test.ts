// The move from before the rename: the laptop's folder (migrateLegacyHome) and the
// Sprite's state (migrate_legacy_state in sprite/bin/lib.sh, run with a temp HOME).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { migrateConfigText, migrateLegacyHome } from "./migrate.ts";
import { PACKAGE_ROOT } from "./paths.ts";

const root = mkdtempSync(join(tmpdir(), "pi-detach-migrate-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
const fresh = (): string => {
  const dir = join(root, String(++count));
  mkdirSync(dir);
  return dir;
};

test("migrateConfigText: paths into the old folder and the package entry; not the Sprite's name", () => {
  const before = JSON.stringify({
    sprite: "pi-handoff",
    sync: { paths: ["~/.pi/agent/skills", "~/.pi-handoff/extensions"] },
    remote: { exclude: ["msimon/pi-handoff"], replace: { "npm:x": "~/.pi-handoff/extensions/remote-ask.ts" } },
    other: "msimon/pi-handoff-e2e",
  });
  assert.deepEqual(JSON.parse(migrateConfigText(before)), {
    sprite: "pi-handoff",
    sync: { paths: ["~/.pi/agent/skills", "~/.pi-sprites-detach/extensions"] },
    remote: { exclude: ["msimon/pi-sprites-detach"], replace: { "npm:x": "~/.pi-sprites-detach/extensions/remote-ask.ts" } },
    other: "msimon/pi-handoff-e2e",
  });
});

test("migrateLegacyHome: moves the folder with its records, rewrites the config, then does nothing", async () => {
  const home = fresh();
  const from = join(home, ".pi-handoff");
  const to = join(home, ".pi-sprites-detach");
  mkdirSync(join(from, "jobs"), { recursive: true });
  writeFileSync(join(from, "jobs", "h1.json"), '{"jobId":"h1"}\n');
  writeFileSync(join(from, "config.json"), '{"sync":{"paths":["~/.pi-handoff/extensions"]}}\n');

  assert.match((await migrateLegacyHome(from, to)) ?? "", /^Moved /);
  assert.equal(existsSync(from), false);
  assert.equal(readFileSync(join(to, "jobs", "h1.json"), "utf8"), '{"jobId":"h1"}\n');
  assert.equal(readFileSync(join(to, "config.json"), "utf8"), '{"sync":{"paths":["~/.pi-sprites-detach/extensions"]}}\n');
  assert.equal(await migrateLegacyHome(from, to), undefined);
});

test("migrateLegacyHome: both folders there, nothing is touched and the user is told", async () => {
  const home = fresh();
  const from = join(home, ".pi-handoff");
  const to = join(home, ".pi-sprites-detach");
  mkdirSync(from);
  mkdirSync(to);
  writeFileSync(join(from, "config.json"), "old\n");
  assert.match((await migrateLegacyHome(from, to)) ?? "", /still there next to/);
  assert.equal(readFileSync(join(from, "config.json"), "utf8"), "old\n");
});

/** Run migrate_legacy_state from lib.sh with HOME at `home`. */
function spriteMigrate(home: string): string {
  const lib = join(PACKAGE_ROOT, "sprite", "bin", "lib.sh");
  return execFileSync("bash", ["-c", `source "${lib}"; migrate_legacy_state`], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

test("Sprite: ~/.handoff merges into ~/.detach (new entries win), ~/.pi-handoff goes", () => {
  const home = fresh();
  const write = (path: string, text: string) => {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), text);
  };
  write(".handoff/h6/status.json", '{"state":"aborted"}');
  write(".handoff/cache/npm/x/y", "cached");
  write(".handoff/sync/applied.json", "old");
  write(".pi-handoff/sprite/bin/lib.sh", "old build");
  write(".pi-handoff/extensions/remote-ask.ts", "old copy");
  // What the laptop uploaded before the migration ran.
  write(".detach/sync/incoming/config.tgz", "new");

  assert.match(spriteMigrate(home), /moved the state from before the rename/);
  assert.equal(readFileSync(join(home, ".detach/h6/status.json"), "utf8"), '{"state":"aborted"}');
  assert.equal(readFileSync(join(home, ".detach/cache/npm/x/y"), "utf8"), "cached");
  assert.equal(readFileSync(join(home, ".detach/sync/incoming/config.tgz"), "utf8"), "new");
  assert.equal(existsSync(join(home, ".detach/sync/applied.json")), false, "sync's old state is redone, not merged");
  assert.equal(existsSync(join(home, ".handoff")), false);
  assert.equal(existsSync(join(home, ".pi-handoff")), false);
  // Nothing left to do: silent.
  assert.equal(spriteMigrate(home), "");
});
