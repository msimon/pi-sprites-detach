// /handoff drop: discard a job without bringing its work back. A run in progress is
// stopped first (abort, then drop, in one). Its conversation is still saved with the
// folder's sessions, so nothing said is lost; its job branch is deleted on origin
// (unless keepBranch), the Sprite is cleaned up, and the job becomes `dropped`: hidden
// from the job list's "all", like a pulled job. The folder and its branches are untouched.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitJson, run, spriteJson, spritePull } from "./exec.ts";
import { ACTIVE_STATES, isOffSprite, type LocalJob, writeJob } from "./jobs.ts";
import { REMOTE_DETACH_HOME, REMOTE_STATE } from "./paths.ts";
import { importSession, stopJob, syncFirst } from "./pull.ts";
import { cleanSprite } from "./runtime.ts";

/** Any job still on the Sprite can be dropped; a run in progress is stopped first. */
export const canDrop = (job: LocalJob): boolean => !isOffSprite(job);

/** Whether dropping the job stops a run, as far as the laptop knows: say so when asking. */
export const dropStopsRun = (job: LocalJob): boolean => ACTIVE_STATES.includes(job.state);

/** A run is in progress that the user did not agree to stop (it started after they looked). */
export class DropRefusedError extends Error {}

export interface DropOptions {
  /** Keep the job branch on origin instead of deleting it. */
  keepBranch: boolean;
  /** The user agreed to stop a run in progress. Without it, a live run refuses the drop. */
  stopRun: boolean;
}

export interface DropResult {
  job: LocalJob;
  /** What happened, one sentence each, for the message. */
  lines: string[];
}

/** What drop needs from the Sprite; replaced in tests. */
export interface DropSprite {
  /** Whether a run is alive, and whether the session file is there. */
  inspect: (job: LocalJob) => Promise<{ running: boolean; session: boolean }>;
  /** Stop the run (detach-stop, as abort does). */
  stop: (job: LocalJob) => Promise<void>;
  download: (job: LocalJob, to: string) => Promise<void>;
  clean: (job: LocalJob) => Promise<void>;
}

const INSPECT = `
source "${REMOTE_DETACH_HOME}/bin/lib.sh"
j=$1
running=false; runner_alive "$j" && running=true
session=false; [ -f "${REMOTE_STATE}/$j/session.jsonl" ] && session=true
${emitJson("{running:$r, session:$s}", '--argjson r "$running" --argjson s "$session"')}
`;

export const spriteOps: DropSprite = {
  inspect: async (job) => {
    await syncFirst(job.sprite);
    return spriteJson(job.sprite, INSPECT, [job.jobId], { timeoutMs: 60_000 });
  },
  stop: async (job) => {
    await stopJob(job);
  },
  download: (job, to) => spritePull(job.sprite, `${REMOTE_STATE}/${job.jobId}/session.jsonl`, to),
  clean: cleanSprite,
};

/** Appended to the dropped job's conversation: sent to the model if it is ever opened. */
export function dropBriefing(job: LocalJob, branchLine: string | undefined): string {
  return [
    `[pi-handoff] This conversation is back on the user's laptop (macOS). The turns since the handoff ran unattended on a cloud machine as handoff job ${job.jobId}; that machine's copy of the files is gone.`,
    `The user dropped this job: its work was discarded, not brought back, so none of it is in the working directory ${job.folder}.`,
    ...(branchLine === undefined ? [] : [branchLine]),
    "The laptop's tools, skills and credentials are available again, and the user is here to answer questions.",
  ].join(" ");
}

