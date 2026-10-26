// /handoff pull: bring a job's conversation and work back to the laptop.
//
// 1. On the Sprite, handoff-pull refuses while a run is in progress (or stops it with
//    --abort), commits what the agent left uncommitted and pushes the job branch.
// 2. The job's session file is downloaded into the original folder's session dir,
//    with the return briefing appended, so it shows in /resume there.
// 3. Git: the job branch is fetched (origin/<jobBranch>); --worktree checks it out in
//    a local worktree. Otherwise the work comes back by its way back (wayback.ts): the
//    job's pull request, or a fast-forward of the folder's branch. That happens before
//    the session is saved, so its return briefing says where the work is.
// 4. Only then is the job removed from the Sprite (handoff-clean) and marked pulled.
//
// A way back that could not happen yet (`pending`) is retried by /handoff pull <job>
// on the pulled job (retryWayBack), without the Sprite.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { run, runOk, spriteJson, spritePull } from "./exec.ts";
import { detectGit } from "./git.ts";
import { bringWorkBack, needsWayBack, type WayBack } from "./wayback.ts";
import { type LocalJob, writeJob } from "./jobs.ts";
import { RETURN_MESSAGE, type ReturnDetails } from "./outcome.ts";
import { REMOTE_HANDOFF_HOME, REMOTE_STATE, WORKTREES_DIR } from "./paths.ts";
import { cleanSprite, mergeStatus, type RemoteStatus } from "./runtime.ts";

export interface PullOptions {
  /** Stop a run in progress first instead of refusing. */
  abort: boolean;
  /** Check the job branch out in a local worktree, which becomes the session's cwd. */
  worktree: boolean;
}

export interface PullResult {
  job: LocalJob;
  sessionFile: string;
  /** Whether the agent left uncommitted work that was committed at pull. */
  snapshot: boolean;
  /** Set when the Sprite could not be cleaned up; the pull itself succeeded. */
  cleanupError?: string;
  /** Git: how the work came back. */
  wayBack?: WayBack;
}

/** A run is in progress and --abort was not given. */
export class StillRunningError extends Error {}

interface PrepareResult {
  refused?: "running";
  status?: RemoteStatus | null;
  snapshot?: string | null;
  head?: string | null;
  sessionBytes?: number;
}

const runScript = (name: string): string => `exec "${REMOTE_HANDOFF_HOME}/bin/${name}" "$@"`;

/** Stop a job's run in progress (the job browser's Abort). Returns the final status. */
export async function stopJob(job: LocalJob): Promise<RemoteStatus | undefined> {
  const result = await spriteJson<{ stopped: boolean; status?: RemoteStatus | null }>(
    job.sprite,
    runScript("handoff-stop"),
    [job.jobId],
    { timeoutMs: 90_000 },
  );
  return result.status ?? undefined;
}

