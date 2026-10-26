// Running local commands and `sprite exec`.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME } from "./paths.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

/**
 * The folder, or its nearest ancestor that still exists: pi refuses to resume a
 * session whose cwd is gone, and the job's folder may have been deleted since.
 */
export function existingFolder(folder: string): string {
  let dir = folder;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/** A command was to run in a folder that no longer exists (deleted, or a /tmp wiped by a reboot). */
export class MissingFolderError extends Error {
  readonly folder: string;
  constructor(folder: string) {
    super(`the folder ${folder} no longer exists`);
    this.folder = folder;
  }
}

/**
 * Run a program; never rejects for a non-zero exit, only for a missing binary, a
 * missing working folder (MissingFolderError) or abort. Node reports a missing cwd as
 * "spawn <program> ENOENT", as if the program were missing: checked first instead.
 */
export function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  if (options.cwd !== undefined && !existsSync(options.cwd)) return Promise.reject(new MissingFolderError(options.cwd));
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(new Error(`${file} ${args.join(" ")}: ${error.message}`));
          return;
        }
        resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
      },
    );
  });
}

/** Run a program and return trimmed stdout; throws with stderr on a non-zero exit. */
export async function runOk(file: string, args: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    throw new Error(`${file} ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

export function spriteBin(): string {
  const local = join(HOME, ".local/bin/sprite");
  return existsSync(local) ? local : "sprite";
}

/** Marker for the one JSON line a Sprite script returns; `sprite exec` adds its own output lines. */
export const JSON_MARKER = "@@detach ";

export interface SpriteExecOptions extends RunOptions {
  /** [local path, absolute remote path] pairs uploaded before the script runs. */
  files?: Array<[string, string]>;
}

/** Run a bash script on the Sprite: `bash -c <script> detach <args...>`. */
export function spriteExec(
  sprite: string,
  script: string,
  args: string[] = [],
  options: SpriteExecOptions = {},
): Promise<RunResult> {
  const fileArgs = (options.files ?? []).flatMap(([local, remote]) => ["--file", `${local}:${remote}`]);
  return run(
    spriteBin(),
    ["exec", "-s", sprite, "--no-stdin", ...fileArgs, "--", "bash", "-c", script, "detach", ...args],
    options,
  );
}

/**
 * Run a Sprite script that prints one `@@detach <json>` line, and parse it.
 * Keep the JSON small: exec stdout is not reliable for bulk data (S5).
 */
export async function spriteJson<T>(
  sprite: string,
  script: string,
  args: string[] = [],
  options: SpriteExecOptions = {},
): Promise<T> {
  const result = await spriteExec(sprite, script, args, options);
  const line = result.stdout.split("\n").findLast((l) => l.startsWith(JSON_MARKER));
  if (result.code !== 0 || line === undefined) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-800);
    throw new Error(`sprite exec on ${sprite} failed (${result.code}): ${detail}`);
  }
  try {
    return JSON.parse(line.slice(JSON_MARKER.length)) as T;
  } catch (error: unknown) {
    throw new Error(`sprite exec on ${sprite} returned invalid JSON: ${(error as Error).message}`);
  }
}

/** Download one file from the Sprite (`sprite file pull`, byte-exact; S5). */
export async function spritePull(sprite: string, remotePath: string, localPath: string, timeoutMs = 300_000): Promise<void> {
  await runOk(spriteBin(), ["file", "pull", "-s", sprite, remotePath, localPath], { timeoutMs });
}

/** bash snippet that prints a JSON value with the marker. */
export function emitJson(jqExpression: string, jqArgs = ""): string {
  return `printf '%s%s\\n' '${JSON_MARKER}' "$(jq -nc ${jqArgs} '${jqExpression}')"`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
