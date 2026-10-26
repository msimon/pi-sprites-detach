// pi-sprites-detach local extension, loaded on the laptop.
//
//   /detach [prompt]          detach the conversation to the Sprite as a new job
//   /detach sync              bring the Sprite's pi setup in line with the laptop
//   /detach status [filter]   browse jobs (all, running, joined, needs-input, done, failed, aborted, pulled, dropped)
//   /detach reply [job] [text]
//                              another run of a finished job: an answer, or more work
//   /detach pull [job] [--here] [--switch] [--abort] [--worktree]
//                              bring a job's conversation and work back; --here also
//                              brings its context into this conversation
//   /detach watch [job]       follow a run live (read-only), or replay a finished job's last run
//   /detach cleanup [job] [--discard] [--remote]
//                              remove a pulled job's worktree and branches from the laptop
//   /detach drop [job] [--keep-branch]
//                              discard a job's work (stopping its run); keep its conversation
//   /attach [job] [--abort]   work with a job's agent live on the Sprite (a cmux split)
//
// A prompt for /detach cannot start with one of the subcommand words; they are read
// as the subcommand.
//
// Does nothing when loaded inside a job run on the Sprite.

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
  isJobIdShaped,
  isOffSprite,
  JOB_FILTERS,
  type LocalJob,
  listJobs,
  matchesFilter,
  parseFilter,
  readJob,
  writeJob,
} from "./jobs.ts";
import { bringContextHere } from "./here.ts";
import { buildOutcomeCard, OUTCOME_ENTRY, outcomeLabel, registerOutcomeRenderer } from "./outcome.ts";
import { CONFIG_FILE } from "./paths.ts";
import { type PullOptions, pullJob, retryWayBack, StillRunningError, stopJob } from "./pull.ts";
import { needsWayBack } from "./wayback.ts";
import { canReply, replyJob } from "./reply.ts";
import { canJoin, joinJob, openSplit, RunInProgressError } from "./join.ts";
import { DEFAULT_PROMPT, pushJob } from "./push.ts";
import { migrateLegacyHome } from "./migrate.ts";
import { DetachCancelledError } from "./git.ts";
import { DetachRuntime } from "./runtime.ts";
import { syncSprite } from "./sync.ts";
import { registerDetachTools } from "./tools.ts";
import { canWatch, isLive, startWatchStream, type WatchStream, WatchView } from "./watch.ts";
import { blockers, canCleanup, type CleanupOptions, cleanupJob, describePlan, planCleanup } from "./cleanup.ts";
import { canDrop, type DropOptions, DropRefusedError, dropJob, dropStopsRun } from "./drop.ts";

const PROGRESS_KEY = "detach-progress";
/** Subcommands as the completion menu shows them: usage as the label, what it does beside it. */
const SUBCOMMANDS = [
  { name: "sync", usage: "sync", description: "bring the Sprite's pi setup in line with the laptop" },
  { name: "status", usage: "status [filter]", description: "browse jobs by state, pull or abort them" },
  { name: "reply", usage: "reply [job] [text]", description: "answer a finished job, or ask it for more work" },
  // pi's menu cuts the label at ~30 characters, so the options go in the description.
  {
    name: "pull",
    usage: "pull [job] [options]",
    description: "bring a job back. Options: --here, --switch, --abort, --worktree",
  },
  { name: "watch", usage: "watch [job]", description: "follow a run live, read-only, or replay the last one" },
  {
    name: "cleanup",
    usage: "cleanup [job] [options]",
    description: "remove a pulled job's worktree and branch. Options: --discard, --remote",
  },
  { name: "drop", usage: "drop [job] [--keep-branch]", description: "discard a job's work (stops a run), keep its conversation" },
] as const;
const PULL_FLAGS = {
  "--here": "bring its context into this conversation",
  "--switch": "open its conversation after pulling",
  "--abort": "stop a run in progress first",
  "--worktree": "check the job branch out in a local worktree",
} as const;
/** Filters as typed after `status` (dashes instead of underscores). */
const TYPED_FILTERS = JOB_FILTERS.map((f) => f.replace("_", "-"));

