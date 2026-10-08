// pi-handoff local extension, loaded on the laptop.
//
//   /handoff [prompt]          hand the conversation off to the Sprite as a new job
//   /handoff sync              bring the Sprite's pi setup in line with the laptop
//   /handoff status [filter]   browse jobs (all, running, needs-input, done, failed, aborted, pulled)
//   /handoff pull [job] [--abort] [--switch] [--worktree]
//                              bring a job's conversation and work back
//
// Does nothing when loaded inside a handoff run on the Sprite.

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  ACTION_LABELS,
  type BrowserResult,
  type BrowserState,
  JobBrowser,
  jobActions,
  plainList,
} from "./browser.ts";
import { loadConfig } from "./config.ts";
import { ensureSpriteBuild } from "./install.ts";
import {
  ACTIVE_STATES,
  conversationName,
  JOB_FILTERS,
  type LocalJob,
  listJobs,
  matchesFilter,
  parseFilter,
  readJob,
} from "./jobs.ts";
import { buildOutcomeCard, OUTCOME_ENTRY, outcomeLabel, registerOutcomeRenderer } from "./outcome.ts";
import { CONFIG_FILE } from "./paths.ts";
import { type PullOptions, pullJob, StillRunningError, stopJob } from "./pull.ts";
import { DEFAULT_PROMPT, pushJob } from "./push.ts";
import { HandoffRuntime } from "./runtime.ts";
import { syncSprite } from "./sync.ts";

const PROGRESS_KEY = "handoff-progress";
/** Subcommands as the completion menu shows them: usage as the label, what it does beside it. */
const SUBCOMMANDS = [
  { name: "sync", usage: "sync", description: "bring the Sprite's pi setup in line with the laptop" },
  { name: "status", usage: "status [filter]", description: "browse jobs by state, pull or abort them" },
  {
    name: "pull",
    usage: "pull [job] [--abort] [--switch] [--worktree]",
    description: "bring a job's conversation and work back",
  },
] as const;
const PULL_FLAGS = {
  "--abort": "stop a run in progress first",
  "--switch": "open its conversation after pulling",
  "--worktree": "check the job branch out in a local worktree",
} as const;
/** Filters as typed after `status` (dashes instead of underscores). */
const TYPED_FILTERS = JOB_FILTERS.map((f) => f.replace("_", "-"));

/** Jobs /handoff pull can take without --abort: their run has ended. */
const isPullable = (job: LocalJob): boolean => job.state !== "pulled" && !ACTIVE_STATES.includes(job.state);