export async function dropJob(
  job: LocalJob,
  options: DropOptions,
  progress: (text: string) => void,
  sprite: DropSprite = spriteOps,
): Promise<DropResult> {
  if (!canDrop(job)) throw new Error(`${job.jobId} is ${job.state}: it is no longer on the Sprite`);
  progress("checking the Sprite…");
  let found = await sprite.inspect(job);
  if (found.running) {
    if (!options.stopRun) {
      throw new DropRefusedError(`${job.jobId} has a run in progress now. Drop it again to stop the run and drop it.`);
    }
    progress("stopping the run…");
    await sprite.stop(job);
    found = await sprite.inspect(job);
    if (found.running) throw new Error(`${job.jobId}'s run did not stop; nothing was dropped`);
  }

  const tmp = await mkdtemp(join(tmpdir(), `pi-detach-drop-${job.jobId}-`));
  try {
    // Download first: a failure there stops the drop before anything is deleted.
    const downloaded = found.session ? join(tmp, "session.jsonl") : undefined;
    if (downloaded !== undefined) {
      progress("downloading the conversation…");
      await sprite.download(job, downloaded);
    }
    return await finishDrop(job, options, progress, sprite, downloaded);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function finishDrop(
  job: LocalJob,
  options: DropOptions,
  progress: (text: string) => void,
  sprite: DropSprite,
  downloaded: string | undefined,
): Promise<DropResult> {
  const lines: string[] = [];
  const branch = job.jobBranch;
  let branchLine: string | undefined;
  let branchGone = branch === undefined;
  if (branch !== undefined) {
    if (options.keepBranch) {
      branchLine = `Its branch ${branch} was kept on origin.`;
      lines.push(`Kept ${branch} on origin.`);
    } else {
      progress(`deleting ${branch} on origin…`);
      const deleted = await deleteJobBranch(job.folder, branch);
      branchGone = deleted.ok;
      branchLine = deleted.ok ? `Its branch ${branch} was deleted on origin.` : `Its branch ${branch} is still on origin.`;
      lines.push(deleted.message);
    }
  }

  let sessionFile: string | undefined;
  if (downloaded === undefined) {
    lines.push("Its conversation was no longer on the Sprite.");
  } else {
    progress("saving the conversation…");
    sessionFile = await importSession(downloaded, job, job.folder, dropBriefing(job, branchLine), {
      jobId: job.jobId,
      ...(branch === undefined ? {} : { jobBranch: branch }),
      where: "dropped",
    });
    lines.push("Its conversation is saved with this folder's sessions (/resume, or /handoff status → dropped).");
  }

  progress("cleaning up the Sprite…");
  let cleanupPending = false;
  try {
    await sprite.clean(job);
    lines.push("Removed from the Sprite.");
  } catch (error: unknown) {
    cleanupPending = true;
    lines.push(`Could not clean up the Sprite (${(error as Error).message}); it will be retried in the background.`);
  }

  const now = new Date().toISOString();
  const dropped: LocalJob = {
    ...job,
    state: "dropped",
    updatedAt: now,
    ...(sessionFile === undefined ? {} : { pulledSessionFile: sessionFile }),
    // Nothing left on the laptop to clean up: the job branch was only ever fetched.
    ...(branchGone ? { cleanedAt: now } : {}),
    ...(cleanupPending ? { cleanupPending: true } : {}),
  };
  await writeJob(dropped);
  return { job: dropped, lines };
}

/** Delete the job branch on origin and its fetched ref here. A branch already gone counts as deleted. */
async function deleteJobBranch(folder: string, branch: string): Promise<{ ok: boolean; message: string }> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: folder });
  if (top.code !== 0) return { ok: false, message: `${folder} is no longer a git repository, so ${branch} is still on origin.` };
  const repoRoot = top.stdout.trim();
  const ref = `refs/heads/${branch}`;
  const listed = await run("git", ["ls-remote", "--heads", "origin", ref], { cwd: repoRoot, timeoutMs: 60_000 });
  if (listed.code === 0 && listed.stdout.trim() === "") {
    await run("git", ["update-ref", "-d", `refs/remotes/origin/${branch}`], { cwd: repoRoot });
    return { ok: true, message: `${branch} was already gone from origin.` };
  }
  const pushed = await run("git", ["push", "--no-verify", "origin", "--delete", branch], { cwd: repoRoot, timeoutMs: 120_000 });
  if (pushed.code !== 0) {
    return { ok: false, message: `Could not delete ${branch} on origin (${(pushed.stderr || pushed.stdout).trim()}); delete it by hand if you want it gone.` };
  }
  await run("git", ["update-ref", "-d", `refs/remotes/origin/${branch}`], { cwd: repoRoot });
  return { ok: true, message: `Deleted ${branch} on origin.` };
}
