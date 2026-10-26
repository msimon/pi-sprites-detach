import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { missingPackageManager } from "./lockfiles.ts";

test("missingPackageManager: a lockfile tool outside remote.tools is reported, npm never", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-detach-lockfiles-"));
  try {
    const sub = join(root, "app");
    mkdirSync(sub);
    assert.equal(missingPackageManager(sub, root, []), undefined);

    writeFileSync(join(root, "package-lock.json"), "{}");
    assert.equal(missingPackageManager(sub, root, []), undefined);

    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    assert.deepEqual(missingPackageManager(sub, root, []), { tool: "pnpm", lockfile: join(root, "pnpm-lock.yaml") });
    assert.equal(missingPackageManager(sub, root, ["pnpm"]), undefined);

    // The folder's own lockfile wins over the repo root's.
    writeFileSync(join(sub, "uv.lock"), "");
    assert.deepEqual(missingPackageManager(sub, root, ["pnpm"]), { tool: "uv", lockfile: "uv.lock" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
