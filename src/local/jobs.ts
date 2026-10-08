// Local job records: ~/.pi-handoff/jobs/<jobId>.json, one per job.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JOBS_DIR } from "./paths.ts";

/** `starting` is local only (before the runner is up); the rest mirror status.json. */
export type JobState = "starting" | "preparing" | "running" | "done" | "needs_input" | "error" | "aborted" | "pulled";

export const ACTIVE_STATES: readonly JobState[] = ["starting", "preparing", "running"];

/** Job browser filters, one per state (running groups its first seconds). */
export const JOB_FILTERS = ["all", "running", "needs_input", "done", "failed", "aborted", "pulled"] as const;
export type JobFilter = (typeof JOB_FILTERS)[number];

export const FILTER_LABELS: Record<JobFilter, string> = {
  all: "all",
  running: "running",
  needs_input: "needs input",
  done: "done",
  failed: "failed",
  aborted: "aborted",
  pulled: "pulled",
};

/** What the status line counts: jobs still running or waiting to be pulled. */
export const STATUS_LINE_FILTERS: readonly JobFilter[] = ["running", "needs_input", "done", "failed"];

export function matchesFilter(job: { state: JobState }, filter: JobFilter): boolean {
  switch (filter) {
    case "all":
      return job.state !== "pulled";
    case "running":
      return ACTIVE_STATES.includes(job.state);
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
  /** Whether uncommitted work went along as a snapshot commit. */
  snapshot?: boolean;
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
    if (!/^h\d+\.json$/.test(name)) continue;
    const job = await readJob(name.slice(0, -5));
    if (job !== undefined) jobs.push(job);
  }
  return jobs.sort((a, b) => Number(a.jobId.slice(1)) - Number(b.jobId.slice(1)));
}

/** Reserve the next job id `h<n>` by creating its record exclusively. */
export async function reserveJobId(): Promise<string> {
  await mkdir(JOBS_DIR, { recursive: true });
  const taken = (await readdir(JOBS_DIR)).map((n) => /^h(\d+)\.json$/.exec(n)?.[1]).filter((n) => n !== undefined);
  let n = Math.max(0, ...taken.map(Number)) + 1;
  for (;;) {
    try {
      await writeFile(jobFile(`h${n}`), "{}\n", { flag: "wx" });
      return `h${n}`;
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