/**
 * Jobs /detach pull can take without --abort: their run has ended (same as reply),
 * or they are pulled and their work still waits to come back (a retry).
 */
const isPullable = (job: LocalJob): boolean => canReply(job) || needsWayBack(job);

export default function detachLocal(pi: ExtensionAPI): void {
  if (process.env.DETACH_JOB_ID !== undefined) return;

  const runtime = new DetachRuntime(pi);
  registerOutcomeRenderer(pi);
  registerDetachTools(pi, runtime);

  pi.on("session_start", async (_event, ctx) => {
    try {
      // Before anything reads the config or the job records: they move with the folder.
      const moved = await migrateLegacyHome();
      if (moved !== undefined) ctx.ui.notify(`[pi-sprites-detach] ${moved}`, moved.startsWith("Moved") ? "info" : "warning");
      await ensureSpriteBuild();
      await runtime.start(ctx);
    } catch (error: unknown) {
      ctx.ui.notify(`[pi-sprites-detach] ${(error as Error).message}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    runtime.stop();
  });

  pi.registerCommand("attach", {
    description: "Work with a job's agent live on the Sprite, in a split (/attach [job] [--abort])",
    getArgumentCompletions: async (prefix) => {
      const words = prefix.trimStart().split(/\s+/);
      const typed = words.pop() ?? "";
      const jobs = (await listJobs())
        .filter(canJoin)
        .map((j) => ({ word: j.jobId, description: `${outcomeLabel(j.state)} · ${conversationName(j)}` }));
      return [...jobs, { word: "--abort", description: "stop a run in progress first" }]
        .filter(({ word }) => word.startsWith(typed) && !words.includes(word))
        .map(({ word, description }) => ({ value: [...words, word].join(" "), label: word, description }));
    },
    handler: async (args, ctx) => {
      try {
        await joinCommand(ctx, runtime, args.trim() === "" ? [] : args.trim().split(/\s+/));
      } catch (error: unknown) {
        notifySafely(ctx, `[pi-sprites-detach] ${(error as Error).message}`, "error");
      } finally {
        clearProgress(ctx);
      }
    },
  });

  pi.registerCommand("detach", {
    description: "Detach this conversation to a Sprite (/detach [prompt] | sync | status | reply | pull | watch | cleanup | drop)",
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
      if (text.startsWith("reply ")) {
        const words = text.slice("reply ".length).split(/\s+/);
        if (words.length > 1) return null; // past the job id: free text
        const typed = words[0] ?? "";
        return (await listJobs())
          .filter((j) => canReply(j) && j.jobId.startsWith(typed))
          .map((j) => ({
            value: `reply ${j.jobId} `,
            label: j.jobId,
            description: `${outcomeLabel(j.state)} · ${conversationName(j)}`,
          }));
      }
      if (text.startsWith("watch ")) {
        const typed = text.slice("watch ".length).trim();
        return (await listJobs())
          .filter((j) => canWatch(j) && j.jobId.startsWith(typed))
          .map((j) => ({
            value: `watch ${j.jobId}`,
            label: j.jobId,
            description: `${outcomeLabel(j.state)} · ${conversationName(j)}`,
          }));
      }
      if (text.startsWith("cleanup ")) {
        const words = text.slice("cleanup ".length).split(/\s+/);
        const typed = words.pop() ?? "";
        const head = ["cleanup", ...words].join(" ");
        const jobs = (await listJobs())
          .filter(canCleanup)
          .map((j) => ({ word: j.jobId, description: `${j.jobBranch ?? ""} · ${conversationName(j)}` }));
        const flags = Object.entries(CLEANUP_FLAGS).map(([word, description]) => ({ word, description }));
        return [...jobs, ...flags]
          .filter(({ word }) => word.startsWith(typed) && !words.includes(word))
          .map(({ word, description }) => ({ value: `${head} ${word}`, label: word, description }));
      }
      if (text.startsWith("drop ")) {
        const words = text.slice("drop ".length).split(/\s+/);
        const typed = words.pop() ?? "";
        const head = ["drop", ...words].join(" ");
        const jobs = (await listJobs())
          .filter(canDrop)
          .map((j) => ({ word: j.jobId, description: `${outcomeLabel(j.state)} · ${conversationName(j)}` }));
        const flags = Object.entries(DROP_FLAGS).map(([word, description]) => ({ word, description }));
        return [...jobs, ...flags]
          .filter(({ word }) => word.startsWith(typed) && !words.includes(word))
          .map(({ word, description }) => ({ value: `${head} ${word}`, label: word, description }));
      }
      if (text.startsWith("pull ")) {
        const words = text.slice("pull ".length).split(/\s+/);
        const typed = words.pop() ?? "";
        const head = ["pull", ...words].join(" ");
        const jobs = (await listJobs())
          .filter((j) => j.state !== "pulled" || needsWayBack(j))
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
        else if (subcommand === "pull") await pullCommand(pi, ctx, runtime, rest);
        else if (subcommand === "reply") await replyCommand(ctx, runtime, trimmed.slice("reply".length).trim());
        else if (subcommand === "watch") await watchCommand(ctx, runtime, rest);
        else if (subcommand === "cleanup") await cleanupCommand(ctx, runtime, rest);
        else if (subcommand === "drop") await dropCommand(ctx, runtime, rest);
        else await pushCommand(ctx, runtime, trimmed === "" ? DEFAULT_PROMPT : trimmed);
      } catch (error: unknown) {
        const message = (error as Error).message;
        notifySafely(ctx, error instanceof StillRunningError ? `☁ ${message}` : `[pi-sprites-detach] ${message}`, "error");
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

async function pushCommand(ctx: ExtensionCommandContext, runtime: DetachRuntime, prompt: string): Promise<void> {
  let pushed: Awaited<ReturnType<typeof pushJob>>;
  try {
    pushed = await pushJob(
      {
        sessionManager: ctx.sessionManager,
        waitForIdle: () => ctx.waitForIdle(),
        ...(ctx.hasUI ? { ask: (title: string, options: string[]) => ctx.ui.select(title, options) } : {}),
      },
      prompt,
      progressTo(ctx, "Detaching"),
    );
  } catch (error: unknown) {
    if (!(error instanceof DetachCancelledError)) throw error;
    ctx.ui.notify(`☁ ${error.message}`, "info");
    return;
  }
  const { job, synced, notes } = pushed;
  const lines = [
    `☁ Detached: job ${job.jobId} on Sprite ${job.sprite}`,
    `Conversation: ${conversationName(job)}`,
    job.jobBranch === undefined
      ? "No git repo here: the job has the conversation only."
      : `Branch ${job.jobBranch} on origin${job.snapshotSha !== undefined ? " (uncommitted work included as a snapshot commit)" : ""}.`,
    ...notes,
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
  runtime: DetachRuntime,
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
      case "reply": {
        const text = await askReply(ctx, job);
        if (text === undefined) continue;
        await runReply(ctx, runtime, job, text);
        return;
      }
      case "join":
        await runJoin(ctx, runtime, job, { abort: false });
        return;
      case "watch":
        await runWatch(ctx, runtime, job);
        return;
      case "cleanup":
        await runCleanup(ctx, runtime, job, { discard: false, remote: false });
        return;
      case "show":
        pi.appendEntry(OUTCOME_ENTRY, buildOutcomeCard(job, { full: true }));
        return;
      case "pullHere":
      case "pullOpen":
      case "pull":
        await runPull(pi, ctx, runtime, job, {
          abort: false,
          worktree: false,
          switchTo: action === "pullOpen",
          here: action === "pullHere",
        });
        return;
      case "here":
        await runContextHere(pi, ctx, job);
        return;
      case "drop":
        await runDrop(ctx, runtime, job, { keepBranch: false });
        return;
      case "bringBack":
        await runRetryWayBack(ctx, runtime, job);
        return;
      case "abort": {
        const ok = await ctx.ui.confirm(
          `Abort ${job.jobId}?`,
          job.state === "joined"
            ? `Quit the pi you attached to on the Sprite for "${conversationName(job)}". The conversation and its work stay there; attach, reply or pull later.`
            : `Stop "${conversationName(job)}" now. Its work so far stays on the Sprite and on ${job.jobBranch ?? "the job"}; pull it or reply later.`,
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

/** /detach pull [job] [--abort] [--switch] [--worktree] [--here] */
async function pullCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: DetachRuntime,
  words: string[],
): Promise<void> {
  const flags = new Set(words.filter((w) => w.startsWith("--")));
  const unknown = [...flags].filter((f) => !Object.hasOwn(PULL_FLAGS, f));
  if (unknown.length > 0) {
    throw new Error(`unknown option ${unknown.join(", ")}; use ${Object.keys(PULL_FLAGS).join(", ")}`);
  }
  const here = flags.has("--here");
  if (here && flags.has("--switch")) throw new Error("--here keeps this conversation; it does not go with --switch");
  const ids = words.filter((w) => !w.startsWith("--"));
  if (ids.length > 1) throw new Error("pull one job at a time");

  const job =
    ids[0] === undefined
      ? await pickJob(ctx, isPullable, "Pull which job?", "no finished job to pull; /detach status lists them all")
      : await readJob(ids[0]);
  if (job === undefined) {
    if (ids[0] !== undefined) throw new Error(`no job ${ids[0]}`);
    return;
  }
  if (job.state === "pulled") {
    if (here) return runContextHere(pi, ctx, job);
    if (needsWayBack(job)) return runRetryWayBack(ctx, runtime, job);
    throw new Error(`${job.jobId} is already pulled; open it with /detach status, or bring its context here with --here`);
  }

  await runPull(pi, ctx, runtime, job, {
    abort: flags.has("--abort"),
    worktree: flags.has("--worktree"),
    switchTo: flags.has("--switch"),
    here,
  });
}

/**
 * The only job that fits, or the user's pick when several do. Undefined when the
 * pick is cancelled; throws when none fits or there is no UI to ask.
 */
async function pickJob(
  ctx: ExtensionCommandContext,
  fits: (job: LocalJob) => boolean,
  title: string,
  none: string,
): Promise<LocalJob | undefined> {
  const candidates = (await listJobs()).filter(fits);
  if (candidates.length === 0) throw new Error(none);
  if (candidates.length === 1) return candidates[0];
  if (!ctx.hasUI) throw new Error(`several jobs fit: ${candidates.map((j) => j.jobId).join(", ")}; name one`);
  const labels = candidates.map((j) => `${j.jobId}  ${outcomeLabel(j.state)}  ${conversationName(j)}`);
  const choice = await ctx.ui.select(title, labels);
  return candidates[labels.indexOf(choice ?? "")];
}

/** /attach [job] [--abort] */
async function joinCommand(ctx: ExtensionCommandContext, runtime: DetachRuntime, words: string[]): Promise<void> {
  const abort = words.includes("--abort");
  const unknown = words.filter((w) => w.startsWith("--") && w !== "--abort");
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(", ")}; use --abort`);
  const ids = words.filter((w) => !w.startsWith("--"));
  if (ids.length > 1) throw new Error("attach to one job at a time");

  const job =
    ids[0] === undefined
      ? await pickJob(ctx, canJoin, "Attach to which job?", await noJoinableMessage())
      : await readJob(ids[0]);
  if (job === undefined) {
    if (ids[0] !== undefined) throw new Error(`no job ${ids[0]}`);
    return;
  }
  await runJoin(ctx, runtime, job, { abort });
}

/** /detach watch [job]: a read-only view of a run as it happens, or of a finished job's last run. */
async function watchCommand(ctx: ExtensionCommandContext, runtime: DetachRuntime, words: string[]): Promise<void> {
  if (words.length > 1) throw new Error("watch one job at a time");
  let job: LocalJob | undefined;
  if (words[0] !== undefined) {
    job = await readJob(words[0]);
    if (job === undefined) throw new Error(`no job ${words[0]}`);
  } else {
    const live = (await listJobs()).filter((j) => canWatch(j) && isLive(j));
    job = live.length === 1 ? live[0] : await pickJob(ctx, canWatch, "Watch which job?", "no job to watch; /detach status lists them all");
  }
  if (job === undefined) return;
  await runWatch(ctx, runtime, job);
}

async function runWatch(ctx: ExtensionCommandContext, runtime: DetachRuntime, job: LocalJob): Promise<void> {
  if (!ctx.hasUI) throw new Error("/detach watch needs the terminal UI");
  if (isOffSprite(job)) throw new Error(`${job.jobId} is ${job.state}: its events are no longer on the Sprite`);
  if (job.state === "joined") throw new Error(`${job.jobId} is joined, so it is not streamed: attach to it with /attach ${job.jobId}`);

  // The Sprite needs the detach-watch script; this is one small read when nothing changed.
  const progress = progressTo(ctx, `Watching ${job.jobId}`);
  progress("syncing the Sprite…");
  const { config } = await loadConfig();
  await syncSprite(config, job.sprite, progress);
  clearProgress(ctx);

  // Closing the view ends the stream; the kill of `sprite exec` ends detach-watch on the Sprite.
  const open: { stream?: WatchStream } = {};
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const view = new WatchView(theme, job, () => tui.terminal.rows, () => tui.requestRender(), () => done());
    open.stream = startWatchStream(
      job,
      (line) => view.feed(line),
      (result) => view.streamClosed(result),
    );
    return view;
  });
  open.stream?.stop();
  await runtime.poll({ all: true }).catch(() => undefined);
  await runtime.refreshStatusLine();
}

const CLEANUP_FLAGS = {
  "--discard": "remove even with uncommitted or unmerged work in it",
  "--remote": "also delete the job branch on origin",
} as const;

/** /detach cleanup [job] [--discard] [--remote]: remove a pulled job's worktree and branches on the laptop. */
async function cleanupCommand(ctx: ExtensionCommandContext, runtime: DetachRuntime, words: string[]): Promise<void> {
  const flags = new Set(words.filter((w) => w.startsWith("--")));
  const unknown = [...flags].filter((f) => !Object.hasOwn(CLEANUP_FLAGS, f));
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(", ")}; use ${Object.keys(CLEANUP_FLAGS).join(", ")}`);
  const ids = words.filter((w) => !w.startsWith("--"));
  if (ids.length > 1) throw new Error("clean up one job at a time");

  const job =
    ids[0] === undefined
      ? await pickJob(ctx, canCleanup, "Clean up which job?", "no pulled job with a branch to clean up; /detach status pulled lists them")
      : await readJob(ids[0]);
  if (job === undefined) {
    if (ids[0] !== undefined) throw new Error(`no job ${ids[0]}`);
    return;
  }
  await runCleanup(ctx, runtime, job, { discard: flags.has("--discard"), remote: flags.has("--remote") });
}

/** Show what will go and ask, then remove it. Unmerged or uncommitted work is refused without --discard. */
async function runCleanup(
  ctx: ExtensionCommandContext,
  runtime: DetachRuntime,
  job: LocalJob,
  options: CleanupOptions,
): Promise<void> {
  if (job.cleanedAt !== undefined) throw new Error(`${job.jobId} is already cleaned up`);
  const progress = progressTo(ctx, `Cleaning up ${job.jobId}`);
  progress("looking at what is there…");
  try {
    const plan = await planCleanup(job, options);
    // With a blocker, cleanupJob below refuses with the reasons: no question first.
    if (ctx.hasUI && blockers(plan, options).length === 0) {
      const items = describePlan(plan, options);
      const risk = options.discard ? "\n\nUncommitted or unmerged work in them is lost." : "";
      const hint = plan.worktree === undefined ? "" : "\nClose any pi session that is open in the worktree first.";
      if (items.length > 0 && !(await ctx.ui.confirm(`Clean up ${job.jobId}?`, `Remove:\n- ${items.join("\n- ")}${hint}${risk}`))) return;
    }
    const { job: cleaned, removed } = await cleanupJob(job, options, progress, plan);
    await writeJob(cleaned);
    ctx.ui.notify(
      removed.length === 0
        ? `☁ Job ${job.jobId}: nothing was left to remove.`
        : `☁ Cleaned up job ${job.jobId}: removed ${removed.join(", ")}. Its conversation is kept (/detach status, /resume).`,
      "info",
    );
    await runtime.refreshStatusLine();
  } finally {
    clearProgress(ctx);
  }
}

const DROP_FLAGS = { "--keep-branch": "keep the job branch on origin" } as const;

/** /detach drop [job] [--keep-branch]: discard a job's work (stopping its run), keep its conversation. */
async function dropCommand(ctx: ExtensionCommandContext, runtime: DetachRuntime, words: string[]): Promise<void> {
  const flags = new Set(words.filter((w) => w.startsWith("--")));
  const unknown = [...flags].filter((f) => !Object.hasOwn(DROP_FLAGS, f));
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(", ")}; use ${Object.keys(DROP_FLAGS).join(", ")}`);
  const ids = words.filter((w) => !w.startsWith("--"));
  if (ids.length > 1) throw new Error("drop one job at a time");
  const job =
    ids[0] === undefined
      ? await pickJob(ctx, canDrop, "Drop which job?", "no job to drop; /detach status lists them all")
      : await readJob(ids[0]);
  if (job === undefined) {
    if (ids[0] !== undefined) throw new Error(`no job ${ids[0]}`);
    return;
  }
  await runDrop(ctx, runtime, job, { keepBranch: flags.has("--keep-branch") });
}

