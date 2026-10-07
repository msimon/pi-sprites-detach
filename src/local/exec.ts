// Running local commands and `sprite exec`.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

/** Run a program; never rejects for a non-zero exit, only for a missing binary or abort. */
export function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
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

function spriteBin(): string {
  const local = join(HOME, ".local/bin/sprite");
  return existsSync(local) ? local : "sprite";
}

/** Marker for the one JSON line a Sprite script returns; `sprite exec` adds its own output lines. */
export const JSON_MARKER = "@@handoff ";

export interface SpriteExecOptions extends RunOptions {
  /** [local path, absolute remote path] pairs uploaded before the script runs. */
  files?: Array<[string, string]>;
}

/** Run a bash script on the Sprite: `bash -c <script> handoff <args...>`. */
export function spriteExec(
  sprite: string,
  script: string,
  args: string[] = [],
  options: SpriteExecOptions = {},
): Promise<RunResult> {
  const fileArgs = (options.files ?? []).flatMap(([local, remote]) => ["--file", `${local}:${remote}`]);
  return run(
    spriteBin(),
    ["exec", "-s", sprite, "--no-stdin", ...fileArgs, "--", "bash", "-c", script, "handoff", ...args],
    options,
  );
}

/**
 * Run a Sprite script that prints one `@@handoff <json>` line, and parse it.
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
