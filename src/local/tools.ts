// Tools for the model: the same actions as /handoff, so it can hand work off, check on
// jobs, answer them and bring their context back. They call the same functions as the
// commands. What costs money, cleans the Sprite or stops a run asks the user first.
//
// Registered only on the laptop: the extension does not load on the Sprite, so jobs
// never see these tools.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { plainList } from "./browser.ts";
import { buildJobContext } from "./here.ts";
import { ACTIVE_STATES, conversationName, type LocalJob, listJobs, parseFilter, readJob, writeJob } from "./jobs.ts";
import { canJoin, joinJob, openSplit, RunInProgressError } from "./join.ts";
import { outcomeLabel } from "./outcome.ts";
import { pullJob, StillRunningError, stopJob } from "./pull.ts";
import { pushJob } from "./push.ts";
import { canReply, replyJob } from "./reply.ts";
import type { HandoffRuntime } from "./runtime.ts";
import { lastCompletedLeaf } from "./session.ts";
import { blockers, canCleanup, cleanupJob, describePlan, planCleanup } from "./cleanup.ts";

type Update = ((partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
const progressTo = (onUpdate: Update) => (value: string) => onUpdate?.(text(value));

/** Ask the user; a tool with no UI to ask on refuses instead of acting unconfirmed. */
async function confirmed(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
  if (!ctx.hasUI) throw new Error(`${title}: this needs the user's confirmation, and there is no UI to ask on`);
  return ctx.ui.confirm(title, message);
}

const DECLINED = "The user declined. Do not try again unless they ask for it.";

async function jobOrThrow(id: string): Promise<LocalJob> {
  const job = await readJob(id.trim());
  if (job === undefined) throw new Error(`no job ${id}; handoff_status lists them`);
  return job;
}

/** One job in full, for deciding what to do with it. */
function describeJob(job: LocalJob): string {
  const lines = [
    `${job.jobId} ${outcomeLabel(job.state)}: ${conversationName(job)}`,
    ...(job.jobBranch === undefined ? [] : [`Branch: ${job.jobBranch} on origin`]),
  ];
  if (job.state === "needs_input" && job.questions !== undefined) {
    for (const [i, q] of job.questions.entries()) {
      lines.push(`Question ${i + 1}: ${q.question}`);
      for (const option of q.options ?? []) lines.push(`  - ${option.label}${option.description ? `: ${option.description}` : ""}`);
    }
  }
  if (job.error !== undefined) lines.push(`Error: ${job.error}`);
  if (job.lastAssistantText !== undefined) lines.push("", "The job's last message:", job.lastAssistantText);
  return lines.join("\n");
}

export function registerHandoffTools(pi: ExtensionAPI, runtime: HandoffRuntime): void {
  pi.registerTool({
    name: "handoff_status",
    label: "Handoff status",
    description:
      "List the user's handoff jobs (conversations handed off to a cloud machine), or show one in full: its state, branch, question and last message. Use it before replying to, pulling or aborting a job.",
    promptSnippet: "handoff_status: list handoff jobs or show one in full",
    parameters: Type.Object({
      job: Type.Optional(Type.String({ description: "A job id such as h3 or h1k, to show in full" })),
      filter: Type.Optional(
        Type.String({ description: "all (default; leaves out pulled jobs), running, joined, needs-input, done, failed, aborted or pulled; ignored with job" }),
      ),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      await runtime.poll({ all: true }).catch(() => undefined);
      if (params.job !== undefined) return text(describeJob(await jobOrThrow(params.job)));
      const filter = params.filter === undefined ? "all" : parseFilter(params.filter);
      if (filter === undefined) throw new Error(`unknown filter "${params.filter}"`);
      const jobs = await listJobs();
      const list = plainList(jobs, filter, Date.now());
      // "all" leaves out pulled jobs; say so, or a model asked for every job reports none.
      const pulled = filter === "all" ? jobs.filter((j) => j.state === "pulled") : [];
      return text(
        pulled.length === 0
          ? list
          : `${list}\nAlso pulled (brought back, no longer on the cloud machine): ${pulled.map((j) => `${j.jobId} ${conversationName(j)}`).join("; ")}. Use filter "pulled" for details.`,
      );
    },
  });

  pi.registerTool({
    name: "handoff_reply",
    label: "Handoff reply",
    description:
      "Start another run of a finished job (done, needs input, failed or aborted) with a message: answer its question, or ask for more work. It runs on the cloud machine; the user gets a card when it ends. Not for a running or pulled job.",
    promptSnippet: "handoff_reply: answer a finished handoff job or ask it for more work",
    parameters: Type.Object({
      job: Type.String({ description: "The job id, such as h3 or h1k" }),
      text: Type.String({ description: "The message for the job: the answer, or the next task" }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, onUpdate) {
      const job = await jobOrThrow(params.job);
      if (!canReply(job)) throw new Error(`${job.jobId} is ${outcomeLabel(job.state)}: it cannot take a reply now`);
      await replyJob(job, params.text, progressTo(onUpdate));
      await runtime.refreshStatusLine();
      return text(`Replied to ${job.jobId}. It is running again on the cloud machine; the user gets a card when it finishes or needs input.`);
    },
  });

  pi.registerTool({
    name: "handoff_pull",
    label: "Handoff pull",
    description:
      "Bring a finished job back: its branch is fetched, its conversation is saved on the laptop, the cloud machine is cleaned up, and you get a summary of what it did, its commits and its final message to continue from. The code stays on the job's branch: do not merge or copy it unless the user asks. On a job already pulled it returns the summary again. The user is asked to confirm.",
    promptSnippet: "handoff_pull: bring a finished job back and read what it did",
    parameters: Type.Object({
      job: Type.String({ description: "The job id, such as h3 or h1k" }),
      abort: Type.Optional(Type.Boolean({ description: "Stop a run in progress first (only if the user wants the job stopped)" })),
      worktree: Type.Optional(Type.Boolean({ description: "Also check the job branch out in a local worktree" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, onUpdate, ctx) {
      const progress = progressTo(onUpdate);
      let job = await jobOrThrow(params.job);
      if (job.state !== "pulled") {
        const ok = await confirmed(
          ctx,
          `Pull ${job.jobId}?`,
          `Bring "${conversationName(job)}" back and read what it did.${params.abort ? " Its run in progress is stopped first." : ""} It is removed from the Sprite; its branch is fetched.`,
        );
        if (!ok) return text(DECLINED);
        try {
          job = (await pullJob(job, { abort: params.abort === true, worktree: params.worktree === true }, progress)).job;
        } catch (error: unknown) {
          if (error instanceof StillRunningError) return text(error.message);
          throw error;
        }
        await runtime.refreshStatusLine();
      }
      try {
        const { content } = await buildJobContext(ctx, job, progress);
        return text(content);
      } catch (error: unknown) {
        return text(`${job.jobId} is pulled, but its summary failed: ${(error as Error).message}. Call handoff_pull again to retry.`);
      }
    },
  });

  pi.registerTool({
    name: "handoff_join",
    label: "Handoff join",
    description:
      "Open a terminal for the user on a finished job, with interactive pi on its conversation on the cloud machine (a split next to this window). The user types there; you do not. Not for a running job unless abort is set, which stops its run (the user is asked).",
    promptSnippet: "handoff_join: open the user a live session on a finished job",
    parameters: Type.Object({
      job: Type.String({ description: "The job id, such as h3 or h1k" }),
      abort: Type.Optional(Type.Boolean({ description: "Stop the job's run in progress first" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, onUpdate, ctx) {
      const job = await jobOrThrow(params.job);
      if (!canJoin(job) && !(params.abort && ACTIVE_STATES.includes(job.state))) {
        throw new Error(`${job.jobId} is ${outcomeLabel(job.state)}: it cannot be joined now`);
      }
      if (params.abort) {
        const ok = await confirmed(ctx, `Stop ${job.jobId} and join it?`, `Stop the run of "${conversationName(job)}" now; the work so far stays.`);
        if (!ok) return text(DECLINED);
      }
      try {
        const outcome = await joinJob(job, { abort: params.abort === true }, progressTo(onUpdate));
        const split = await openSplit(outcome.attachCommand);
        await runtime.refreshStatusLine();
        return text(
          split
            ? `Opened a split for the user, attached to pi on ${job.jobId}. They work there; a card appears here when it ends.`
            : `pi is running on ${job.jobId}. The user can attach with: ${outcome.attachCommand}`,
        );
      } catch (error: unknown) {
        if (error instanceof RunInProgressError) return text(error.message);
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "handoff_abort",
    label: "Handoff abort",
    description:
      "Stop a job's run in progress (or a joined session). The work so far stays on the cloud machine and on its branch; the job can be replied to or pulled later. The user is asked to confirm.",
    promptSnippet: "handoff_abort: stop a running handoff job",
    parameters: Type.Object({ job: Type.String({ description: "The job id, such as h3 or h1k" }) }),
    executionMode: "sequential",
    async execute(_id, params, _signal, onUpdate, ctx) {
      const job = await jobOrThrow(params.job);
      if (!ACTIVE_STATES.includes(job.state) && job.state !== "joined") {
        throw new Error(`${job.jobId} is ${outcomeLabel(job.state)}: there is no run to stop`);
      }
      const ok = await confirmed(ctx, `Abort ${job.jobId}?`, `Stop "${conversationName(job)}" now. Its work so far stays; pull it or reply later.`);
      if (!ok) return text(DECLINED);
      progressTo(onUpdate)("stopping the run…");
      const status = await stopJob(job);
      if (status !== undefined) await runtime.apply(job, status);
      await runtime.refreshStatusLine();
      return text(`${job.jobId} is stopped. Its work so far is kept; it can be replied to or pulled.`);
    },
  });

  pi.registerTool({
    name: "handoff_cleanup",
    label: "Handoff cleanup",
    description:
      "Remove what pulling a job left on the laptop: its worktree, its local branch and the fetched origin branch. Only for a pulled job whose work is merged into its base branch and whose worktree has no uncommitted changes; otherwise it refuses and says why. It never deletes anything on origin and cannot discard unmerged work: only the user can, with the /handoff cleanup command and its options. The user is asked to confirm.",
    promptSnippet: "handoff_cleanup: remove a pulled, merged job's worktree and branch",
    parameters: Type.Object({ job: Type.String({ description: "The job id, such as h3 or h1k" }) }),
    executionMode: "sequential",
    async execute(_id, params, _signal, onUpdate, ctx) {
      const job = await jobOrThrow(params.job);
      if (job.cleanedAt !== undefined) return text(`${job.jobId} is already cleaned up.`);
      if (!canCleanup(job)) throw new Error(`${job.jobId} is ${outcomeLabel(job.state)}: only a pulled job with a git branch can be cleaned up`);
      const options = { discard: false, remote: false };
      const progress = progressTo(onUpdate);
      progress("looking at what is there…");
      const plan = await planCleanup(job, options);
      const reasons = blockers(plan, options);
      if (reasons.length > 0) {
        return text(
          `Not cleaned up: ${reasons.join("; and ")}. Tell the user; they can run /handoff cleanup ${job.jobId} --discard to remove it anyway.`,
        );
      }
      const items = describePlan(plan, options);
      if (items.length > 0) {
        const ok = await confirmed(ctx, `Clean up ${job.jobId}?`, `Remove:\n- ${items.join("\n- ")}`);
        if (!ok) return text(DECLINED);
      }
      const { job: cleaned, removed } = await cleanupJob(job, options, progress, plan);
      await writeJob(cleaned);
      await runtime.refreshStatusLine();
      return text(
        removed.length === 0
          ? `${job.jobId} had nothing left to remove.`
          : `Cleaned up ${job.jobId}: removed ${removed.join(", ")}. Its conversation is kept.`,
      );
    },
  });

  pi.registerTool({
    name: "handoff_start",
    label: "Handoff start",
    description:
      "Hand this work off to run unattended on a cloud machine, so the user can leave. The job continues this conversation up to your last finished message, with the working tree as it is now (uncommitted changes included, pushed to a new branch on origin). It does NOT see the current turn: your prompt must say what the user asked for and what you already did and found in this turn. Afterwards tell the user it is handed off and stop: do not continue the work yourself. The user is asked to confirm.",
    promptSnippet: "handoff_start: hand the work off to a cloud machine to run unattended",
    parameters: Type.Object({
      prompt: Type.String({
        description: "What the job should do, self-contained: the task, what is already done in this turn, and anything it must know",
      }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, onUpdate, ctx) {
      const leaf = lastCompletedLeaf(ctx.sessionManager.getBranch());
      if (leaf === undefined) {
        throw new Error("nothing to fork from yet: the conversation has no finished assistant message. Answer first, then hand off.");
      }
      const preview = params.prompt.length > 400 ? `${params.prompt.slice(0, 400)}…` : params.prompt;
      const ok = await confirmed(
        ctx,
        "Hand this off to the Sprite?",
        `The agent wants to run this on a cloud machine while you are away. Your uncommitted changes go to a new branch on origin.\n\nIts prompt:\n${preview}`,
      );
      if (!ok) return text(DECLINED);
      const { job } = await pushJob(ctx, params.prompt, progressTo(onUpdate), { fromLeafId: leaf });
      await runtime.refreshStatusLine();
      return text(
        `Handed off as job ${job.jobId}${job.jobBranch === undefined ? "" : ` on branch ${job.jobBranch}`}. It runs on the cloud machine now; the user gets a card in this window when it finishes or needs input. Tell the user, and stop: do not continue this work here.`,
      );
    },
  });
}
