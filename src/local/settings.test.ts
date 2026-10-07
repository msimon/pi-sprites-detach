import assert from "node:assert/strict";
import { test } from "node:test";
import { HOME, SPRITE_HOME } from "./paths.ts";
import { rewriteSettings } from "./settings.ts";

const rules = {
  exclude: ["pi-handoff", "pi-reminders"],
  replace: { "npm:@juicesharp/rpiv-ask-user-question": "builtin:remote-ask", "npm:old-thing": "npm:new-thing" },
};

test("packages: exclude, builtin replace, plain replace, object entries", () => {
  const { settings, changes } = rewriteSettings(
    {
      packages: [
        "npm:pi-lens",
        "npm:@juicesharp/rpiv-ask-user-question",
        { source: "npm:old-thing", extensions: ["x"] },
        "git:github.com/msimon/pi-handoff",
      ],
    },
    rules,
    () => true,
  );
  assert.deepEqual(settings.packages, ["npm:pi-lens", { source: "npm:new-thing", extensions: ["x"] }]);
  assert.equal(changes.length, 3);
});

test("extensions: unsynced paths dropped, home paths mapped to the Sprite", () => {
  const synced = `${HOME}/.pi/agent/extensions/pi-usage/index.ts`;
  const { settings } = rewriteSettings(
    {
      extensions: [synced, `${HOME}/programing/pi-cron-jobs/extension/index.ts`, `${HOME}/programing/pi-reminders/src/index.ts`],
      theme: "dark",
      somePath: `${HOME}/.pi/agent/x`,
    },
    rules,
    (path) => path === synced,
  );
  assert.deepEqual(settings.extensions, [`${SPRITE_HOME}/.pi/agent/extensions/pi-usage/index.ts`]);
  assert.equal(settings.somePath, `${SPRITE_HOME}/.pi/agent/x`);
  assert.equal(settings.theme, "dark");
});
