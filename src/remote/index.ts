// pi-sprites-detach remote extension, loaded only on the Sprite by detach-run
// (`pi -e ~/.pi-sprites-detach/sprite/extension/index.ts`). Does nothing outside a detach run.
//
// - adds the remote briefing to the system prompt on every run
// - records the final assistant text for the notification
// - in a joined pi (/attach, DETACH_JOINED): the briefing says the user is
//   present, and pi quits once idle with nobody attached to its tmux session
//
// Asking the user is not built in: a user extension provides ask_user_question
// (see examples/remote-ask.ts and `remote.replace` in the config).

import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildBriefing, detectInstallCommand } from "./briefing.ts";
import { CHECK_MS, countClients, IdleRule } from "./idle.ts";
import type { RemoteJob } from "./job.ts";

const RESULT_MAX_CHARS = 4000;

export default function detachRemote(pi: ExtensionAPI): void {
  const jobDir = process.env.DETACH_DIR;
  if (process.env.DETACH_JOB_ID === undefined || jobDir === undefined) return;
  const joined = process.env.DETACH_JOINED === "1";

  let job: RemoteJob;
  try {
    job = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as RemoteJob;
  } catch (error: unknown) {
    // Lands in runner.log. Without the job there is no briefing to give, so do nothing.
    process.stderr.write(`[pi-sprites-detach] cannot read ${jobDir}/job.json: ${String(error)}\n`);
    return;
  }

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.detach_briefing = buildBriefing(job, detectInstallCommand(job), { joined });
  });

  // The end of the turn. detach-run reads this, and if its runner died before pi
  // exited, it is all there is to tell how the turn ended: hence `error`.
  pi.on("agent_end", (event) => {
    const text = lastAssistantText(event.messages);
    const error = turnError(event.messages);
    const result = { text: text.slice(0, RESULT_MAX_CHARS), ...(error !== undefined ? { error } : {}) };
    writeFileSync(join(jobDir, "result.json"), `${JSON.stringify(result)}\n`);
  });

  const tmuxSession = process.env.DETACH_TMUX;
  if (joined && tmuxSession !== undefined) watchIdle(pi, jobDir, tmuxSession);
}

/**
 * Quit a joined pi once it is idle and nobody is attached (IdleRule). A new turn
 * also means a question asked earlier was answered here, so its question.json goes:
 * only a question left unanswered when pi quits makes the job `needs_input`.
 */
function watchIdle(pi: ExtensionAPI, jobDir: string, tmuxSession: string): void {
  const started = Date.now();
  const rule = new IdleRule();
  let busy = false;
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  pi.on("session_start", (_event, eventCtx) => {
    ctx = eventCtx;
    timer ??= setInterval(() => {
      void attachedClients(tmuxSession).then((clients) => {
        if (ctx !== undefined && rule.check({ busy, clients, sinceStart: Date.now() - started })) {
          clearInterval(timer);
          ctx.shutdown();
        }
      });
    }, CHECK_MS);
  });
  pi.on("agent_start", () => {
    busy = true;
    rmSync(join(jobDir, "question.json"), { force: true });
  });
  pi.on("agent_end", () => {
    busy = false;
  });
  pi.on("session_shutdown", () => {
    if (timer !== undefined) clearInterval(timer);
  });
}

/** Clients attached to the tmux session, or undefined when tmux cannot be asked. */
function attachedClients(session: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("tmux", ["list-clients", "-t", `=${session}`], { timeout: 4_000 }, (error, stdout) => {
      resolve(error === null ? countClients(stdout) : undefined);
    });
  });
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

/** Why the turn ended early, if its last assistant message ended in an error or an abort. */
function turnError(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
    if (message.role !== "assistant") continue;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
    return message.errorMessage ?? `the turn ended with ${message.stopReason}`;
  }
  return undefined;
}
