import assert from "node:assert/strict";
import { test } from "node:test";
import { expandHome, HOME, SPRITE_HOME } from "./paths.ts";
import { type RewriteContext, rewriteSettings } from "./settings.ts";

const ask = `${HOME}/.pi-sprites-detach/extensions/remote-ask.ts`;
const rules = {
  exclude: ["pi-handoff/src", "pi-reminders"],
  replace: { "npm:@juicesharp/rpiv-ask-user-question": "~/.pi-sprites-detach/extensions/remote-ask.ts", "npm:old-thing": "npm:new-thing" },
};
const context = (synced: string[], existing: string[] = synced): RewriteContext => ({
  isSynced: (path) => synced.includes(path),
  exists: (path) => existing.includes(path),
  expandHome,
});

test("a package replaced by a file moves to extensions; a source stays a package", () => {
  const { settings, changes, errors } = rewriteSettings(
    {
      packages: ["npm:pi-lens", "npm:@juicesharp/rpiv-ask-user-question", { source: "npm:old-thing", extensions: ["x"] }],
      extensions: [],
    },
    rules,
    context([ask]),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(settings.packages, ["npm:pi-lens", { source: "npm:new-thing", extensions: ["x"] }]);
  assert.deepEqual(settings.extensions, [`${SPRITE_HOME}/.pi-sprites-detach/extensions/remote-ask.ts`]);
  assert.equal(changes.length, 2);
});

test("a replacement file that is missing or not synced is an error", () => {
  const settings = { packages: ["npm:@juicesharp/rpiv-ask-user-question"] };
  assert.match(rewriteSettings(settings, rules, context([], [])).errors[0] ?? "", /does not exist/);
  assert.match(rewriteSettings(settings, rules, context([], [ask])).errors[0] ?? "", /not under sync.paths/);
});

test("a package that is an unsynced local folder is dropped, a synced one kept", () => {
  const synced = `${HOME}/.pi/agent/extensions/my-pkg`;
  const { settings, changes } = rewriteSettings(
    { packages: ["npm:pi-lens", `${HOME}/programing/perso/pi-agent/pi-handoff`, "./extensions/my-pkg"] },
    { exclude: [], replace: {} },
    context([synced]),
  );
  assert.deepEqual(settings.packages, ["npm:pi-lens", `${SPRITE_HOME}/.pi/agent/extensions/my-pkg`]);
  assert.match(changes[0] ?? "", /pi-handoff \(not under sync.paths\)/);
});

test("extensions: excluded and unsynced paths dropped, home paths mapped to the Sprite", () => {
  const synced = `${HOME}/.pi/agent/extensions/pi-usage/index.ts`;
  const { settings, changes } = rewriteSettings(
    {
      extensions: [
        synced,
        `${HOME}/programing/pi-cron-jobs/extension/index.ts`,
        `${HOME}/programing/pi-reminders/src/index.ts`,
        `${HOME}/programing/pi-handoff/src/local/index.ts`,
      ],
      theme: "dark",
      somePath: `${HOME}/.pi/agent/x`,
    },
    rules,
    context([synced]),
  );
  assert.deepEqual(settings.extensions, [`${SPRITE_HOME}/.pi/agent/extensions/pi-usage/index.ts`]);
  assert.equal(settings.somePath, `${SPRITE_HOME}/.pi/agent/x`);
  assert.equal(settings.theme, "dark");
  assert.equal(changes.length, 3);
});