/** Ask, then drop. Without a UI there is nobody to ask: refuse, as the work would be lost. */
async function runDrop(
  ctx: ExtensionCommandContext,
  runtime: DetachRuntime,
  job: LocalJob,
  options: Pick<DropOptions, "keepBranch">,
): Promise<void> {
  if (!canDrop(job)) throw new Error(`${job.jobId} is ${outcomeLabel(job.state)}: it is no longer on the Sprite`);
  if (!ctx.hasUI) throw new Error(`dropping ${job.jobId} discards its work and needs a confirmation; run it with the UI`);
  // Asked about here, so a run that only started after this question is refused, not stopped.
  const stopRun = dropStopsRun(job);
  let branch = "";
  if (job.jobBranch !== undefined) {
    branch = ` Its branch ${job.jobBranch} ${options.keepBranch ? "stays on" : "is deleted on"} origin.`;
  }
  const run = stopRun ? " Its run in progress is stopped first." : "";
  const ok = await ctx.ui.confirm(
    `Drop ${job.jobId}?`,
    `Discard the work of "${conversationName(job)}".${run}${branch} Its conversation is saved here; your folder is not touched. It is removed from the Sprite.`,
  );
  if (!ok) return;
  const progress = progressTo(ctx, `Dropping ${job.jobId}`);
  try {
    const { lines } = await dropJob(job, { ...options, stopRun }, progress);
    ctx.ui.notify([`☁ Dropped job ${job.jobId}: ${conversationName(job)}`, ...lines].join("\n"), "info");
    await runtime.refreshStatusLine();
  } catch (error: unknown) {
    if (!(error instanceof DropRefusedError)) throw error;
    ctx.ui.notify(`☁ ${error.message}`, "error");
  } finally {
    clearProgress(ctx);
  }
}

