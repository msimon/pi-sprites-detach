// Config sync: keep the Sprite's pi setup, pi-handoff's Sprite files and the extra
// tools in step with the laptop. One small read when nothing changed; otherwise an
// upload and a detached apply on the Sprite (handoff-sync-apply), polled until done.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { HandoffConfig } from "./config.ts";
import { emitJson, run, runOk, sleep, spriteJson } from "./exec.ts";
import { createMatcher } from "./glob.ts";
import { withSpriteBuild } from "./install.ts";
import { expandHome, HOME, REMOTE_HANDOFF_HOME, REMOTE_STATE } from "./paths.ts";
import { rewriteSettings } from "./settings.ts";

const SETTINGS_FILE = join(HOME, ".pi/agent/settings.json");
const POLL_MS = 3000;
const APPLY_TIMEOUT_MS = 45 * 60_000;

export interface SyncReport {
  /** What was updated, empty when the Sprite was already current. */
  updated: string[];
  /** Things Marc should know: dropped extensions, tools without a recipe or version. */
  notes: string[];
}

interface LocalSet {
  /** Synced files, relative to the home folder, sorted. */
  files: string[];
  settings: string;
  configHash: string;
  notes: string[];
}

async function collect(config: HandoffConfig): Promise<LocalSet> {
  const excluded = createMatcher(config.sync.exclude);
  const files: string[] = [];
  const notes: string[] = [];
  const roots: string[] = [];

  const visit = async (absolute: string): Promise<void> => {
    const rel = relative(HOME, absolute);
    if (excluded(rel)) return;
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      for (const name of await readdir(absolute)) await visit(join(absolute, name));
    } else if (info.isFile() || info.isSymbolicLink()) {
      files.push(rel);
    }
  };

  for (const entry of config.sync.paths) {
    const absolute = expandHome(entry);
    if (!absolute.startsWith(`${HOME}/`)) {
      notes.push(`sync.paths: ${entry} is outside the home folder, skipped`);
      continue;
    }
    try {
      await lstat(absolute);
    } catch {
      continue; // Listed but absent on this laptop: nothing to send.
    }
    roots.push(absolute);
    await visit(absolute);
  }
  files.sort();

  const fileSet = new Set(files);
  const isSynced = (path: string): boolean => {
    const rel = relative(HOME, path);
    if (fileSet.has(rel)) return true;
    return roots.some((root) => path.startsWith(`${root}/`)) && !excluded(rel) && files.some((f) => f.startsWith(`${rel}/`));
  };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
  } catch (error: unknown) {
    throw new Error(`cannot read ${SETTINGS_FILE}: ${(error as Error).message}`);
  }
  const rewritten = rewriteSettings(raw, config.remote, { isSynced, exists: existsSync, expandHome });
  if (rewritten.errors.length > 0) throw new Error(`config: ${rewritten.errors.join("; ")}`);
  notes.push(...rewritten.changes.map((c) => `settings.json: ${c}`));
  const settings = `${JSON.stringify(rewritten.settings, null, 2)}\n`;

  const hash = createHash("sha256");
  for (const rel of files) {
    const absolute = join(HOME, rel);
    const info = await lstat(absolute);
    hash.update(`${rel}\0${(info.mode & 0o777).toString(8)}\0`);
    hash.update(info.isSymbolicLink() ? `-> ${await readlink(absolute)}` : await readFile(absolute));
    hash.update("\0");
  }
  hash.update(settings);
  return { files, settings, configHash: hash.digest("hex").slice(0, 16), notes };
}

/** The laptop's version of a tool: `<tool> --version`, else Homebrew. */
async function localToolVersion(name: string): Promise<string | undefined> {
  const semver = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/;
  try {
    const out = await run(name, ["--version"], { timeoutMs: 15_000 });
    const match = semver.exec(`${out.stdout} ${out.stderr}`);
    if (out.code === 0 && match !== null) return match[0];
  } catch {
    // Not on the PATH; try Homebrew.
  }
  try {
    const out = await run("brew", ["list", "--versions", name], { timeoutMs: 30_000 });
    return semver.exec(out.stdout)?.[0];
  } catch {
    return undefined;
  }
}

