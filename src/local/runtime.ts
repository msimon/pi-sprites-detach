// Polling, notifications and the status line.
//
// Each window polls the active jobs it started every ~45 s (one small exec per
// Sprite; the Sprite is awake anyway while a run holds it). On session_start a
// window also checks every active job once, which reports jobs that finished while
// no pi was watching. Polling is wall-clock free: a tick after a laptop sleep just
// reads the current state, so a missed interval only delays the warning.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitJson, spriteJson } from "./exec.ts";
import { ACTIVE_STATES, claimNotification, type JobState, type LocalJob, listJobs, type Question, writeJob } from "./jobs.ts";
import { cmuxNotify } from "./notify.ts";
import { REMOTE_STATE } from "./paths.ts";

const POLL_MS = 45_000;
const STATUS_KEY = "handoff";
const BODY_MAX = 300;

interface RemoteStatus {
  state?: JobState;
  runEndedAt?: string | null;
  lastAssistantText?: string | null;
  question?: { questions?: Question[] } | null;
  error?: string | null;
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

export function describeOutcome(job: LocalJob): { label: string; body: string } {
  switch (job.state) {
    case "done":
      return { label: "done", body: oneLine(job.lastAssistantText ?? "Finished.") };
    case "needs_input":
      return { label: "needs input", body: oneLine(job.questions?.[0]?.question ?? "The agent has a question.") };
    case "error":
      return { label: "failed", body: oneLine(job.error ?? "The run failed.") };
    case "aborted":
      return { label: "aborted", body: "The run was stopped." };
    default:
      return { label: job.state, body: "" };
  }
}

export class HandoffRuntime {
  #ctx: ExtensionContext | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  readonly #surface = process.env.CMUX_SURFACE_ID || undefined;

  async start(ctx: ExtensionContext): Promise<void> {
    this.#ctx = ctx;
    await this.poll({ all: true });
    this.#timer ??= setInterval(() => void this.poll({ all: false }), POLL_MS);
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
          if (status !== null && status !== undefined) await this.#apply(job, status);
        }
      }
      await this.refreshStatusLine();
    } finally {
      this.#ticking = false;
    }
  }

  async #apply(job: LocalJob, status: RemoteStatus): Promise<void> {
    if (status.state === undefined) return;
    const changed = status.state !== job.state || (status.runEndedAt ?? undefined) !== job.runEndedAt;
    if (!changed) return;

    const updated: LocalJob = { ...job, state: status.state, updatedAt: new Date().toISOString() };
    if (status.runEndedAt) updated.runEndedAt = status.runEndedAt;
    if (status.lastAssistantText) updated.lastAssistantText = status.lastAssistantText;
    if (status.question?.questions) updated.questions = status.question.questions;
    else delete updated.questions;
    if (status.error) updated.error = status.error;
    else delete updated.error;
    await writeJob(updated);

    if (!isActive(updated)) await this.#notify(updated);
  }

  async #notify(job: LocalJob): Promise<void> {
    if (!(await claimNotification(job))) return;
    const { label, body } = describeOutcome(job);
    const where = job.jobBranch === undefined ? "" : `\nbranch ${job.jobBranch} on origin`;
    this.#ctx?.ui.notify(`☁ ${job.jobId} ${label}: ${job.jobName}\n${body}${where}`, "warning");
    if (job.surface !== undefined) await cmuxNotify(job.surface, `pi-handoff ${job.jobId} ${label}`, `${job.jobName}: ${body}`);
  }

  async refreshStatusLine(): Promise<void> {
    const ctx = this.#ctx;
    if (ctx === undefined) return;
    const jobs = await listJobs();
    const running = jobs.filter(isActive).length;
    const waiting = jobs.filter((j) => j.state === "needs_input").length;
    const parts = [running > 0 ? `${running} running` : "", waiting > 0 ? `${waiting} needs input` : ""].filter(Boolean);
    ctx.ui.setStatus(STATUS_KEY, parts.length === 0 ? undefined : `☁ ${parts.join(" · ")}`);
  }
}
