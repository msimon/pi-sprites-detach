// Local job records: ~/.pi-sprites-detach/jobs/<jobId>.json, one per job.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JOBS_DIR } from "./paths.ts";

/**
 * `starting` is local only (before the runner is up); the rest mirror status.json.
 * `joined`: interactive pi on the Sprite (/handoff join), until it quits.
 * `pulled` and `dropped` are local only too: the job is off the Sprite, brought back
 * or discarded (/handoff drop).
 */
export type JobState =
  | "starting"
  | "preparing"
  | "running"
  | "joined"
  | "done"
  | "needs_input"
  | "error"
  | "aborted"
  | "pulled"
  | "dropped";

/** States in which a pi works on the job: polled, and reply and pull wait for them. */
export const ACTIVE_STATES: readonly JobState[] = ["starting", "preparing", "running", "joined"];

/** States of a job that is no longer on the Sprite: nothing to reply to, join or watch. */
export const OFF_SPRITE_STATES: readonly JobState[] = ["pulled", "dropped"];
export const isOffSprite = (job: { state: JobState }): boolean => OFF_SPRITE_STATES.includes(job.state);

/** The states of a headless run, before it ends: what the `running` filter shows. */
const RUNNING_STATES: readonly JobState[] = ["starting", "preparing", "running"];

/** Job browser filters, one per state (running groups its first seconds). */
export const JOB_FILTERS = ["all", "running", "joined", "needs_input", "done", "failed", "aborted", "pulled", "dropped"] as const;
export type JobFilter = (typeof JOB_FILTERS)[number];

export const FILTER_LABELS: Record<JobFilter, string> = {
  all: "all",
  running: "running",
  joined: "joined",
  needs_input: "needs input",
  done: "done",
  failed: "failed",
  aborted: "aborted",
  pulled: "pulled",
  dropped: "dropped",
};

/** What the status line counts: jobs still running or waiting to be pulled. */
export const STATUS_LINE_FILTERS: readonly JobFilter[] = ["running", "joined", "needs_input", "done", "failed"];

export function matchesFilter(job: { state: JobState }, filter: JobFilter): boolean {
  switch (filter) {
    case "all":
      return !isOffSprite(job);
    case "running":
      return RUNNING_STATES.includes(job.state);
    case "failed":
      return job.state === "error";
    default:
      return job.state === filter;
  }
}

/** Parse a typed filter (`needs-input`, `needs_input`, `error`…), undefined if unknown. */
export function parseFilter(text: string): JobFilter | undefined {
  const key = text.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "error") return "failed";
  return JOB_FILTERS.find((f) => f === key);
}

export interface Question {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
}

export interface LocalJob {
  jobId: string;
  jobName: string;
  sprite: string;
  protocol: "git" | "none";
  folder: string;
  mainSessionFile: string;
  mainSessionId: string;
  /** Entry id the job split from. */
  forkLeafId: string;
  jobSessionId: string;
  jobBranch?: string;
  baseBranch?: string;
  baseHead?: string;
  /** The snapshot commit uncommitted work went along as, when there was any. */
  snapshotSha?: string;
  /** Records from before snapshotSha: whether there was a snapshot. */
  snapshot?: boolean;
  /** The PR mode the job ran with. Records without it ran with "auto". */
  pr?: "auto" | "never";
  jobRoot: string;
  /** cmux surface of the window that started the job; notifications go there. */
  surface?: string;
  /** pid of the pi that started the job, for windows outside cmux. */
  ownerPid: number;
  state: JobState;
  startedAt: string;
  updatedAt: string;
  /** End of the last run, from status.json; identifies the run a notification is for. */
  runEndedAt?: string;
  lastAssistantText?: string;
  questions?: Question[];
  error?: string;
  /** Set by /handoff pull: the job's conversation on the laptop, and the local worktree. */
  pulledSessionFile?: string;
  worktree?: string;
  /**
   * Set by pull (git): how the work came back. `pending` can be retried with /handoff
   * pull <job>; `manual` means the user merges it. `wayBackText` says which and why.
   */
  wayBack?: "fast-forwarded" | "pr" | "worktree" | "pending" | "manual";
  wayBackText?: string;
  /** The job branch's tip at pull, so its commits stay readable once the branch is deleted. */
  jobHead?: string;
  /** The Sprite cleanup failed at pull; the status poll retries it until it succeeds. */
  cleanupPending?: boolean;
  /** Set by /handoff cleanup: the worktree and branches a pull left on the laptop are gone. */
  cleanedAt?: string;
}