export async function pullJob(job: LocalJob, options: PullOptions, progress: (text: string) => void): Promise<PullResult> {
  progress(options.abort ? "stopping the run and finishing on the Sprite…" : "finishing on the Sprite…");
  const prepared = await spriteJson<PrepareResult>(
    job.sprite,
    runScript("handoff-pull"),
    [job.jobId, ...(options.abort ? ["--abort"] : [])],
    { timeoutMs: 180_000 },
  );
  let current = (prepared.status ? mergeStatus(job, prepared.status) : undefined) ?? job;
  if (prepared.refused === "running") {
    await writeJob(current);
    throw new StillRunningError(
      current.state === "joined"
        ? `${job.jobId} is joined: pi is live on the Sprite. Quit it there (it also quits once idle with nobody attached), or stop it and bring the job back with /handoff pull ${job.jobId} --abort.`
        : `${job.jobId} is still running. Wait for it to finish, or stop it and bring it back with /handoff pull ${job.jobId} --abort.`,
    );
  }

  const tmp = await mkdtemp(join(tmpdir(), `pi-handoff-pull-${job.jobId}-`));
  try {
    progress("downloading the conversation…");
    const downloaded = join(tmp, "session.jsonl");
    await spritePull(job.sprite, `${REMOTE_STATE}/${job.jobId}/session.jsonl`, downloaded);

    let worktree: string | undefined;
    let wayBack: WayBack | undefined;
    if (job.protocol === "git" && job.jobBranch !== undefined) {
      progress(`fetching ${job.jobBranch}…`);
      worktree = await fetchJobBranch(job, job.jobBranch, options.worktree);
      if (worktree === undefined) {
        progress("bringing the work back…");
        wayBack = await safeWayBack(current);
      } else {
        wayBack = { kind: "worktree", where: worktree, text: `The work is on ${job.jobBranch}, checked out in the worktree ${worktree}.` };
      }
    }

    progress("saving the conversation…");
    const sessionFile = await importSession(
      downloaded,
      job,
      worktree ?? job.folder,
      returnBriefing(job, worktree, wayBack),
      pullDetails(job, worktree, wayBack),
    );

    progress("cleaning up the Sprite…");
    let cleanupError: string | undefined;
    try {
      await cleanSprite(job);
    } catch (error: unknown) {
      cleanupError = (error as Error).message;
    }

    current = {
      ...current,
      state: "pulled",
      updatedAt: new Date().toISOString(),
      pulledSessionFile: sessionFile,
      ...(worktree === undefined ? {} : { worktree }),
      ...wayBackFields(wayBack),
      // The status poll retries it (HandoffRuntime.poll).
      ...(cleanupError === undefined ? {} : { cleanupPending: true }),
    };
    await writeJob(current);
    return {
      job: current,
      sessionFile,
      snapshot: prepared.snapshot !== null && prepared.snapshot !== undefined,
      ...(cleanupError === undefined ? {} : { cleanupError }),
      ...(wayBack === undefined ? {} : { wayBack }),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Fetch the job branch into origin/<branch>; with a worktree, check it out there. */
async function fetchJobBranch(job: LocalJob, branch: string, withWorktree: boolean): Promise<string | undefined> {
  const git = await detectGit(job.folder);
  if (git === undefined) throw new Error(`${job.folder} is no longer a git repository; the work is on origin/${branch}.`);
  await runOk("git", ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: git.repoRoot,
    timeoutMs: 300_000,
  });
  if (!withWorktree) return undefined;

  const path = join(WORKTREES_DIR, basename(git.repoRoot), job.jobId);
  if (existsSync(path)) return path;
  await mkdir(dirname(path), { recursive: true });
  const hasLocalBranch = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: git.repoRoot })).code === 0;
  const args = hasLocalBranch
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`];
  await runOk("git", args, { cwd: git.repoRoot, timeoutMs: 300_000 });
  return path;
}

/** bringWorkBack, but never throws: an unexpected failure is a way back to retry. */
async function safeWayBack(job: LocalJob): Promise<WayBack> {
  try {
    return await bringWorkBack(job);
  } catch (error: unknown) {
    return {
      kind: "pending",
      where: `origin/${job.jobBranch}`,
      text: `Could not bring the work back into ${job.folder} (${(error as Error).message}): run /handoff pull ${job.jobId} again, or merge origin/${job.jobBranch} yourself.`,
    };
  }
}

/** What a way back records on the job. A fast-forward that deleted the branch left nothing to clean up. */
function wayBackFields(wayBack: WayBack | undefined): Partial<LocalJob> {
  if (wayBack === undefined) return {};
  const fields: Partial<LocalJob> = { wayBack: wayBack.kind, wayBackText: wayBack.text };
  if (wayBack.jobHead !== undefined) fields.jobHead = wayBack.jobHead;
  if (wayBack.kind === "fast-forwarded" && wayBack.branchDeleted === true) fields.cleanedAt = new Date().toISOString();
  return fields;
}

/**
 * Try the way back again for a pulled job whose way back is pending (the folder was
 * on another branch, edits conflicted, gh failed…). Nothing on the Sprite: its work
 * is on origin. A change is added to the job's conversation, so it is not stale there.
 */
export async function retryWayBack(job: LocalJob, progress: (text: string) => void): Promise<{ job: LocalJob; wayBack: WayBack }> {
  const branch = job.jobBranch;
  if (!needsWayBack(job) || branch === undefined) throw new Error(`${job.jobId} has no work left to bring back`);
  progress(`fetching ${branch}…`);
  await fetchJobBranch(job, branch, false);
  progress("bringing the work back…");
  const wayBack = await safeWayBack(job);
  const updated: LocalJob = { ...job, ...wayBackFields(wayBack), updatedAt: new Date().toISOString() };
  await writeJob(updated);
  if (wayBack.kind !== "pending" && job.pulledSessionFile !== undefined && existsSync(job.pulledSessionFile)) {
    const details: ReturnDetails = { jobId: job.jobId, jobBranch: branch, where: wayBack.where };
    SessionManager.open(job.pulledSessionFile).appendCustomMessageEntry(
      RETURN_MESSAGE,
      `[pi-handoff] Update on the job's work: ${workSentence(updated, undefined, wayBack)}`,
      true,
      details,
    );
  }
  return { job: updated, wayBack };
}

