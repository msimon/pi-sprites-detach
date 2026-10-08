// The job browser behind /handoff status: a full-screen view in the style of /tree
// and /model. Filters follow the job states (Tab / Shift+Tab, or Ctrl+letter to
// jump), a preview under the list follows the cursor, Enter picks the job.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  conversationName,
  FILTER_LABELS,
  JOB_FILTERS,
  type JobFilter,
  type JobState,
  type LocalJob,
  matchesFilter,
} from "./jobs.ts";
import { outcomeBody, outcomeLabel } from "./outcome.ts";

/**
 * Ctrl+<letter> jumps to a filter; the same key again goes back to all. Not Ctrl+J for
 * joined: that is the newline character, which pi's key matcher also reads as Enter.
 */
const FILTER_KEYS: Record<JobFilter, string> = {
  all: "a",
  running: "r",
  joined: "o",
  needs_input: "n",
  done: "d",
  failed: "f",
  aborted: "x",
  pulled: "p",
};

const LIST_ROWS = 10;
const PREVIEW_LINES = 8;
const BRANCH_MAX = 28;

/** Column widths for the rows on screen, so branches and ages line up. */
interface Columns {
  id: number;
  branch: number;
  age: number;
}

/** Jobs waiting on the user first, then running, then history; newest first within. */
const STATE_ORDER: Record<JobState, number> = {
  needs_input: 0,
  error: 1,
  done: 2,
  starting: 3,
  preparing: 3,
  running: 3,
  joined: 3,
  aborted: 4,
  pulled: 5,
};

const jobNumber = (job: LocalJob): number => Number(job.jobId.slice(1));

export function sortJobs(jobs: readonly LocalJob[]): LocalJob[] {
  return [...jobs].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || jobNumber(b) - jobNumber(a));
}

