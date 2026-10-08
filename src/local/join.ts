// /handoff join: work with a job's agent live on the Sprite, without pulling.
//
// handoff-join starts interactive pi on the job's conversation in the tmux session
// handoff-<jobId> on the Sprite (or finds it running); this window then opens a
// terminal attached to it: a cmux split, or a command printed to run in any terminal.
// The job is `joined` until that pi quits, which it does once idle with nobody
// attached; the status poll then posts the usual card.

import { loadConfig } from "./config.ts";
import { run, spriteBin, spriteJson } from "./exec.ts";
import { ACTIVE_STATES, type LocalJob, writeJob } from "./jobs.ts";
import { REMOTE_HANDOFF_HOME } from "./paths.ts";
import { mergeStatus, type RemoteStatus } from "./runtime.ts";
import { syncSprite } from "./sync.ts";

/** A job can be joined once its run has ended, or again while it is joined. */
export const canJoin = (job: LocalJob): boolean =>
  job.state !== "pulled" && (job.state === "joined" || !ACTIVE_STATES.includes(job.state));

/** A headless run is in progress: join needs --abort, which stops it first. */
export class RunInProgressError extends Error {}

interface JoinResult {
  joined?: "started" | "already";
  refused?: "running";
  missing?: boolean;
  status?: RemoteStatus | null;
}

export interface JoinOutcome {
  job: LocalJob;
  /** Whether pi was already running there (this attaches to it again). */
  already: boolean;
  /** The command that attaches a terminal to the joined pi. */
  attachCommand: string;
  synced: string[];
}

export async function joinJob(
  job: LocalJob,
  { abort }: { abort: boolean },
  progress: (text: string) => void,
): Promise<JoinOutcome> {
  if (job.state === "pulled") throw new Error(`${job.jobId} is pulled; continue in its conversation instead`);

  // Same as a reply: the joined pi should see the laptop's current pi setup.
  let synced: string[] = [];
  if (job.state !== "joined") {
    progress("syncing the Sprite…");
    const { config } = await loadConfig();
    synced = (await syncSprite(config, job.sprite, progress)).updated;
  }

  progress(abort ? "stopping the run and starting pi…" : "starting pi on the Sprite…");
  const result = await spriteJson<JoinResult>(
    job.sprite,
    `exec "${REMOTE_HANDOFF_HOME}/bin/handoff-join" "$@"`,
    [job.jobId, ...(abort ? ["--abort"] : [])],
    { timeoutMs: 120_000 },
  );
  if (result.missing) throw new Error(`${job.jobId} is no longer on ${job.sprite}`);
  const merged = result.status ? mergeStatus(job, result.status) : undefined;
  if (result.refused === "running") {
    if (merged !== undefined) await writeJob(merged);
    throw new RunInProgressError(
      `${job.jobId} is running. Stop the run and join with /handoff join ${job.jobId} --abort, or join once it finishes.`,
    );
  }

  // The window that joined is the one waiting now: notifications go there.
  const updated: LocalJob = {
    ...(merged ?? job),
    state: "joined",
    updatedAt: new Date().toISOString(),
    ownerPid: process.pid,
  };
  if (process.env.CMUX_SURFACE_ID) updated.surface = process.env.CMUX_SURFACE_ID;
  else delete updated.surface;
  await writeJob(updated);
  return { job: updated, already: result.joined === "already", attachCommand: attachCommand(job), synced };
}

/** `sprite exec --tty` running handoff-attach, quoted for a shell. */
export function attachCommand(job: Pick<LocalJob, "jobId" | "sprite">, bin = spriteBin()): string {
  return [bin, "exec", "-s", job.sprite, "--tty", "--", `${REMOTE_HANDOFF_HOME}/bin/handoff-attach`, job.jobId]
    .map(shellQuote)
    .join(" ");
}

export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Open a cmux split running the command, next to this pane. False when not inside
 * cmux or cmux refused: the caller prints the command instead.
 */
export async function openSplit(command: string): Promise<boolean> {
  if (!process.env.CMUX_SURFACE_ID) return false;
  const bin = "/Applications/cmux.app/Contents/Resources/bin/cmux";
  for (const cmux of [bin, "cmux"]) {
    try {
      const result = await run(cmux, ["new-split", "right", "--command", command], { timeoutMs: 15_000 });
      if (result.code === 0) return true;
    } catch {
      // Not there: try the next one.
    }
  }
  return false;
}