/** Why /attach has no job to offer: say when one is still running. */
async function noJoinableMessage(): Promise<string> {
  const running = (await listJobs()).filter((j) => ACTIVE_STATES.includes(j.state) && j.state !== "joined");
  const first = running[0];
  if (first === undefined) return "no job to attach to; /detach status lists them all";
  const ids = running.map((j) => j.jobId).join(", ");
  return running.length === 1
    ? `${ids} is still running, and a running job can't be attached to. Attach once it finishes (a card will appear), or stop its run and attach now with /attach ${first.jobId} --abort.`
    : `${ids} are still running, and a running job can't be attached to. Attach once one finishes (a card will appear), or stop a run and attach now with /attach <job> --abort.`;
}

/**
 * Attach: start (or find) pi on the Sprite, then attach a terminal to it. A run in
 * progress is stopped first only with --abort, or when the user agrees.
 */
async function runJoin(
  ctx: ExtensionCommandContext,
  runtime: DetachRuntime,
  job: LocalJob,
  { abort }: { abort: boolean },
): Promise<void> {
  if (isOffSprite(job)) throw new Error(`${job.jobId} is ${job.state}; continue in its conversation instead`);
  const progress = progressTo(ctx, `Attaching to ${job.jobId}`);
  let outcome;
  try {
    outcome = await joinJob(job, { abort }, progress);
  } catch (error: unknown) {
    if (!(error instanceof RunInProgressError) || abort || !ctx.hasUI) throw error;
    const stop = await ctx.ui.confirm(
      `${job.jobId} is running`,
      `Stop its run to attach now? The work so far stays on the Sprite; the agent picks up from the conversation.`,
    );
    if (!stop) return;
    outcome = await joinJob((await readJob(job.jobId)) ?? job, { abort: true }, progress);
  }

  const split = await openSplit(outcome.attachCommand);
  const lines = [
    `☁ ${outcome.already ? "Reattached to" : "Attached to"} job ${job.jobId}: ${conversationName(job)}`,
    split
      ? "pi is open in the split next to this pane, on the Sprite."
      : `pi is running on Sprite ${job.sprite}. Attach to it from any terminal:\n${outcome.attachCommand}`,
    "Close the pane whenever you like: pi finishes its turn, quits once nobody is attached, and a message appears here.",
  ];
  if (outcome.synced.length > 0) lines.push(`Synced first: ${outcome.synced.join(", ")}.`);
  clearProgress(ctx);
  ctx.ui.notify(lines.join("\n"), "info");
  await runtime.refreshStatusLine();
}

