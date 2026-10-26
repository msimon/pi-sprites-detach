import assert from "node:assert/strict";
import { test } from "node:test";
import { countClients, IdleRule, START_GRACE_MS } from "./idle.ts";

const late = START_GRACE_MS + 1;

test("IdleRule: quits on the second idle check with nobody attached", () => {
  const rule = new IdleRule();
  assert.equal(rule.check({ busy: false, clients: 1, sinceStart: 1000 }), false);
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: 6000 }), false);
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: 11000 }), true);
});

test("IdleRule: a turn in progress or a reconnect resets the count", () => {
  const rule = new IdleRule();
  rule.check({ busy: false, clients: 1, sinceStart: 0 });
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: 5000 }), false);
  assert.equal(rule.check({ busy: true, clients: 0, sinceStart: 10000 }), false); // finishing a turn
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: 15000 }), false);
  assert.equal(rule.check({ busy: false, clients: 1, sinceStart: 20000 }), false); // came back
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: 25000 }), false);
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: 30000 }), true);
});

test("IdleRule: waits for the first attach, up to the grace period", () => {
  const rule = new IdleRule();
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: 5000 }), false);
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: 10000 }), false);
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: late }), false);
  assert.equal(rule.check({ busy: false, clients: 0, sinceStart: late + 5000 }), true);
});

test("IdleRule: never quits when tmux cannot be asked", () => {
  const rule = new IdleRule();
  rule.check({ busy: false, clients: 1, sinceStart: 0 });
  for (let i = 0; i < 5; i++) assert.equal(rule.check({ busy: false, clients: undefined, sinceStart: late }), false);
});

test("countClients counts non-empty lines", () => {
  assert.equal(countClients(""), 0);
  assert.equal(countClients("/dev/pts/3: detach-h9 [200x50 xterm] (utf8)\n"), 1);
  assert.equal(countClients("a\nb\n\n"), 2);
});