interface RemoteState {
  handoffHash: string;
  applied: { configHash?: string; packagesHash?: string };
  state: { state?: string; step?: string | null; error?: string | null } | null;
  tools: Record<string, string>;
}

/** One small exec: what the Sprite has, and the installed version of each tool. */
const READ_STATE = `
S=${REMOTE_STATE}/sync
applied=$(cat "$S/applied.json" 2>/dev/null || echo '{}')
state=$(cat "$S/state.json" 2>/dev/null || echo null)
handoff=$(jq -r '.hash // ""' ${REMOTE_HANDOFF_HOME}/manifest.json 2>/dev/null)
tools='{}'
for t in "$@"; do
  r=${REMOTE_HANDOFF_HOME}/setup/tools/$t.sh
  v=""
  [ -f "$r" ] && v=$(source "$r" && tool_version 2>/dev/null)
  tools=$(jq -c --arg t "$t" --arg v "$v" '. + {($t): $v}' <<<"$tools")
done
${emitJson("{handoffHash:$h, applied:$a, state:$s, tools:$t}", `--arg h "$handoff" --argjson a "$applied" --argjson s "$state" --argjson t "$tools"`)}
`;

/**
 * Upload and start the apply. Uploads land in a fresh folder that replaces
 * `incoming/` only once complete, so a failed upload never leaves stale files.
 * pi-handoff's own files are installed right away (they are small and the apply
 * script comes from them); the rest is applied detached.
 *
 * Windows syncing at the same moment take turns (flock). One that finds an apply
 * already running drops its upload and waits for that one: the laptop's config is
 * the same in every window.
 */
const START_APPLY = `
set -e
S=${REMOTE_STATE}/sync
up=$1
mkdir -p "$S"
exec 9>"$S/start.lock"
flock 9
if [ -f "$up/handoff.tgz" ]; then
  rm -rf ${REMOTE_HANDOFF_HOME}.next && mkdir -p ${REMOTE_HANDOFF_HOME}.next
  tar -xzf "$up/handoff.tgz" -C ${REMOTE_HANDOFF_HOME}.next
  rm -rf ${REMOTE_HANDOFF_HOME} && mv ${REMOTE_HANDOFF_HOME}.next ${REMOTE_HANDOFF_HOME}
  rm "$up/handoff.tgz"
fi
started=false
if [ -z "$(ls -A "$up")" ]; then
  rm -rf "$up"
elif [ "$(jq -r '.state // empty' "$S/state.json" 2>/dev/null)" = applying ]; then
  rm -rf "$up"
  started=true
else
  rm -rf "$S/incoming" && mv "$up" "$S/incoming"
  jq -n '{state:"applying", step:"starting"}' >"$S/state.json"
  setsid nohup ${REMOTE_HANDOFF_HOME}/bin/handoff-sync-apply >/dev/null 2>&1 </dev/null 9>&- &
  started=true
fi
${emitJson("{started:$st}", `--argjson st "$started"`)}
`;

async function tar(cwd: string, out: string, entries: string[]): Promise<void> {
  const list = `${out}.list`;
  await writeFile(list, entries.map((e) => `${e}\0`).join(""));
  // COPYFILE_DISABLE and --no-xattrs keep macOS metadata out of the archive (S5).
  await runOk("tar", ["--no-xattrs", "-czf", out, "-C", cwd, "--null", "-T", list], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    timeoutMs: 300_000,
  });
}

