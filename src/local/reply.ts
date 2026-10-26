// /detach reply: another run of a job whose run has ended, with the reply as the
// prompt. It answers the job's question, or asks for more work on the same branch.
// The run reuses the job's checkout and session file on the Sprite.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { spriteJson } from "./exec.ts";
import { ACTIVE_STATES, isOffSprite, type LocalJob, writeJob } from "./jobs.ts";
import { REMOTE_DETACH_HOME, REMOTE_STATE } from "./paths.ts";
import { mergeStatus, type RemoteStatus } from "./runtime.ts";
import { syncSprite } from "./sync.ts";

/** A job can take a reply once its run has ended, until it is pulled or dropped. */
export const canReply = (job: LocalJob): boolean => !isOffSprite(job) && !ACTIVE_STATES.includes(job.state);

interface ReplyResult {
  started?: boolean;
  missing?: boolean;
  refused?: "running";
  status?: RemoteStatus | null;
}

export interface ReplyOutcome {
  job: LocalJob;
  /** What config sync updated on the way. */
  synced: string[];
}

export async function replyJob(job: LocalJob, text: string, progress: (text: string) => void): Promise<ReplyOutcome> {
  if (isOffSprite(job)) throw new Error(`${job.jobId} is ${job.state}; continue in its conversation instead`);
  if (text.trim() === "") throw new Error("the reply is empty");

  // Same as a detach: the run should see the laptop's current pi setup.
  progress("syncing the Sprite…");
  const { config } = await loadConfig();
  const report = await syncSprite(config, job.sprite, progress);

  progress("starting the run…");
  const tmp = await mkdtemp(join(tmpdir(), `pi-detach-reply-${job.jobId}-`));
  try {
    const local = join(tmp, "prompt.txt");
    await writeFile(local, text);
    const remote = `${REMOTE_STATE}/incoming/reply-${job.jobId}-${Date.now()}.txt`;
    const result = await spriteJson<ReplyResult>(
      job.sprite,
      `exec "${REMOTE_DETACH_HOME}/bin/detach-reply" "$@"`,
      [job.jobId, remote],
      { files: [[local, remote]], timeoutMs: 120_000 },
    );
    if (result.missing) throw new Error(`${job.jobId} is no longer on ${job.sprite}`);
    if (result.refused === "running") {
      const merged = result.status ? mergeStatus(job, result.status) : undefined;
      if (merged !== undefined) await writeJob(merged);
      throw new Error(
        (merged ?? job).state === "joined"
          ? `${job.jobId} is joined: pi is live on the Sprite, so type there (/attach ${job.jobId} reattaches)`
          : `${job.jobId} is still running; reply once it finishes`,
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // The window that replied is the one waiting now: notifications go there.
  const updated: LocalJob = {
    ...job,
    state: "starting",
    updatedAt: new Date().toISOString(),
    ownerPid: process.pid,
  };
  if (process.env.CMUX_SURFACE_ID) updated.surface = process.env.CMUX_SURFACE_ID;
  else delete updated.surface;
  await writeJob(updated);
  return { job: updated, synced: report.updated };
}
