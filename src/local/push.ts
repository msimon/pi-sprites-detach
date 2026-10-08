// /handoff [prompt]: split the conversation off into a job and start it on the Sprite.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RemoteJob } from "../remote/job.ts";
import { loadConfig, projectFilePatterns } from "./config.ts";
import { emitJson, run, runOk, spriteJson } from "./exec.ts";
import { missingPackageManager } from "./lockfiles.ts";
import { detectGit, ignoredProjectFiles, pushNewJobBranch, snapshotCommit } from "./git.ts";
import { type LocalJob, reserveJobId, writeJob } from "./jobs.ts";
import { REMOTE_HANDOFF_HOME, REMOTE_STATE, SPRITE_HOME } from "./paths.ts";
import { cloneForJob } from "./session.ts";
import { syncSprite } from "./sync.ts";

export const DEFAULT_PROMPT = "Continue where we left off.";

/**
 * Move the uploaded files into the job's state dir and start the run as a Sprite
 * service (handoff-start), so this exec returns at once and the run survives a
 * restart of the Sprite environment. Refuses if the job dir already exists.
 */
const START_JOB = `
set -e
up=$1 job=$2
dir=${REMOTE_STATE}/$job
if [ -e "$dir" ]; then
  rm -rf "$up"
  echo "job $job already exists on this Sprite ($dir)" >&2
  exit 1
fi
mv "$up" "$dir"
${REMOTE_HANDOFF_HOME}/bin/handoff-start "$job"
${emitJson("{started:true}")}
`;

export interface PushResult {
  job: LocalJob;
  /** What config sync updated on the way. */
  synced: string[];
}

/** What a handoff needs of pi: the command context has it all, a tool's has no waitForIdle. */
export interface PushContext {
  sessionManager: ExtensionContext["sessionManager"];
  waitForIdle?: () => Promise<void>;
}

/**
 * `fromLeafId`: fork the conversation at that entry instead of the current leaf, and do
 * not wait for the turn to end. The model's handoff tool uses it, because it runs in
 * the middle of a turn: the copy stops at the last completed assistant message.
 */