async function waitForApply(sprite: string, onProgress: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + APPLY_TIMEOUT_MS;
  let lastStep = "";
  while (Date.now() < deadline) {
    await sleep(POLL_MS, signal);
    const remote = await spriteJson<RemoteState>(sprite, READ_STATE);
    const state = remote.state;
    if (state?.state === "done") return;
    if (state?.state === "error") throw new Error(`sync failed on ${sprite}: ${state.error ?? "unknown error"}`);
    const step = state?.step ?? "";
    if (step !== lastStep) {
      onProgress(step === "" ? "syncing…" : step.startsWith("installing") ? `${step}…` : `syncing ${step}…`);
      lastStep = step;
    }
  }
  throw new Error(`sync on ${sprite} did not finish within ${APPLY_TIMEOUT_MS / 60_000} minutes`);
}

/** Bring the Sprite in line with the laptop. Blocks until any install finishes. */
export async function syncSprite(
  config: HandoffConfig,
  sprite: string,
  onProgress: (text: string) => void,
  signal?: AbortSignal,
): Promise<SyncReport> {
  const local = await collect(config);
  const notes = [...local.notes];

  const wantedTools: Record<string, string> = {};
  for (const name of config.remote.tools) {
    const version = await localToolVersion(name);
    if (version === undefined) notes.push(`remote.tools: ${name} is not installed on the laptop, skipped`);
    else wantedTools[name] = version;
  }

  let remote = await spriteJson<RemoteState>(sprite, READ_STATE, Object.keys(wantedTools), { signal });
  if (remote.state?.state === "applying") {
    // Another window is syncing; wait for it, then compare again.
    await waitForApply(sprite, onProgress, signal);
    remote = await spriteJson<RemoteState>(sprite, READ_STATE, Object.keys(wantedTools), { signal });
  }

  const updated: string[] = [];
  const tmp = await mkdtemp(join(tmpdir(), "pi-handoff-sync-"));
  try {
    const nonce = `${Date.now()}-${process.pid}`;
    const up = `${REMOTE_STATE}/sync/upload-${nonce}`;
    const files: Array<[string, string]> = [];

    // Under the build lock: another pi window cannot swap the folder while it is packed.
    const recipes = await withSpriteBuild(async (current) => {
      if (remote.handoffHash !== current.hash) {
        await tar(current.dir, join(tmp, "handoff.tgz"), ["."]);
        files.push([join(tmp, "handoff.tgz"), `${up}/handoff.tgz`]);
        updated.push("pi-handoff");
      }
      return new Set((await readdir(join(current.dir, "setup/tools"))).map((f) => f.replace(/\.sh$/, "")));
    }, (note) => notes.push(note));

    if (remote.applied.configHash !== local.configHash) {
      await tar(HOME, join(tmp, "config.tgz"), local.files);
      await writeFile(join(tmp, "files.txt"), `${local.files.join("\n")}\n`);
      await writeFile(join(tmp, "config.hash"), local.configHash);
      await writeFile(join(tmp, "settings.json"), local.settings);
      for (const name of ["config.tgz", "files.txt", "config.hash", "settings.json"]) {
        files.push([join(tmp, name), `${up}/${name}`]);
      }
      updated.push(`pi config (${local.files.length} files)`);
    }

    const tools: Record<string, string> = {};
    for (const [name, version] of Object.entries(wantedTools)) {
      if (!recipes.has(name)) {
        notes.push(`remote.tools: no recipe for ${name} in setup/tools, skipped`);
        continue;
      }
      if (remote.tools[name] !== version) {
        tools[name] = version;
        // An empty remote version can mean the recipe was not there yet; the apply
        // checks again and only installs on a real mismatch.
        if (remote.tools[name]) updated.push(`${name} ${remote.tools[name]} → ${version}`);
      }
    }
    if (Object.keys(tools).length > 0) {
      await writeFile(join(tmp, "tools.json"), JSON.stringify(tools));
      files.push([join(tmp, "tools.json"), `${up}/tools.json`]);
    }

    if (files.length === 0) return { updated, notes };

    onProgress("uploading to the Sprite…");
    const started = await spriteJson<{ started: boolean }>(sprite, START_APPLY, [up], {
      files,
      timeoutMs: 600_000,
      signal,
    });
    if (started.started) await waitForApply(sprite, onProgress, signal);
    return { updated, notes };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
