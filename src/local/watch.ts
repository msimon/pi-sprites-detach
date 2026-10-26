// /handoff watch: follow a job's run live, or replay its last one, in a read-only
// full-screen view. detach-watch on the Sprite prints pi's JSON events; this process
// reads them over `sprite exec` and a Transcript turns them into what is drawn. Closing
// the view kills the `sprite exec`, which ends the stream (and detach-watch with it).

import { type ChildProcess, spawn } from "node:child_process";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { spriteBin } from "./exec.ts";
import { ACTIVE_STATES, conversationName, isOffSprite, type LocalJob } from "./jobs.ts";
import { REMOTE_DETACH_HOME } from "./paths.ts";
import { renderTranscript, type Style, Transcript } from "./transcript.ts";

/** A job's events are on the Sprite until it is pulled or dropped; a joined pi is interactive, not streamed. */
export const canWatch = (job: LocalJob): boolean => !isOffSprite(job) && job.state !== "joined";

/** Whether the run is still going, so the view follows it instead of replaying it. */
export const isLive = (job: LocalJob): boolean => ACTIVE_STATES.includes(job.state);

export interface WatchStream {
  stop(): void;
}

/** Run detach-watch on the Sprite; each line of its output goes to `onLine`. */
export function startWatchStream(
  job: LocalJob,
  onLine: (line: string) => void,
  onClose: (result: { code: number | null; stderr: string; stopped: boolean }) => void,
): WatchStream {
  const child: ChildProcess = spawn(
    spriteBin(),
    ["exec", "-s", job.sprite, "--no-stdin", "--", `${REMOTE_DETACH_HOME}/bin/detach-watch`, job.jobId],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let buffer = "";
  let stderr = "";
  let stopped = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      onLine(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  child.on("error", (error) => onClose({ code: null, stderr: error.message, stopped }));
  child.on("close", (code) => {
    if (buffer !== "") onLine(buffer);
    onClose({ code, stderr: stderr.trim(), stopped });
  });
  return {
    stop(): void {
      stopped = true;
      child.kill("SIGTERM");
    },
  };
}

/** Rows used by the header and the footer; the rest shows the transcript. */
const HEADER_ROWS = 3;
const FOOTER_ROWS = 2;

export class WatchView implements Component {
  readonly #theme: Theme;
  readonly #job: LocalJob;
  readonly #rows: () => number;
  readonly #requestRender: () => void;
  readonly #done: () => void;
  readonly #transcript = new Transcript();
  readonly #style: Style;
  #thinking = false;
  #expand = false;
  #following = true;
  #top = 0;
  #cache: { width: number; version: number; key: string; lines: string[] } | undefined;
  #total = 0;
  #height = 10;

  constructor(theme: Theme, job: LocalJob, rows: () => number, requestRender: () => void, done: () => void) {
    this.#theme = theme;
    this.#job = job;
    this.#rows = rows;
    this.#requestRender = requestRender;
    this.#done = done;
    this.#style = {
      user: (text) => theme.fg("accent", text),
      assistant: (text) => text,
      thinking: (text) => theme.fg("dim", text),
      tool: (text) => theme.fg("toolTitle", text),
      output: (text) => theme.fg("toolOutput", text),
      error: (text) => theme.fg("error", text),
      dim: (text) => theme.fg("dim", text),
      accent: (text) => theme.fg("accent", text),
    };
  }

  feed(line: string): void {
    this.#transcript.feed(line);
    this.#requestRender();
  }

  /** The stream ended without detach-watch's own end line: say why, so the view is not left silent. */
  streamClosed({ code, stderr, stopped }: { code: number | null; stderr: string; stopped: boolean }): void {
    if (stopped || this.#transcript.phase === "ended") return;
    const detail = stderr === "" ? `exit code ${code ?? "?"}` : stderr.split("\n").slice(-2).join(" ");
    this.#transcript.note(`The stream from the Sprite closed (${detail}). Close this view and open it again to reconnect.`, true);
    this.#transcript.phase = "ended";
    this.#requestRender();
  }

  invalidate(): void {
    this.#cache = undefined;
  }

  handleInput(data: string): void {
    const page = Math.max(1, this.#height - 2);
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return this.#done();
    if (matchesKey(data, Key.up)) return this.#scroll(-1);
    if (matchesKey(data, Key.down)) return this.#scroll(1);
    if (matchesKey(data, Key.pageUp)) return this.#scroll(-page);
    if (matchesKey(data, Key.pageDown)) return this.#scroll(page);
    if (matchesKey(data, Key.end) || data === "G") {
      this.#following = true;
      return this.#requestRender();
    }
    if (matchesKey(data, Key.home) || data === "g") {
      this.#following = false;
      this.#top = 0;
      return this.#requestRender();
    }
    if (data === "t") {
      this.#thinking = !this.#thinking;
      return this.#requestRender();
    }
    if (data === "e") {
      this.#expand = !this.#expand;
      return this.#requestRender();
    }
  }

  #status(): string {
    const t = this.#theme;
    const { phase, endState } = this.#transcript;
    if (phase === "ended") return t.fg("muted", endState ? `ended: ${endState}` : "ended");
    if (phase === "waiting") return t.fg("warning", "waiting for the run to start");
    return t.fg("success", isLive(this.#job) ? "live" : "replay");
  }

  #scroll(delta: number): void {
    const bottom = Math.max(0, this.#total - this.#height);
    const from = this.#following ? bottom : this.#top;
    const next = Math.min(bottom, Math.max(0, from + delta));
    this.#following = next >= bottom;
    this.#top = next;
    this.#requestRender();
  }

  render(width: number): string[] {
    const w = Math.max(30, width);
    const t = this.#theme;
    const key = `${this.#thinking}${this.#expand}`;
    if (this.#cache?.width !== w || this.#cache.version !== this.#transcript.version || this.#cache.key !== key) {
      this.#cache = {
        width: w,
        version: this.#transcript.version,
        key,
        lines: renderTranscript(this.#transcript, { width: w - 1, thinking: this.#thinking, expand: this.#expand }, this.#style),
      };
    }
    const body = this.#cache.lines;
    this.#total = body.length;
    this.#height = Math.max(5, this.#rows() - HEADER_ROWS - FOOTER_ROWS);
    const bottom = Math.max(0, body.length - this.#height);
    if (this.#following) this.#top = bottom;
    else this.#top = Math.min(this.#top, bottom);
    const shown = body.slice(this.#top, this.#top + this.#height);
    while (shown.length < this.#height) shown.push("");

    const status = this.#status();
    const title = ` ${t.fg("accent", t.bold(`Watch ${this.#job.jobId}`))} ${t.fg("muted", conversationName(this.#job))}`;
    // Not the job's state: this record is as old as the last poll; the stream knows better.
    const where = this.#job.jobBranch === undefined ? "" : `branch ${this.#job.jobBranch}`;
    const rule = t.fg("accent", "─".repeat(w));
    const position = this.#following ? "following" : `line ${this.#top + 1}/${body.length}, End to follow`;
    const keys = `↑↓ PgUp PgDn · t thinking ${this.#thinking ? "on" : "off"} · e output ${this.#expand ? "full" : "folded"} · Esc close`;
    return [
      rule,
      truncateToWidth(`${title}  ${status}`, w),
      truncateToWidth(` ${t.fg("dim", where)}`, w),
      ...shown.map((line) => truncateToWidth(` ${line}`, w)),
      rule,
      truncateToWidth(` ${t.fg("dim", `${position} · ${keys}`)}`, w),
    ];
  }
}
