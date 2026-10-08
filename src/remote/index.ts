// pi-handoff remote extension, loaded only on the Sprite by handoff-run
// (`pi -e ~/.pi-handoff/sprite/extension/index.ts`). Does nothing outside a handoff run.
//
// - adds the remote briefing to the system prompt on every run
// - records the final assistant text for the notification
//
// Asking the user is not built in: a user extension provides ask_user_question
// (see examples/remote-ask.ts and `remote.replace` in the config).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildBriefing, detectInstallCommand } from "./briefing.ts";
import type { RemoteJob } from "./job.ts";

const RESULT_MAX_CHARS = 4000;

export default function handoffRemote(pi: ExtensionAPI): void {
  const jobDir = process.env.HANDOFF_DIR;
  if (process.env.HANDOFF_JOB_ID === undefined || jobDir === undefined) return;

  let job: RemoteJob;
  try {
    job = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as RemoteJob;
  } catch (error: unknown) {
    // Lands in runner.log. Without the job there is no briefing to give, so do nothing.
    process.stderr.write(`[pi-handoff] cannot read ${jobDir}/job.json: ${String(error)}\n`);
    return;
  }

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.handoff_briefing = buildBriefing(job, detectInstallCommand(job));
  });

  // The end of the turn. handoff-run reads this, and if its runner died before pi
  // exited, it is all there is to tell how the turn ended: hence `error`.
  pi.on("agent_end", (event) => {
    const text = lastAssistantText(event.messages);
    const error = turnError(event.messages);
    const result = { text: text.slice(0, RESULT_MAX_CHARS), ...(error !== undefined ? { error } : {}) };
    writeFileSync(join(jobDir, "result.json"), `${JSON.stringify(result)}\n`);
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