/** /detach reply [job] [text]: without text, ask for it. */
async function replyCommand(ctx: ExtensionCommandContext, runtime: DetachRuntime, args: string): Promise<void> {
  // Ids are d (or h) + base 36, so a first word like "hey" or "do" is id-shaped: it
  // names a job only if that job exists; otherwise it is the start of the text.
  const first = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
  const word = first?.[1];
  const firstJob = word !== undefined && isJobIdShaped(word) ? await readJob(word) : undefined;
  if (word !== undefined && firstJob === undefined && /^[dh]\d+$/.test(word)) throw new Error(`no job ${word}`);
  const named = firstJob === undefined ? null : first;
  const job =
    firstJob ??
    (await pickJob(ctx, canReply, "Reply to which job?", "no finished job to reply to; /detach status lists them all"));
  if (job === undefined) return;
  if (isOffSprite(job)) throw new Error(`${job.jobId} is ${job.state}; continue in its conversation instead`);
  if (!canReply(job)) {
    throw new Error(
      job.state === "joined"
        ? `${job.jobId} is joined: pi is live on the Sprite, so type there (/attach ${job.jobId} reattaches)`
        : `${job.jobId} is still running; reply once it finishes`,
    );
  }

  let text = named ? (named[2] ?? "") : args;
  if (text.trim() === "") {
    if (!ctx.hasUI) throw new Error("usage: /detach reply [job] <text>");
    const asked = await askReply(ctx, job);
    if (asked === undefined) return;
    text = asked;
  }
  await runReply(ctx, runtime, job, text);
}

