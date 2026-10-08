// /handoff pull --here: bring a pulled job's context into the current conversation.
//
// The job's conversation stays its own session (pull saves it, /resume lists it).
// Here, its own part (what happened on the Sprite after the handoff) is summarized
// with pi's branch summarizer, the one /tree uses for an abandoned branch, and added
// to this conversation as a message the model reads: what the job did, learned and
// decided, its commits, and where its full conversation is. Nothing is merged: the
// job's code stays on its branch until the user asks for it here.

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { generateBranchSummary, SessionManager } from "@earendil-works/pi-coding-agent";
import { run } from "./exec.ts";
import { conversationName, type LocalJob } from "./jobs.ts";
import { CONTEXT_MESSAGE, type ContextDetails, RETURN_MESSAGE } from "./outcome.ts";

/** Lines of `git log` shown; the rest is counted. */
const MAX_COMMITS = 30;
/** Characters of the job's final message carried over as is. */
const FINAL_MAX = 3000;

/**
 * The job's own entries: its active branch without what it shares with the main
 * session (the copy keeps entry ids) and without the return briefing added at pull.
 */
export function jobOwnEntries(jobSessionFile: string, mainSessionFile: string, forkLeafId?: string): SessionEntry[] {
  const branch = SessionManager.open(jobSessionFile).getBranch();
  // The copy keeps entry ids, so what follows the entry it was forked at is the job's own.
  // That does not depend on the main session file, which may have moved since.
  const forkAt = forkLeafId === undefined ? -1 : branch.findIndex((entry) => entry.id === forkLeafId);
  let own: SessionEntry[];
  if (forkAt >= 0) {
    own = branch.slice(forkAt + 1);
  } else {
    const shared = new Set<string>();
    if (existsSync(mainSessionFile)) {
      for (const entry of SessionManager.open(mainSessionFile).getEntries()) shared.add(entry.id);
    }
    own = branch.filter((entry) => !shared.has(entry.id));
  }
  return own
    .filter((entry) => entry.type !== "session_info")
    .filter((entry) => !(entry.type === "custom_message" && entry.customType === RETURN_MESSAGE));
}

/** Summarize the entries with the session's current model, like /tree does. */
async function summarize(ctx: ExtensionContext, entries: SessionEntry[]): Promise<string> {
  const model = ctx.model;
  if (model === undefined) throw new Error("no model selected to summarize the job with");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`cannot use ${model.id} to summarize the job: ${auth.error}`);
  // Provider headers may hold null (a header to unset); the summarizer takes strings.
  const headers = Object.fromEntries(
    Object.entries(auth.headers ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
  );
  const result = await generateBranchSummary(entries, {
    model,
    ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
    headers,
    ...(auth.env === undefined ? {} : { env: auth.env }),
    signal: new AbortController().signal,
  });
  if (result.error !== undefined) throw new Error(`summarizing the job failed: ${result.error}`);
  // pi prepends a line meant for /tree ("The user explored a different conversation
  // branch…"), which is wrong here: the message around the summary says what it is.
  const summary = (result.summary ?? "").replace(/^The user explored a different conversation branch[^\n]*\nSummary of that exploration:\s*/, "").trim();
  if (summary === "") throw new Error("summarizing the job returned nothing");
  return summary;
}

/** The job's commits since the handoff and the files they change, from the fetched branch. */
async function gitContext(job: LocalJob): Promise<string | undefined> {
  if (job.protocol !== "git" || job.jobBranch === undefined || job.baseHead === undefined) return undefined;
  const range = `${job.baseHead}..origin/${job.jobBranch}`;
  const log = await run("git", ["log", "--oneline", "--no-decorate", range], { cwd: job.folder });
  const stat = await run("git", ["diff", "--stat", job.baseHead, `origin/${job.jobBranch}`], { cwd: job.folder });
  if (log.code !== 0) return `Branch ${job.jobBranch} could not be read here (${log.stderr.trim()}).`;
  const commits = log.stdout.trim().split("\n").filter((line) => line !== "");
  const shown = commits.slice(0, MAX_COMMITS);
  const more = commits.length > shown.length ? [`… and ${commits.length - shown.length} more`] : [];
  return [
    `Commits since the handoff (${commits.length}):`,
    ...shown,
    ...more,
    "",
    "Files changed:",
    stat.code === 0 ? stat.stdout.trimEnd() : "(git diff failed)",
  ].join("\n");
}

/** The message added to this conversation. */
export function contextMessage(job: LocalJob, summary: string, git: string | undefined, sessionFile: string): string {
  const where =
    job.protocol === "git" && job.jobBranch !== undefined
      ? `Its code is on branch ${job.jobBranch} on origin, fetched here as origin/${job.jobBranch}${job.worktree === undefined ? "" : ` and checked out in ${job.worktree}`}. This working directory does not have it: do not merge, cherry-pick or copy it unless the user asks; use it as context.`
      : "It ran without a git branch, so none of its files came back; only its conversation did.";
  const final = (job.lastAssistantText ?? "").trim();
  return [
    `[pi-handoff] Context from handoff job ${job.jobId} ("${conversationName(job)}"). The job split off from this conversation, ran on a cloud machine, and is now back on the laptop as its own conversation. Its work is not part of this conversation's history; this is what it did, so you can continue from it here.`,
    where,
    "",
    "## Summary of the job",
    summary,
    ...(final === "" ? [] : ["", "## The job's final message", final.length > FINAL_MAX ? `${final.slice(0, FINAL_MAX)}…` : final]),
    ...(git === undefined ? [] : ["", "## Git", git]),
    "",
    `The job's full conversation is saved at ${sessionFile} (JSONL); read it when a detail is missing here.`,
  ].join("\n");
}

/** The context message for a pulled job: summarized with the session's model. */
export async function buildJobContext(
  ctx: ExtensionContext,
  job: LocalJob,
  progress: (text: string) => void,
): Promise<{ content: string; details: ContextDetails }> {
  const sessionFile = job.pulledSessionFile;
  if (sessionFile === undefined || !existsSync(sessionFile)) {
    throw new Error(`the conversation of ${job.jobId} is no longer at ${sessionFile ?? "its saved path"}`);
  }
  const entries = jobOwnEntries(sessionFile, job.mainSessionFile, job.forkLeafId === "" ? undefined : job.forkLeafId);
  if (entries.length === 0) throw new Error(`${job.jobId} has nothing of its own to bring here`);
  progress(`summarizing ${job.jobId}…`);
  const summary = await summarize(ctx, entries);
  const git = await gitContext(job);
  return {
    content: contextMessage(job, summary, git, sessionFile),
    details: {
      jobId: job.jobId,
      ...(job.jobBranch === undefined ? {} : { jobBranch: job.jobBranch }),
      sessionFile,
    },
  };
}

/** Summarize a pulled job and add its context to the current conversation. */
export async function bringContextHere(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  job: LocalJob,
  progress: (text: string) => void,
): Promise<void> {
  const { content, details } = await buildJobContext(ctx, job, progress);
  pi.sendMessage<ContextDetails>({ customType: CONTEXT_MESSAGE, content, display: true, details }, { triggerTurn: false });
}