/** The conversation's name without the ` [<jobId>]` suffix the job session carries. */
export function conversationName(job: Pick<LocalJob, "jobId" | "jobName">): string {
  const suffix = ` [${job.jobId}]`;
  return job.jobName.endsWith(suffix) ? job.jobName.slice(0, -suffix.length) : job.jobName;
}

const jobFile = (jobId: string): string => join(JOBS_DIR, `${jobId}.json`);

export async function readJob(jobId: string): Promise<LocalJob | undefined> {
  try {
    return JSON.parse(await readFile(jobFile(jobId), "utf8")) as LocalJob;
  } catch {
    return undefined;
  }
}

export async function writeJob(job: LocalJob): Promise<void> {
  await mkdir(JOBS_DIR, { recursive: true });
  const tmp = `${jobFile(job.jobId)}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`);
  await rename(tmp, jobFile(job.jobId));
}

export async function listJobs(): Promise<LocalJob[]> {
  let names: string[];
  try {
    names = await readdir(JOBS_DIR);
  } catch {
    return [];
  }
  const jobs: LocalJob[] = [];
  for (const name of names) {
    if (!JOB_FILE.test(name)) continue;
    const job = await readJob(name.slice(0, -5));
    // A reserved id is `{}` until its job finishes starting (reserveJobId): skip it.
    if (job !== undefined && typeof job.jobId === "string" && typeof job.state === "string") jobs.push(job);
  }
  // By start time: ids are per prefix (h before the rename, d after), so not by id.
  return jobs.sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
}

/** The prefix of new job ids. Records from before the rename keep theirs (`h`). */
export const JOB_PREFIX = "d";

/** A job record's file name: a prefix (`d`, or `h` before the rename) + a lowercase base-36 counter. */
const JOB_FILE = /^([dh])([0-9a-z]+)\.json$/;

/** Whether a word is shaped like a job id (for parsing commands). */
export const isJobIdShaped = (word: string): boolean => /^[dh][0-9a-z]+$/.test(word);

/**
 * Reserve the next job id by creating its record exclusively: `d` + a base-36 counter
 * (d1 … d9, da … dz, d10 …), so ids stay short and in order.
 */
export async function reserveJobId(): Promise<string> {
  await mkdir(JOBS_DIR, { recursive: true });
  const taken = (await readdir(JOBS_DIR)).flatMap((name) => {
    const match = JOB_FILE.exec(name);
    return match === null || match[1] !== JOB_PREFIX ? [] : [Number.parseInt(match[2] as string, 36)];
  });
  let n = Math.max(0, ...taken) + 1;
  for (;;) {
    const jobId = `${JOB_PREFIX}${n.toString(36)}`;
    try {
      await writeFile(jobFile(jobId), "{}\n", { flag: "wx" });
      return jobId;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      n++;
    }
  }
}

/**
 * Claim the notification for one run of a job. Only the first window to claim it
 * notifies, so several open pi windows never notify twice.
 */
export async function claimNotification(job: LocalJob): Promise<boolean> {
  const dir = join(JOBS_DIR, "notified");
  await mkdir(dir, { recursive: true });
  const key = `${job.jobId}-${(job.runEndedAt ?? job.updatedAt).replace(/[^\w-]/g, "")}`;
  try {
    await writeFile(join(dir, key), `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
