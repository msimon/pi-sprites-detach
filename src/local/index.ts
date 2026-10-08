// pi-handoff local extension, loaded on the laptop.
//
//   /handoff [prompt]          hand the conversation off to the Sprite as a new job
//   /handoff sync              bring the Sprite's pi setup in line with the laptop
//   /handoff status [filter]   browse jobs (all, running, needs-input, done, failed, aborted, pulled)
//
// Does nothing when loaded inside a handoff run on the Sprite.

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
import { conversationName, JOB_FILTERS, listJobs, parseFilter, readJob } from "./jobs.ts";
import { buildOutcomeCard, OUTCOME_ENTRY, outcomeLabel, registerOutcomeRenderer } from "./outcome.ts";
import { CONFIG_FILE } from "./paths.ts";
import { DEFAULT_PROMPT, pushJob } from "./push.ts";
import { HandoffRuntime } from "./runtime.ts";
import { syncSprite } from "./sync.ts";

const PROGRESS_KEY = "handoff-progress";
const SUBCOMMANDS = ["sync", "status"] as const;
/** Filters as typed after `status` (dashes instead of underscores). */
const TYPED_FILTERS = JOB_FILTERS.map((f) => f.replace("_", "-"));

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
    description: "Hand this conversation off to a Sprite (/handoff [prompt] | sync | status)",
    getArgumentCompletions: (prefix) => {
      const text = prefix.trimStart();
      if (text.startsWith("status ")) {
        const typed = text.slice("status ".length).trim();
        return TYPED_FILTERS.filter((f) => f.startsWith(typed)).map((f) => ({ value: `status ${f}`, label: f }));
      }
      return SUBCOMMANDS.filter((s) => s.startsWith(text.trim())).map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = "", ...rest] = trimmed.split(/\s+/);
      try {
        if (trimmed === "sync") await syncCommand(ctx);
        else if (subcommand === "status") await statusCommand(pi, ctx, runtime, rest.join(" "));
        else await pushCommand(ctx, runtime, trimmed === "" ? DEFAULT_PROMPT : trimmed);
      } catch (error: unknown) {
        ctx.ui.notify(`[pi-handoff] ${(error as Error).message}`, "error");
      } finally {
        ctx.ui.setWidget(PROGRESS_KEY, undefined);
      }
    },
  });
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
    if (action === undefined) continue;
    if (action === "show") pi.appendEntry(OUTCOME_ENTRY, buildOutcomeCard(job, { full: true }));
    return;
  }
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