export function ago(iso: string | undefined, now: number): string {
  if (iso === undefined) return "";
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** When the job last changed, worded for its state. */
export function jobAge(job: LocalJob, now: number): string {
  switch (job.state) {
    case "starting":
    case "preparing":
    case "running":
      return `started ${ago(job.startedAt, now)}`;
    case "joined":
      return `joined ${ago(job.updatedAt, now)}`;
    case "pulled":
      return `pulled ${ago(job.updatedAt, now)}`;
    default:
      return ago(job.runEndedAt ?? job.updatedAt, now);
  }
}

/** What Enter offers for a job; only actions that are built. */
export type JobAction = "reply" | "join" | "show" | "pullHere" | "pullOpen" | "pull" | "abort" | "open" | "here";

export const ACTION_LABELS: Record<JobAction, string> = {
  reply: "Reply: answer or ask for more",
  join: "Join on the Sprite: work with it live",
  show: "Show full message",
  pullHere: "Pull, bring its context into this conversation",
  pullOpen: "Pull and open its conversation",
  pull: "Pull, stay in this conversation",
  abort: "Abort the run",
  open: "Open its conversation",
  here: "Bring its context into this conversation",
};

export function jobActions(job: LocalJob): JobAction[] {
  switch (job.state) {
    case "done":
    case "needs_input":
    case "error":
    case "aborted":
      return ["reply", "join", "show", "pullHere", "pullOpen", "pull"];
    case "starting":
    case "preparing":
    case "running":
      return ["abort"];
    case "joined":
      return ["join", "abort"];
    case "pulled":
      return job.pulledSessionFile === undefined ? [] : ["open", "here"];
  }
}

/** One plain line per job, for /handoff status without a UI. */
export function plainList(jobs: readonly LocalJob[], filter: JobFilter, now: number): string {
  const shown = sortJobs(jobs).filter((job) => matchesFilter(job, filter));
  if (shown.length === 0) return `☁ No handoff jobs (${FILTER_LABELS[filter]}).`;
  return [
    `☁ Handoff jobs (${FILTER_LABELS[filter]})`,
    ...shown.map((job) =>
      [job.jobId, outcomeLabel(job.state), conversationName(job), job.jobBranch ?? "", jobAge(job, now)]
        .filter(Boolean)
        .join("  "),
    ),
  ].join("\n");
}

export interface BrowserResult {
  jobId: string;
  filter: JobFilter;
}

export interface BrowserState {
  filter: JobFilter;
  selectedId?: string;
  /** Whether a refresh from the Sprite is still running. */
  refreshing: boolean;
}

export class JobBrowser implements Component {
  readonly #theme: Theme;
  readonly #done: (result: BrowserResult | undefined) => void;
  readonly #requestRender: () => void;
  #jobs: LocalJob[] = [];
  #filter: JobFilter;
  #selectedId: string | undefined;
  #refreshing: boolean;
  #cache: { width: number; lines: string[] } | undefined;

  constructor(
    theme: Theme,
    jobs: readonly LocalJob[],
    state: BrowserState,
    requestRender: () => void,
    done: (result: BrowserResult | undefined) => void,
  ) {
    this.#theme = theme;
    this.#requestRender = requestRender;
    this.#done = done;
    this.#filter = state.filter;
    this.#selectedId = state.selectedId;
    this.#refreshing = state.refreshing;
    this.setJobs(jobs, state.refreshing);
  }

  /** Replace the job list (after a refresh), keeping the selection when it is still shown. */
  setJobs(jobs: readonly LocalJob[], refreshing: boolean): void {
    this.#jobs = sortJobs(jobs);
    this.#refreshing = refreshing;
    this.#update();
  }

  #visible(): LocalJob[] {
    return this.#jobs.filter((job) => matchesFilter(job, this.#filter));
  }

  #index(visible: readonly LocalJob[]): number {
    const index = visible.findIndex((job) => job.jobId === this.#selectedId);
    return index === -1 ? 0 : index;
  }

  #update(): void {
    const visible = this.#visible();
    this.#selectedId = visible[this.#index(visible)]?.jobId;
    this.#cache = undefined;
    this.#requestRender();
  }

  #move(delta: number): void {
    const visible = this.#visible();
    if (visible.length === 0) return;
    const index = Math.min(visible.length - 1, Math.max(0, this.#index(visible) + delta));
    this.#selectedId = visible[index]?.jobId;
    this.#update();
  }

  #setFilter(filter: JobFilter): void {
    this.#filter = filter;
    this.#update();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) return this.#move(-1);
    if (matchesKey(data, Key.down)) return this.#move(1);
    if (matchesKey(data, Key.pageUp)) return this.#move(-LIST_ROWS);
    if (matchesKey(data, Key.pageDown)) return this.#move(LIST_ROWS);
    if (matchesKey(data, Key.shift("tab"))) {
      const at = JOB_FILTERS.indexOf(this.#filter);
      return this.#setFilter(JOB_FILTERS[(at - 1 + JOB_FILTERS.length) % JOB_FILTERS.length] ?? "all");
    }
    if (matchesKey(data, Key.tab)) {
      return this.#setFilter(JOB_FILTERS[(JOB_FILTERS.indexOf(this.#filter) + 1) % JOB_FILTERS.length] ?? "all");
    }
    for (const filter of JOB_FILTERS) {
      if (matchesKey(data, Key.ctrl(FILTER_KEYS[filter] as "a"))) {
        return this.#setFilter(this.#filter === filter ? "all" : filter);
      }
    }
    if (matchesKey(data, Key.enter)) {
      const job = this.#visible().find((j) => j.jobId === this.#selectedId);
      if (job !== undefined && jobActions(job).length > 0) this.#done({ jobId: job.jobId, filter: this.#filter });
      return;
    }
    if (matchesKey(data, Key.escape)) this.#done(undefined);
  }

  invalidate(): void {
    this.#cache = undefined;
  }

  render(width: number): string[] {
    if (this.#cache?.width === width) return this.#cache.lines;
    const lines = this.#render(Math.max(20, width));
    this.#cache = { width, lines };
    return lines;
  }

  #render(width: number): string[] {
    const t = this.#theme;
    const now = Date.now();
    const visible = this.#visible();
    const index = this.#index(visible);
    const selected = visible[index];
    const rule = t.fg("accent", "─".repeat(width));
    const lines: string[] = [rule];

    const title = t.fg("accent", t.bold(" Handoff jobs"));
    const status = this.#refreshing ? t.fg("dim", "refreshing from the Sprite…") : "";
    lines.push(this.#spread(title, status, width));

    const tabs = JOB_FILTERS.map((filter) => {
      const count = this.#jobs.filter((job) => matchesFilter(job, filter)).length;
      const text = `${FILTER_LABELS[filter]} ${count}`;
      if (filter === this.#filter) return t.fg("accent", t.bold(text));
      return count === 0 ? t.fg("dim", text) : t.fg("muted", text);
    }).join(t.fg("dim", " │ "));
    lines.push(...wrapTextWithAnsi(` ${tabs}`, width));
    lines.push("");

    if (visible.length === 0) {
      const empty = this.#jobs.length === 0 ? "No handoff jobs yet. Start one with /handoff [prompt]." : "No jobs here.";
      lines.push(t.fg("muted", ` ${empty}`));
    } else {
      const start = Math.min(Math.max(0, index - Math.floor(LIST_ROWS / 2)), Math.max(0, visible.length - LIST_ROWS));
      const rows = visible.slice(start, start + LIST_ROWS);
      const columns: Columns = {
        id: Math.max(...rows.map((job) => job.jobId.length)),
        branch: Math.min(BRANCH_MAX, Math.max(...rows.map((job) => (job.jobBranch ?? "").length))),
        age: Math.max(...rows.map((job) => jobAge(job, now).length)),
      };
      for (const job of rows) lines.push(this.#row(job, job === selected, width, now, columns));
      if (visible.length > LIST_ROWS) lines.push(t.fg("dim", ` (${index + 1}/${visible.length})`));
    }

    if (selected !== undefined) {
      lines.push("", t.fg("borderMuted", "─".repeat(width)));
      lines.push(...this.#preview(selected, width, now));
    }

    lines.push(t.fg("borderMuted", "─".repeat(width)));
    const enter = selected !== undefined && jobActions(selected).length > 0 ? "enter actions · " : "";
    const keys = JOB_FILTERS.map((f) => FILTER_KEYS[f]).join("/");
    lines.push(...wrapTextWithAnsi(t.fg("dim", ` ↑↓ move · ${enter}tab/shift+tab filter · ctrl+${keys} jump · esc close`), width));
    lines.push(rule);
    return lines;
  }

  /** Left and right text on one line, the right one pushed to the edge. */
  #spread(left: string, right: string, width: number): string {
    const gap = width - visibleWidth(left) - visibleWidth(right) - 1;
    return gap < 1 ? truncateToWidth(left, width) : `${left}${" ".repeat(gap)}${right}`;
  }

  #row(job: LocalJob, isSelected: boolean, width: number, now: number, columns: Columns): string {
    const t = this.#theme;
    const marker = isSelected ? t.fg("accent", " ▸ ") : "   ";
    const idText = job.jobId.padEnd(columns.id);
    const id = isSelected ? t.fg("accent", t.bold(idText)) : idText;
    const state = t.fg(stateColor(job.state), outcomeLabel(job.state).padEnd(11));
    const left = `${marker}${id}  ${state}  `;
    const age = jobAge(job, now).padStart(columns.age);
    const branch = truncateToWidth(job.jobBranch ?? "", columns.branch, "…", true);
    let right = columns.branch > 0 ? `  ${branch}  ${age} ` : `  ${age} `;
    let nameWidth = width - visibleWidth(left) - visibleWidth(right);
    if (nameWidth < 16) {
      right = `  ${age} `;
      nameWidth = width - visibleWidth(left) - visibleWidth(right);
    }
    const name = truncateToWidth(conversationName(job), Math.max(4, nameWidth), "…", true);
    return truncateToWidth(`${left}${isSelected ? t.fg("accent", name) : name}${t.fg("dim", right)}`, width);
  }

  #preview(job: LocalJob, width: number, now: number): string[] {
    const t = this.#theme;
    const header = `${job.jobId} · ${outcomeLabel(job.state)} · ${conversationName(job)}`;
    const facts = [
      job.jobBranch === undefined ? "no git: conversation only" : `branch ${job.jobBranch}`,
      `Sprite ${job.sprite}`,
      `started ${ago(job.startedAt, now)}`,
      ...(job.runEndedAt !== undefined ? [`finished ${ago(job.runEndedAt, now)}`] : []),
    ].join(" · ");
    const lines = [
      ...wrapTextWithAnsi(t.bold(` ${header}`), width),
      ...wrapTextWithAnsi(t.fg("dim", ` ${facts}`), width),
      "",
    ];

    const body = outcomeBody(job);
    if (body === "") {
      const note =
        job.state === "pulled"
          ? "Pulled back to the laptop."
          : "Still running. The result shows here and as a card in the chat when it finishes.";
      lines.push(t.fg("muted", ` ${note}`));
      return lines;
    }
    const rendered = new Markdown(body, 1, 0, getMarkdownTheme(), { color: (text) => t.fg("toolOutput", text) }).render(width);
    lines.push(...rendered.slice(0, PREVIEW_LINES));
    if (rendered.length > PREVIEW_LINES) lines.push(t.fg("dim", " … (enter → Show full message)"));
    return lines;
  }
}

function stateColor(state: JobState): "success" | "warning" | "error" | "accent" | "muted" {
  switch (state) {
    case "done":
      return "success";
    case "needs_input":
      return "warning";
    case "error":
      return "error";
    case "starting":
    case "preparing":
    case "running":
      return "accent";
    default:
      return "muted";
  }
}
