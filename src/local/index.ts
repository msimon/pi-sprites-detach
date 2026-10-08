// pi-handoff local extension, loaded on the laptop.
//
//   /handoff [prompt]   hand the conversation off to the Sprite as a new job
//   /handoff sync       bring the Sprite's pi setup in line with the laptop
//   /handoff status     list jobs
//
// Does nothing when loaded inside a handoff run on the Sprite.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE } from "./paths.ts";
import { loadConfig } from "./config.ts";
import { ensureSpriteBuild } from "./install.ts";
import { conversationName, listJobs } from "./jobs.ts";
import { registerOutcomeRenderer } from "./outcome.ts";
import { DEFAULT_PROMPT, pushJob } from "./push.ts";
import { describeOutcome, HandoffRuntime } from "./runtime.ts";
import { syncSprite } from "./sync.ts";

const PROGRESS_KEY = "handoff-progress";
const SUBCOMMANDS = ["sync", "status"] as const;

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
    getArgumentCompletions: (prefix) =>
      SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      try {
        if (trimmed === "sync") await syncCommand(ctx);
        else if (trimmed === "status") await statusCommand(ctx, runtime);
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

async function statusCommand(ctx: ExtensionCommandContext, runtime: HandoffRuntime): Promise<void> {
  await runtime.poll({ all: true });
  const jobs = (await listJobs()).filter((j) => j.state !== "pulled");
  if (jobs.length === 0) {
    ctx.ui.notify("☁ No handoff jobs.", "info");
    return;
  }
  const lines = jobs.map((job) => {
    const { label, body } = describeOutcome(job);
    const branch = job.jobBranch === undefined ? "" : `  ${job.jobBranch}`;
    return `${job.jobId}  ${label}  ${job.jobName}${branch}${body === "" ? "" : `\n    ${body}`}`;
  });
  ctx.ui.notify(lines.join("\n"), "info");
}