export async function pushJob(
  ctx: PushContext,
  prompt: string,
  progress: (text: string) => void,
  { fromLeafId }: { fromLeafId?: string } = {},
): Promise<PushResult> {
  if (fromLeafId === undefined && ctx.waitForIdle !== undefined) {
    progress("waiting for the current turn to end…");
    await ctx.waitForIdle();
  }
  const mainSessionFile = ctx.sessionManager.getSessionFile();
  const leafId = fromLeafId ?? ctx.sessionManager.getLeafId();
  if (mainSessionFile === undefined || leafId === null) {
    throw new Error("this session has no saved conversation to hand off");
  }

  const { config } = await loadConfig();
  const sprite = config.sprite;
  // The session's own cwd, not ctx.cwd: they can differ by a symlink (/tmp vs
  // /private/tmp), and pi refuses to resume a session whose cwd does not exist.
  const folder = ctx.sessionManager.getCwd();

  // Before anything is synced or pushed. Only git repos: a non-git folder's files do
  // not travel, so it needs no package manager on the Sprite.
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: folder });
  if (top.code === 0) {
    const missing = missingPackageManager(folder, top.stdout.trim(), config.remote.tools);
    if (missing !== undefined) {
      throw new Error(
        `this repo uses ${missing.tool} (${missing.lockfile}), but ${missing.tool} is not in remote.tools, so the Sprite may not have it. Install it on this laptop if needed, add "${missing.tool}" to remote.tools in ~/.pi-handoff/config.json, and run /handoff again.`,
      );
    }
  }

  progress("syncing the Sprite…");
  const report = await syncSprite(config, sprite, progress);

  const jobId = await reserveJobId();
  const jobRoot = `${SPRITE_HOME}/jobs/${jobId}`;
  const mainName = ctx.sessionManager.getSessionName() ?? basename(folder);
  const jobName = `${mainName} [${jobId}]`;
  const now = new Date().toISOString();
  const tmp = await mkdtemp(join(tmpdir(), `pi-handoff-${jobId}-`));
  const upload = `${REMOTE_STATE}/upload-${jobId}-${Date.now()}`;
  const files: Array<[string, string]> = [];

  try {
    const git = await detectGit(folder);
    let remote: RemoteJob;
    let gitFields: Partial<LocalJob> = {};

    if (git !== undefined) {
      progress("pushing the job branch…");
      const { sha, snapshot } = await snapshotCommit(git);
      const jobBranch = await pushNewJobBranch(git, sha);

      const patterns = await projectFilePatterns(git.repoRoot, config);
      const extra = await ignoredProjectFiles(git, patterns);
      if (extra.length > 0) {
        const list = join(tmp, "files.list");
        await writeFile(list, extra.map((f) => `${f}\0`).join(""));
        await runOk("tar", ["--no-xattrs", "-czf", join(tmp, "files.tgz"), "-C", git.repoRoot, "--null", "-T", list], {
          env: { ...process.env, COPYFILE_DISABLE: "1" },
          timeoutMs: 300_000,
        });
        files.push([join(tmp, "files.tgz"), `${upload}/files.tgz`]);
      }

      remote = {
        jobId,
        jobName,
        mainSessionId: ctx.sessionManager.getSessionId(),
        protocol: "git",
        folder,
        mountAt: git.repoRoot,
        checkout: `${jobRoot}/${basename(git.repoRoot)}`,
        cloneUrl: git.cloneUrl,
        repoKey: git.repoKey,
        jobBranch,
        ...(git.branch === undefined ? { pr: "never" as const } : { baseBranch: git.branch, pr: config.pr }),
      };
      gitFields = {
        jobBranch,
        ...(git.branch === undefined ? {} : { baseBranch: git.branch }),
        baseHead: git.head,
        snapshot,
      };
    } else {
      remote = {
        jobId,
        jobName,
        mainSessionId: ctx.sessionManager.getSessionId(),
        protocol: "none",
        folder,
        mountAt: folder,
        checkout: `${jobRoot}/work`,
      };
    }

    progress("uploading the conversation…");
    const session = cloneForJob(mainSessionFile, leafId, jobName, tmp);
    await writeFile(join(tmp, "job.json"), `${JSON.stringify(remote, null, 2)}\n`);
    await writeFile(join(tmp, "prompt.txt"), prompt);
    files.push(
      [session.file, `${upload}/session.jsonl`],
      [join(tmp, "job.json"), `${upload}/job.json`],
      [join(tmp, "prompt.txt"), `${upload}/prompt.txt`],
    );
    await spriteJson<{ started: boolean }>(sprite, START_JOB, [upload, jobId], { files, timeoutMs: 600_000 });

    const job: LocalJob = {
      jobId,
      jobName,
      sprite,
      protocol: remote.protocol,
      folder,
      mainSessionFile,
      mainSessionId: ctx.sessionManager.getSessionId(),
      forkLeafId: leafId,
      jobSessionId: session.sessionId,
      ...gitFields,
      jobRoot,
      ...(process.env.CMUX_SURFACE_ID ? { surface: process.env.CMUX_SURFACE_ID } : {}),
      ownerPid: process.pid,
      state: "starting",
      startedAt: now,
      updatedAt: now,
    };
    await writeJob(job);
    return { job, synced: report.updated };
  } catch (error: unknown) {
    // Keep the reserved id visible as a failed job rather than a blank record.
    await writeJob({
      jobId,
      jobName,
      sprite,
      protocol: "none",
      folder,
      mainSessionFile,
      mainSessionId: ctx.sessionManager.getSessionId(),
      forkLeafId: leafId,
      jobSessionId: "",
      jobRoot,
      ownerPid: process.pid,
      state: "error",
      startedAt: now,
      updatedAt: new Date().toISOString(),
      error: `handoff failed: ${(error as Error).message}`,
    });
    throw error;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
