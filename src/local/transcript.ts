// /handoff watch: pi's JSON event stream of a job's run, turned into a transcript.
//
// The Sprite streams events.jsonl (docs: json.md): message and tool events, plus the
// watch_wait and watch_end records detach-watch adds. `Transcript` folds them into
// blocks (prompt, assistant text, thinking, tool calls with their output, notes);
// `renderTranscript` draws the blocks as lines for a given width. Colours come from a
// Style, so tests render plain text.

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type Block =
  | { kind: "run"; cwd: string }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; args: string; output: string; running: boolean; isError: boolean; ms?: number }
  | { kind: "note"; text: string; error: boolean };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The text of a message's content: a string, or the text blocks of an array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Json => isObject(part) && part.type === "text")
    .map((part) => str(part.text))
    .join("\n");
}

/** What a tool call is about, on one line: the command, the path, or the arguments. */
export function summarizeArgs(name: string, args: unknown): string {
  const a = isObject(args) ? args : {};
  const pick = name === "bash" ? str(a.command) : str(a.path) || str(a.file_path) || str(a.pattern);
  const text = pick !== "" ? pick : JSON.stringify(args ?? {});
  const first = (text.split("\n")[0] ?? "").trim();
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

// Escape sequences and carriage returns in tool output would break the layout.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const clean = (text: string): string => text.replace(ANSI, "").replace(/\r/g, "").replace(/\t/g, "  ");

export class Transcript {
  readonly blocks: Block[] = [];
  /** `waiting`: the run has not started pi yet. `ended`: detach-watch said the run is over. */
  phase: "waiting" | "live" | "ended" = "live";
  endState: string | undefined;
  /** Bumped on every change, so a view knows to draw again. */
  version = 0;
  #open = new Map<number, Extract<Block, { kind: "assistant" | "thinking" }>>();

  /** One line of the stream. Anything that is not a JSON object (a keep-alive, noise) is ignored. */
  feed(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (isObject(event)) this.#event(event);
  }

  note(text: string, error = false): void {
    this.blocks.push({ kind: "note", text, error });
    this.version++;
  }

  #tool(id: string): (Block & { kind: "tool" }) | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      if (block?.kind === "tool" && block.id === id) return block;
    }
    return undefined;
  }

  #event(event: Json): void {
    this.version++;
    switch (event.type) {
      case "watch_wait":
        this.phase = "waiting";
        return;
      case "watch_end":
        this.phase = "ended";
        this.endState = str(event.state);
        return;
      case "watch_error":
        this.note(str(event.message) || "watch failed", true);
        this.phase = "ended";
        return;
      case "session":
        this.phase = "live";
        this.blocks.push({ kind: "run", cwd: str(event.cwd) });
        return;
      case "message_start": {
        const message = isObject(event.message) ? event.message : {};
        if (message.role === "assistant") this.#open.clear();
        return;
      }
      case "message_end": {
        const message = isObject(event.message) ? event.message : {};
        if (message.role === "user") {
          this.blocks.push({ kind: "user", text: textOf(message.content) });
        } else if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
          this.note(str(message.errorMessage) || `the turn ended with ${str(message.stopReason)}`, true);
        }
        return;
      }
      case "message_update":
        this.#update(isObject(event.assistantMessageEvent) ? event.assistantMessageEvent : {});
        return;
      case "tool_execution_start": {
        const name = str(event.toolName);
        this.blocks.push({
          kind: "tool",
          id: str(event.toolCallId),
          name,
          args: summarizeArgs(name, event.args),
          output: "",
          running: true,
          isError: false,
        });
        return;
      }
      case "tool_execution_update": {
        const tool = this.#tool(str(event.toolCallId));
        if (tool !== undefined && isObject(event.partialResult)) tool.output = textOf(event.partialResult.content);
        return;
      }
      case "tool_execution_end": {
        const tool = this.#tool(str(event.toolCallId));
        if (tool === undefined) return;
        tool.running = false;
        tool.isError = event.isError === true;
        if (isObject(event.result)) tool.output = textOf(event.result.content);
        if (typeof event.durationMs === "number") tool.ms = event.durationMs;
        return;
      }
      default:
        return;
    }
  }

  /** The streaming deltas of the assistant message in progress. */
  #update(update: Json): void {
    // toolcall_* is shown by the tool events; the provider's own start and done are not content.
    const match = /^(text|thinking)_(start|delta|end)$/.exec(str(update.type));
    if (match === null) return;
    const kind = match[1] === "thinking" ? "thinking" : "assistant";
    const step = match[2];
    const index = typeof update.contentIndex === "number" ? update.contentIndex : -1;
    let block = this.#open.get(index);
    if (block === undefined) {
      if (step === "end" && str(update.content) === "") return;
      const fresh: Extract<Block, { kind: "assistant" | "thinking" }> =
        kind === "thinking" ? { kind: "thinking", text: "" } : { kind: "assistant", text: "" };
      this.#open.set(index, fresh);
      this.blocks.push(fresh);
      block = fresh;
    }
    if (step === "delta") block.text += str(update.delta);
    else if (step === "end") block.text = str(update.content);
  }
}