export default function handoffLocal(pi: ExtensionAPI): void {
  if (process.env.HANDOFF_JOB_ID !== undefined) return;

  const runtime = new HandoffRuntime(pi);
  registerOutcomeRenderer(pi);

  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureSpriteBuild();
      await runtime.start(ctx);
    } catch (error: unknown) {
      ctx.ui.notify(`[pi-handoff] ${(error as Error).message}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    runtime.stop();
  });

  pi.registerCommand("handoff", {
    description: "Hand this conversation off to a Sprite (/handoff [prompt] | sync | status | pull)",
    getArgumentCompletions: async (prefix) => {
      const text = prefix.trimStart();
      if (text.startsWith("status ")) {
        const typed = text.slice("status ".length).trim();
        const jobs = await listJobs();
        return TYPED_FILTERS.filter((f) => f.startsWith(typed)).map((f) => {
          const count = jobs.filter((job) => matchesFilter(job, parseFilter(f) ?? "all")).length;
          return { value: `status ${f}`, label: f, description: `${count} job${count === 1 ? "" : "s"}` };
        });
      }
      if (text.startsWith("pull ")) {
        const words = text.slice("pull ".length).split(/\s+/);
        const typed = words.pop() ?? "";
        const head = ["pull", ...words].join(" ");
        const jobs = (await listJobs())
          .filter((j) => j.state !== "pulled")
          .map((j) => ({ word: j.jobId, description: `${outcomeLabel(j.state)} · ${conversationName(j)}` }));
        const flags = Object.entries(PULL_FLAGS).map(([word, description]) => ({ word, description }));
        return [...jobs, ...flags]
          .filter(({ word }) => word.startsWith(typed) && !words.includes(word))
          .map(({ word, description }) => ({ value: `${head} ${word}`, label: word, description }));
      }
      return SUBCOMMANDS.filter((s) => s.name.startsWith(text.trim())).map((s) => ({
        // A trailing space opens the argument suggestions right away.
        value: s.name === "sync" ? s.name : `${s.name} `,
        label: s.usage,
        description: s.description,
      }));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = "", ...rest] = trimmed.split(/\s+/);
      try {
        if (trimmed === "sync") await syncCommand(ctx);
        else if (subcommand === "status") await statusCommand(pi, ctx, runtime, rest.join(" "));
        else if (subcommand === "pull") await pullCommand(ctx, runtime, rest);
        else await pushCommand(ctx, runtime, trimmed === "" ? DEFAULT_PROMPT : trimmed);
      } catch (error: unknown) {
        const message = (error as Error).message;
        notifySafely(ctx, error instanceof StillRunningError ? `☁ ${message}` : `[pi-handoff] ${message}`, "error");
      } finally {
        clearProgress(ctx);
      }
    },
  });
}

/** After a session switch the old context is gone; ignore it then. */
function clearProgress(ctx: ExtensionCommandContext): void {
  try {
    ctx.ui.setWidget(PROGRESS_KEY, undefined);
  } catch {
    // The session was replaced (pull --switch): its widgets went with it.
  }
}

function notifySafely(ctx: ExtensionCommandContext, text: string, type: "info" | "error"): void {
  try {
    ctx.ui.notify(text, type);
  } catch {
    // Old context after a session switch.
  }
}

/** The current step, on a line above the input while a command runs (not saved). */
const progressTo =
  (ctx: ExtensionCommandContext, title: string) =>
  (text: string): void => {
    const theme = ctx.ui.theme;
    ctx.ui.setWidget(PROGRESS_KEY, [`${theme.fg("accent", `☁ ${title}:`)} ${theme.fg("muted", text)}`]);
  };

async function pushCommand(ctx: ExtensionCommandContext, runtime: HandoffRuntime, prompt: string): Promise<void> {
  const { job, synced } = await pushJob(ctx, prompt, progressTo(ctx, "Handing off"));
  const lines = [
    `☁ Handoff started: job ${job.jobId} on Sprite ${job.sprite}`,
    `Conversation: ${conversationName(job)}`,
    job.jobBranch === undefined
      ? "No git repo here: the job has the conversation only."
      : `Branch ${job.jobBranch} on origin${job.snapshot ? " (uncommitted work included as a snapshot commit)" : ""}.`,
    "This session stays here, unchanged. A message will appear here when the job finishes or needs input.",
  ];
  if (synced.length > 0) lines.push(`Synced first: ${synced.join(", ")}.`);
  ctx.ui.notify(lines.join("\n"), "info");
  await runtime.refreshStatusLine();
}

async function syncCommand(ctx: ExtensionCommandContext): Promise<void> {
  const { config, created } = await loadConfig();
  const report = await syncSprite(config, config.sprite, progressTo(ctx, `Syncing ${config.sprite}`));
  const lines = [
    report.updated.length === 0 ? `☁ ${config.sprite} is up to date.` : `☁ Synced to ${config.sprite}: ${report.updated.join(", ")}.`,
  ];
  if (created) lines.push(`Wrote the default config to ${CONFIG_FILE}.`);
  if (report.notes.length > 0) lines.push(...report.notes.map((n) => `- ${n}`));
  ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * The job browser. Enter on a job opens its actions; Esc there goes back to the list
 * with the same filter and selection, Esc in the list closes it.
 */
async function statusCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: HandoffRuntime,
  typedFilter: string,
): Promise<void> {
  const filter = typedFilter === "" ? "all" : parseFilter(typedFilter);
  if (filter === undefined) {
    ctx.ui.notify(`Unknown filter "${typedFilter}". Use one of: ${TYPED_FILTERS.join(", ")}.`, "error");
    return;
  }
  if (!ctx.hasUI) {
    await runtime.poll({ all: true });
    ctx.ui.notify(plainList(await listJobs(), filter, Date.now()), "info");
    return;
  }

  const state: BrowserState = { filter, refreshing: true };
  for (;;) {
    const picked = await browse(ctx, runtime, state);
    if (picked === undefined) return;
    state.filter = picked.filter;
    state.selectedId = picked.jobId;
    state.refreshing = false;

    const job = await readJob(picked.jobId);
    if (job === undefined) continue;
    const actions = jobActions(job);
    const back = "← Back to the list";
    const choice = await ctx.ui.select(`${job.jobId} ${outcomeLabel(job.state)} · ${conversationName(job)}`, [
      ...actions.map((action) => ACTION_LABELS[action]),
      back,
    ]);
    const action = actions.find((a) => ACTION_LABELS[a] === choice);
    switch (action) {
      case undefined:
        continue;
      case "show":
        pi.appendEntry(OUTCOME_ENTRY, buildOutcomeCard(job, { full: true }));
        return;
      case "pullOpen":
      case "pull":
        await runPull(ctx, runtime, job, { abort: false, worktree: false, switchTo: action === "pullOpen" });
        return;
      case "abort": {
        const ok = await ctx.ui.confirm(
          `Abort ${job.jobId}?`,
          `Stop "${conversationName(job)}" now. Its work so far stays on the Sprite and on ${job.jobBranch ?? "the job"}; pull it or reply later.`,
        );
        if (!ok) continue;
        progressTo(ctx, `Aborting ${job.jobId}`)("stopping the run…");
        const status = await stopJob(job);
        if (status !== undefined) await runtime.apply(job, status);
        await runtime.refreshStatusLine();
        return;
      }
      case "open":
        if (job.pulledSessionFile === undefined || !existsSync(job.pulledSessionFile)) {
          ctx.ui.notify(`The conversation of ${job.jobId} is no longer at ${job.pulledSessionFile ?? "its saved path"}.`, "error");
          return;
        }
        await ctx.switchSession(job.pulledSessionFile);
        return;
    }
  }
}

/** /handoff pull [job] [--abort] [--switch] [--worktree] */
async function pullCommand(ctx: ExtensionCommandContext, runtime: HandoffRuntime, words: string[]): Promise<void> {
  const flags = new Set(words.filter((w) => w.startsWith("--")));
  const unknown = [...flags].filter((f) => !Object.hasOwn(PULL_FLAGS, f));
  if (unknown.length > 0) {
    throw new Error(`unknown option ${unknown.join(", ")}; use ${Object.keys(PULL_FLAGS).join(", ")}`);
  }
  const ids = words.filter((w) => !w.startsWith("--"));
  if (ids.length > 1) throw new Error("pull one job at a time");

  let job: LocalJob | undefined;
  if (ids[0] !== undefined) {
    job = await readJob(ids[0]);
    if (job === undefined || job.jobId === undefined) throw new Error(`no job ${ids[0]}`);
  } else {
    const candidates = (await listJobs()).filter(isPullable);
    if (candidates.length === 0) throw new Error("no finished job to pull; /handoff status lists them all");
    if (candidates.length === 1) job = candidates[0];
    else if (ctx.hasUI) {
      const labels = candidates.map((j) => `${j.jobId}  ${outcomeLabel(j.state)}  ${conversationName(j)}`);
      const choice = await ctx.ui.select("Pull which job?", labels);
      job = candidates[labels.indexOf(choice ?? "")];
      if (job === undefined) return;
    } else throw new Error(`several jobs to pull: ${candidates.map((j) => j.jobId).join(", ")}; name one`);
  }
  if (job === undefined) return;
  if (job.state === "pulled") throw new Error(`${job.jobId} is already pulled; open it with /handoff status`);

  await runPull(ctx, runtime, job, {
    abort: flags.has("--abort"),
    worktree: flags.has("--worktree"),
    switchTo: flags.has("--switch"),
  });
}

/** Where a pulled job's work is now. */
function workLine(job: LocalJob): string {
  if (job.jobBranch === undefined) return "No git repo: only the conversation came back.";
  if (job.worktree !== undefined) return `Worktree: ${job.worktree} on branch ${job.jobBranch}.`;
  return `Branch: origin/${job.jobBranch} fetched; your working tree is unchanged.`;
}

async function runPull(
  ctx: ExtensionCommandContext,
  runtime: HandoffRuntime,
  job: LocalJob,
  options: PullOptions & { switchTo: boolean },
): Promise<void> {
  const result = await pullJob(job, options, progressTo(ctx, `Pulling ${job.jobId}`));
  const pulled = result.job;
  const lines = [
    `☁ Pulled job ${job.jobId}: ${conversationName(job)}`,
    options.switchTo
      ? "This is its conversation, continued here on the laptop."
      : "Its conversation is saved with this folder's sessions: open it from /resume or /handoff status.",
    workLine(pulled),
    ...(result.snapshot ? ["The agent's uncommitted changes were committed and pushed first."] : []),
    result.cleanupError === undefined ? "Removed from the Sprite." : `Could not clean up the Sprite: ${result.cleanupError}`,
  ];
  await runtime.refreshStatusLine();
  clearProgress(ctx);
  if (!options.switchTo) {
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }
  await ctx.switchSession(result.sessionFile, {
    withSession: async (fresh) => fresh.ui.notify(lines.join("\n"), "info"),
  });
}

/** Open the browser on the local records; on the first open, refresh them from the Sprite meanwhile. */
async function browse(
  ctx: ExtensionCommandContext,
  runtime: HandoffRuntime,
  state: BrowserState,
): Promise<BrowserResult | undefined> {
  const jobs = await listJobs();
  return ctx.ui.custom<BrowserResult | undefined>((tui, theme, _keybindings, done) => {
    const view = new JobBrowser(theme, jobs, state, () => tui.requestRender(), done);
    if (state.refreshing) {
      void runtime
        .poll({ all: true })
        .catch(() => undefined)
        .then(async () => view.setJobs(await listJobs(), false));
    }
    return view;
  });
}