/**
 * Save the downloaded session in the original folder's session dir, named the way
 * pi names its own (`<header timestamp>_<id>.jsonl`), with its cwd set to `cwd` (the
 * folder or the worktree) and `briefing` appended for the model. Also used by drop.
 */
export async function importSession(
  downloaded: string,
  job: LocalJob,
  cwd: string,
  briefing: string,
  details: ReturnDetails,
): Promise<string> {
  const text = await readFile(downloaded, "utf8");
  const newline = text.indexOf("\n");
  type Header = { type?: string; id?: string; timestamp?: string; cwd?: string };
  let header: Header;
  try {
    header = JSON.parse(newline === -1 ? text : text.slice(0, newline)) as Header;
  } catch (error: unknown) {
    throw new Error(`the job's session file has an unreadable header (${job.jobId}): ${(error as Error).message}`);
  }
  if (header.type !== "session" || typeof header.id !== "string" || typeof header.timestamp !== "string") {
    throw new Error(`the job's session file has no valid header (${job.jobId})`);
  }
  header.cwd = cwd;

  const sessionDir = dirname(job.mainSessionFile);
  const target = join(sessionDir, `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`);
  await mkdir(sessionDir, { recursive: true });
  const partial = `${target}.${process.pid}.tmp`;
  await writeFile(partial, `${JSON.stringify(header)}\n${newline === -1 ? "" : text.slice(newline + 1)}`);
  await rename(partial, target);
  SessionManager.open(target).appendCustomMessageEntry(RETURN_MESSAGE, briefing, true, details);
  return target;
}

function pullDetails(job: LocalJob, worktree: string | undefined, wayBack: WayBack | undefined): ReturnDetails {
  const details: ReturnDetails = { jobId: job.jobId };
  if (job.jobBranch !== undefined) details.jobBranch = job.jobBranch;
  if (worktree !== undefined) details.worktree = worktree;
  if (wayBack !== undefined) details.where = wayBack.where;
  return details;
}

/** Appended to the job's conversation on pull: where things are now. Sent to the model. */
export function returnBriefing(job: LocalJob, worktree: string | undefined, wayBack?: WayBack): string {
  const parts = [
    `[pi-handoff] This conversation is back on the user's laptop (macOS). The turns since the handoff ran unattended on a cloud machine as handoff job ${job.jobId}; that machine's copy of the files is gone.`,
  ];
  if (job.protocol === "git" && job.jobBranch !== undefined) {
    parts.push(workSentence(job, worktree, wayBack));
  } else {
    parts.push("Files created on the cloud machine were not brought back; only this conversation was.");
  }
  parts.push("The laptop's tools, skills and credentials are available again, and the user is here to answer questions.");
  return parts.join(" ");
}

/** Where a git job's work is now, for the model. */
function workSentence(job: LocalJob, worktree: string | undefined, wayBack: WayBack | undefined): string {
  const branch = job.jobBranch;
  if (worktree !== undefined) {
    return `The job's work is on branch ${branch}, checked out in the local worktree ${worktree}, which is the working directory now. The original folder ${job.folder} is unchanged.`;
  }
  switch (wayBack?.kind) {
    case "fast-forwarded":
      return `The job's work is in the working directory ${job.folder} now: ${wayBack.text}`;
    case "pr":
      return `${wayBack.text} Until then the working directory ${job.folder} does not have the work.`;
    case "pending":
    case "manual":
      return `The job's work is on branch ${branch} on origin, fetched here as origin/${branch}; the working directory ${job.folder} does not have it. ${wayBack.text} Do not merge it yourself unless the user asks.`;
    default:
      return `The job's work is on branch ${branch} on origin, fetched here as origin/${branch}. The working directory ${job.folder} is still on ${job.baseBranch ?? "its own branch"} and does not have that work yet; before changing files, ask the user whether to continue on ${branch} or here.`;
  }
}
