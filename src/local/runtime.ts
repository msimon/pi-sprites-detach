// Polling, notifications and the status line.
//
// Each window polls the active jobs it started every ~45 s (one small exec per
// Sprite; the Sprite is awake anyway while a run holds it). On session_start a
// window also checks every active job once, which reports jobs that finished while
// no pi was watching. Polling is wall-clock free: a tick after a laptop sleep just
// reads the current state, so a missed interval only delays the warning.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitJson, spriteJson } from "./exec.ts";
import {
  ACTIVE_STATES,
  claimNotification,
  conversationName,
  FILTER_LABELS,
  type JobFilter,
  type JobState,
  type LocalJob,
  listJobs,
  matchesFilter,
  type Question,
  STATUS_LINE_FILTERS,
  writeJob,
} from "./jobs.ts";
import { cmuxNotify } from "./notify.ts";
import { buildOutcomeCard, OUTCOME_ENTRY, outcomeLabel } from "./outcome.ts";
import { REMOTE_STATE } from "./paths.ts";

const POLL_MS = 45_000;
const STATUS_KEY = "handoff";
const BODY_MAX = 300;

/** The fields of the Sprite's status.json the laptop uses. */
export interface RemoteStatus {
  state?: JobState;
  runEndedAt?: string | null;
  lastAssistantText?: string | null;
  question?: { questions?: Question[] } | null;
  error?: string | null;
}

/** The job record updated from status.json, or undefined when nothing changed. */
export function mergeStatus(job: LocalJob, status: RemoteStatus): LocalJob | undefined {
  if (status.state === undefined) return undefined;
  const changed = status.state !== job.state || (status.runEndedAt ?? undefined) !== job.runEndedAt;
  if (!changed) return undefined;
  const updated: LocalJob = { ...job, state: status.state, updatedAt: new Date().toISOString() };
  if (status.runEndedAt) updated.runEndedAt = status.runEndedAt;
  if (status.lastAssistantText) updated.lastAssistantText = status.lastAssistantText;
  if (status.question?.questions) updated.questions = status.question.questions;
  else delete updated.questions;
  if (status.error) updated.error = status.error;
  else delete updated.error;
  return updated;
}

/** status.json of each job id given as an argument, `null` when absent. */
const READ_STATUS = `
out='{}'
for j in "$@"; do
  s=$(cat "${REMOTE_STATE}/$j/status.json" 2>/dev/null || echo null)
  out=$(jq -c --arg j "$j" --argjson s "$s" '. + {($j): $s}' <<<"$out")
done
${emitJson("$o", `--argjson o "$out"`)}
`;

const isActive = (job: LocalJob): boolean => ACTIVE_STATES.includes(job.state);

function oneLine(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One-line outcome, for `/handoff status` and the cmux notification. */
export function describeOutcome(job: LocalJob): { label: string; body: string } {
  const label = outcomeLabel(job.state);
  switch (job.state) {
    case "done":
      return { label, body: oneLine(job.lastAssistantText ?? "Finished.") };
    case "needs_input":
      return { label, body: oneLine(job.questions?.[0]?.question ?? "The agent has a question.") };
    case "error":
      return { label, body: oneLine(job.error ?? "The run failed.") };
    case "aborted":
      return { label, body: "The run was stopped." };
    default:
      return { label, body: "" };
  }
}

export class HandoffRuntime {
  readonly #pi: ExtensionAPI;
  #ctx: ExtensionContext | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  readonly #surface = process.env.CMUX_SURFACE_ID || undefined;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.#ctx = ctx;
    await this.poll({ all: true });
    // A failed tick must never reach the event loop as an unhandled rejection: that
    // takes the whole pi process down. The next tick tries again.
    this.#timer ??= setInterval(() => void this.poll({ all: false }).catch(() => {}), POLL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#ctx?.ui.setStatus(STATUS_KEY, undefined);
    this.#ctx = undefined;
  }

  #owns(job: LocalJob): boolean {
    return this.#surface !== undefined ? job.surface === this.#surface : job.ownerPid === process.pid;
  }

  /** Read status.json for active jobs (this window's, or all) and react to changes. */
  async poll({ all }: { all: boolean }): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const jobs = (await listJobs()).filter((j) => isActive(j) && (all || this.#owns(j)));
      const bySprite = new Map<string, LocalJob[]>();
      for (const job of jobs) bySprite.set(job.sprite, [...(bySprite.get(job.sprite) ?? []), job]);

      for (const [sprite, spriteJobs] of bySprite) {
        let statuses: Record<string, RemoteStatus | null>;
        try {
          statuses = await spriteJson(sprite, READ_STATUS, spriteJobs.map((j) => j.jobId), { timeoutMs: 60_000 });
        } catch {
          continue; // Offline or the Sprite is unreachable: try again next tick.
        }
        for (const job of spriteJobs) {
          const status = statuses[job.jobId];
          if (status !== null && status !== undefined) await this.apply(job, status);
        }
      }
      await this.refreshStatusLine();
    } finally {
      this.#ticking = false;
    }
  }

  /** Record a status read from the Sprite; a run that ended gets its card and notification. */
  async apply(job: LocalJob, status: RemoteStatus): Promise<void> {
    const updated = mergeStatus(job, status);
    if (updated === undefined) return;
    await writeJob(updated);
    if (!isActive(updated)) await this.#notify(updated);
  }

  async #notify(job: LocalJob): Promise<void> {
    if (!(await claimNotification(job))) return;
    const { label, body } = describeOutcome(job);
    // Into whichever conversation this window has open, even if it is not the
    // handed-off one: the card names its job, and the job browser lists them all.
    if (this.#ctx !== undefined) this.#pi.appendEntry(OUTCOME_ENTRY, buildOutcomeCard(job));
    if (job.surface !== undefined) {
      await cmuxNotify(job.surface, `pi-handoff: job ${job.jobId} ${label}`, `${conversationName(job)}: ${body}`);
    }
  }

  async refreshStatusLine(): Promise<void> {
    const ctx = this.#ctx;
    if (ctx === undefined) return;
    const jobs = await listJobs();
    const count = (filter: JobFilter): number => jobs.filter((job) => matchesFilter(job, filter)).length;
    const parts = STATUS_LINE_FILTERS.map((filter) => [count(filter), FILTER_LABELS[filter]] as const)
      .filter(([n]) => n > 0)
      .map(([n, label]) => `${n} ${label}`);
    ctx.ui.setStatus(STATUS_KEY, parts.length === 0 ? undefined : `☁ ${parts.join(" · ")}`);
  }
}
