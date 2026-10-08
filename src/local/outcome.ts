// A job's outcome, shown in the chat of the session it was handed off from. It is a
// custom session entry: saved with the conversation and drawn by pi, but never sent
// to the model. The agent's final message is drawn as Markdown, collapsed when long.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { conversationName, type JobState, type LocalJob } from "./jobs.ts";

export const OUTCOME_ENTRY = "pi-handoff-outcome";

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

function outcomeBody(job: LocalJob): string {
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

export function buildOutcomeCard(job: LocalJob): OutcomeCard {
  const footer: string[] = [];
  if (job.jobBranch !== undefined) footer.push(`Branch ${job.jobBranch} on origin.`);
  return {
    jobId: job.jobId,
    state: job.state,
    label: outcomeLabel(job.state),
    title: conversationName(job),
    body: outcomeBody(job),
    footer,
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
    box.addChild(expanded ? body : new Clipped(body, COLLAPSED_LINES, hint));
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
}