export interface Style {
  user: (text: string) => string;
  assistant: (text: string) => string;
  thinking: (text: string) => string;
  tool: (text: string) => string;
  output: (text: string) => string;
  error: (text: string) => string;
  dim: (text: string) => string;
  accent: (text: string) => string;
}

const identity = (text: string): string => text;
export const PLAIN: Style = {
  user: identity,
  assistant: identity,
  thinking: identity,
  tool: identity,
  output: identity,
  error: identity,
  dim: identity,
  accent: identity,
};

export interface RenderOptions {
  width: number;
  /** Show thinking text; otherwise one marker line per block. */
  thinking: boolean;
  /** Show the whole output of tool calls and prompts, not their first lines. */
  expand: boolean;
}

/** Lines of a tool's output, or of a prompt, shown before the rest is folded. */
const FOLDED_LINES = 3;
const PROMPT_FOLDED_LINES = 6;

/** Wrap text to the width, with a prefix on its first line and spaces on the others. */
function wrap(text: string, width: number, first: string, rest: string): string[] {
  const out: string[] = [];
  const room = Math.max(10, width - first.length);
  for (const [i, paragraph] of text.split("\n").entries()) {
    const wrapped = wrapTextWithAnsi(paragraph === "" ? " " : paragraph, room);
    for (const [j, line] of wrapped.entries()) out.push(`${i === 0 && j === 0 ? first : rest}${line}`);
  }
  return out;
}

function folded(lines: string[], limit: number, expand: boolean, style: Style, indent: string): string[] {
  if (expand || lines.length <= limit) return lines;
  return [...lines.slice(0, limit), style.dim(`${indent}… ${lines.length - limit} more lines (e to show all)`)];
}

export function renderTranscript(transcript: Transcript, options: RenderOptions, style: Style = PLAIN): string[] {
  const { width, thinking, expand } = options;
  const lines: string[] = [];
  const gap = (): void => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  };

  for (const block of transcript.blocks) {
    switch (block.kind) {
      case "run":
        gap();
        lines.push(style.accent(`── run started${block.cwd === "" ? "" : ` in ${block.cwd}`} ──`));
        break;
      case "user": {
        gap();
        const body = wrap(clean(block.text).trim(), width, "› ", "  ").map((line) => style.user(line));
        lines.push(...folded(body, PROMPT_FOLDED_LINES, expand, style, "  "));
        break;
      }
      case "assistant":
        gap();
        lines.push(...wrap(clean(block.text).trim(), width, "", "").map((line) => style.assistant(line)));
        break;
      case "thinking": {
        gap();
        const text = clean(block.text).trim();
        if (!thinking) lines.push(style.dim(`✻ thinking (${text.length} characters; t to show)`));
        else lines.push(...wrap(text, width, "✻ ", "  ").map((line) => style.thinking(line)));
        break;
      }
      case "tool": {
        const mark = block.running ? "…" : block.isError ? "✗" : "✓";
        const took = block.ms === undefined ? "" : ` ${block.ms < 1000 ? `${block.ms} ms` : `${(block.ms / 1000).toFixed(1)} s`}`;
        const head = `${mark} ${block.name}  ${block.args}${took === "" ? "" : `  (${took.trim()})`}`;
        lines.push(block.isError ? style.error(head) : style.tool(head));
        const output = clean(block.output).replace(/\n+$/, "");
        if (output !== "") {
          const body = wrap(output, width, "    ", "    ").map((line) => style.output(line));
          lines.push(...folded(body, FOLDED_LINES, expand, style, "    "));
        }
        break;
      }
      case "note":
        gap();
        lines.push(...wrap(block.text, width, "! ", "  ").map((line) => (block.error ? style.error(line) : style.dim(line))));
        break;
    }
  }

  if (transcript.phase === "waiting") {
    gap();
    lines.push(style.dim("Waiting for the run to start…"));
  } else if (transcript.phase === "ended") {
    gap();
    lines.push(style.accent(`── ended${transcript.endState ? `: ${transcript.endState}` : ""} ──`));
  }
  return lines;
}