/**
 * Ask for a reply. A single question with options offers them first (plus writing
 * one); otherwise an editor, prefilled with the questions when there are several.
 */
async function askReply(ctx: ExtensionCommandContext, job: LocalJob): Promise<string | undefined> {
  const questions = job.state === "needs_input" ? (job.questions ?? []) : [];
  const first = questions[0];
  if (questions.length === 1 && first?.options !== undefined && first.options.length > 0) {
    const write = "Write a reply…";
    const choice = await ctx.ui.select(first.question, [...first.options.map((o) => o.label), write]);
    if (choice === undefined) return undefined;
    if (choice !== write) return choice;
  }
  const prefill = questions.length > 1 ? questions.map((q) => `${q.question}\n> \n`).join("\n") : "";
  const title = questions.length === 1 && first ? `Reply to ${job.jobId}: ${first.question}` : `Reply to ${job.jobId}`;
  const text = await ctx.ui.editor(title, prefill);
  return text === undefined || text.trim() === "" ? undefined : text;
}

async function runReply(ctx: ExtensionCommandContext, runtime: DetachRuntime, job: LocalJob, text: string): Promise<void> {
  const { synced } = await replyJob(job, text, progressTo(ctx, `Replying to ${job.jobId}`));
  const lines = [
    `☁ Replied to job ${job.jobId}: ${conversationName(job)}`,
    `It is running again on Sprite ${job.sprite}. A message will appear here when it finishes or needs input.`,
  ];
  if (synced.length > 0) lines.push(`Synced first: ${synced.join(", ")}.`);
  ctx.ui.notify(lines.join("\n"), "info");
  await runtime.refreshStatusLine();
}

