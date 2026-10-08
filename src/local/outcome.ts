// What pi-handoff draws in the chat.
//
// - The outcome card: a job's result in the chat of the session it was handed off
//   from. A custom session entry: saved with the conversation and drawn by pi, but
//   never sent to the model. The agent's final message is Markdown, collapsed when long.
// - The return line: the return briefing appended to a pulled job's conversation. A
//   custom message, so the model reads it; drawn as one line, full text when expanded.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { conversationName, type JobState, type LocalJob } from "./jobs.ts";

export const OUTCOME_ENTRY = "pi-handoff-outcome";
export const RETURN_MESSAGE = "pi-handoff-return";

export interface ReturnDetails {
  jobId: string;
  jobBranch?: string;
  worktree?: string;
}

/** Lines of the message shown before it is cut, unless tool output is expanded. */
const COLLAPSED_LINES = 12;

export interface OutcomeCard {
  jobId: string;
  state: JobState;
  label: string;
  title: string;
  /** Markdown. */
  body: string;
  footer: string[];
  /** Never cut (Show full message in the job browser). */
  full?: boolean;
}

export function outcomeLabel(state: JobState): string {
  switch (state) {
    case "needs_input":
      return "needs input";
    case "error":
      return "failed";
    default:
      return state;
  }
}

/** The job's outcome as Markdown: final message, questions or error. */
export function outcomeBody(job: LocalJob): string {
  switch (job.state) {
    case "done":
      return job.lastAssistantText?.trim() || "Finished.";
    case "needs_input": {
      const questions = job.questions ?? [];
      if (questions.length === 0) return "The agent has a question.";
      return questions
        .map((q) => {
          const options = (q.options ?? []).map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ""}`);
          return [`**${q.question}**`, ...(options.length > 0 ? ["", ...options] : [])].join("\n");
        })
        .join("\n\n");
    }
    case "error":
      return `\`\`\`\n${job.error ?? "The run failed."}\n\`\`\``;
    case "aborted":
      return "The run was stopped.";
    default:
      return "";
  }
}

export function buildOutcomeCard(job: LocalJob, options: { full?: boolean } = {}): OutcomeCard {
  const footer: string[] = [];
  if (job.jobBranch !== undefined) footer.push(`Branch ${job.jobBranch} on origin.`);
  if (job.state === "done" || job.state === "needs_input" || job.state === "error" || job.state === "aborted") {
    footer.push(`Bring it back: /handoff pull ${job.jobId} --switch  (or /handoff status)`);
  }
  return {
    jobId: job.jobId,
    state: job.state,
    label: outcomeLabel(job.state),
    title: conversationName(job),
    body: outcomeBody(job),
    footer,
    ...(options.full ? { full: true } : {}),
  };
}

/** Shows the first `max` lines of a component, then a hint to expand. */
class Clipped implements Component {
  readonly #inner: Component;
  readonly #max: number;
  readonly #hint: string;

  constructor(inner: Component, max: number, hint: string) {
    this.#inner = inner;
    this.#max = max;
    this.#hint = hint;
  }

  render(width: number): string[] {
    const lines = this.#inner.render(width);
    if (lines.length <= this.#max) return lines;
    return [...lines.slice(0, this.#max), this.#hint];
  }

  invalidate(): void {
    this.#inner.invalidate();
  }
}

/** Same backgrounds as tool results (the bash box): green done, red failed, grey otherwise. */
const STATE_BG = { done: "toolSuccessBg", error: "toolErrorBg" } as const;

function renderCard(card: OutcomeCard, expanded: boolean, theme: Theme): Component {
  const bg = STATE_BG[card.state as keyof typeof STATE_BG] ?? "toolPendingBg";
  const box = new Box(1, 1, (text) => theme.bg(bg, text));
  box.addChild(
    new Text(`${theme.fg("toolTitle", theme.bold(`☁ Job ${card.jobId} ${card.label}`))}  ${theme.fg("muted", card.title)}`, 0, 0),
  );
  if (card.body !== "") {
    box.addChild(new Spacer(1));
    const body = new Markdown(card.body, 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("toolOutput", text) });
    const hint = theme.fg("dim", `… (${keyText("app.tools.expand")} to expand)`);
    box.addChild(expanded || card.full === true ? body : new Clipped(body, COLLAPSED_LINES, hint));
  }
  if (card.footer.length > 0) {
    box.addChild(new Spacer(1));
    for (const line of card.footer) box.addChild(new Text(theme.fg("dim", line), 0, 0));
  }
  return box;
}

export function registerOutcomeRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<OutcomeCard>(OUTCOME_ENTRY, (entry, { expanded }, theme) =>
    entry.data === undefined ? undefined : renderCard(entry.data, expanded, theme),
  );
  pi.registerMessageRenderer<ReturnDetails>(RETURN_MESSAGE, (message, { expanded }, theme) => {
    const d = message.details;
    const where = d?.worktree ?? (d?.jobBranch === undefined ? "conversation only" : `origin/${d.jobBranch}`);
    const line = `${theme.fg("accent", "☁ Back from the Sprite")}${theme.fg("muted", ` · job ${d?.jobId ?? "?"} · ${where}`)}`;
    if (!expanded) return new Text(line, 1, 0);
    const text = typeof message.content === "string" ? message.content : "";
    return new Text(`${line}\n${theme.fg("dim", text)}`, 1, 0);
  });
}