/** Where a pulled job's work is now. */
function workLine(job: LocalJob): string {
  if (job.jobBranch === undefined) return "No git repo: only the conversation came back.";
  if (job.worktree !== undefined) return `Worktree: ${job.worktree} on branch ${job.jobBranch}.`;
  if (job.wayBackText !== undefined) return job.wayBackText;
  return `Branch: origin/${job.jobBranch} fetched; your working tree is unchanged.`;
}

/** /detach pull on a pulled job whose work could not come back yet: try again. */
async function runRetryWayBack(ctx: ExtensionCommandContext, runtime: DetachRuntime, job: LocalJob): Promise<void> {
  const { wayBack } = await retryWayBack(job, progressTo(ctx, `Bringing back ${job.jobId}`));
  clearProgress(ctx);
  ctx.ui.notify(`☁ ${job.jobId}: ${wayBack.text}`, wayBack.kind === "pending" ? "error" : "info");
  await runtime.refreshStatusLine();
}

async function runPull(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: DetachRuntime,
  job: LocalJob,
  options: PullOptions & { switchTo: boolean; here: boolean },
): Promise<void> {
  const progress = progressTo(ctx, `Pulling ${job.jobId}`);
  const result = await pullJob(job, options, progress);
  const pulled = result.job;
  const lines = [
    `☁ Pulled job ${job.jobId}: ${conversationName(job)}`,
    options.switchTo
      ? "This is its conversation, continued here on the laptop."
      : "Its conversation is saved with this folder's sessions: open it from /resume or /detach status.",
    workLine(pulled),
    ...(result.snapshot ? ["The agent's uncommitted changes were committed and pushed first."] : []),
    result.cleanupError === undefined
      ? "Removed from the Sprite."
      : `Could not clean up the Sprite (${result.cleanupError}); it will be retried in the background.`,
  ];
  if (options.here) lines.push(await contextHereLine(pi, ctx, pulled, progress));
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

/** Bring a pulled job's context into this conversation; the line to report, success or not. */
async function contextHereLine(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  job: LocalJob,
  progress: (text: string) => void,
): Promise<string> {
  try {
    await bringContextHere(pi, ctx, job, progress);
    return `Its context is in this conversation now (the ☁ Context from job ${job.jobId} line; expand it to read).`;
  } catch (error: unknown) {
    return `Could not bring its context here: ${(error as Error).message}. Try again with /detach pull ${job.jobId} --here.`;
  }
}

/** --here on a job already pulled: only its context. */
async function runContextHere(pi: ExtensionAPI, ctx: ExtensionCommandContext, job: LocalJob): Promise<void> {
  const line = await contextHereLine(pi, ctx, job, progressTo(ctx, `Bringing ${job.jobId} here`));
  clearProgress(ctx);
  ctx.ui.notify(`☁ Job ${job.jobId}: ${conversationName(job)}\n${line}`, line.startsWith("Could not") ? "error" : "info");
}

/** Open the browser on the local records; on the first open, refresh them from the Sprite meanwhile. */
async function browse(
  ctx: ExtensionCommandContext,
  runtime: DetachRuntime,
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
