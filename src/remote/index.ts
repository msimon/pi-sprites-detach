// pi-handoff remote extension, loaded only on the Sprite by handoff-run
// (`pi -e ~/.pi-handoff/extension/index.ts`). Does nothing outside a handoff run.
//
// - adds the remote briefing to the system prompt on every run
// - provides a headless ask_user_question that ends the run
// - records the final assistant text for the notification

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAskTool } from "./ask.ts";
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

  pi.registerTool(createAskTool(jobDir));

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.handoff_briefing = buildBriefing(job, detectInstallCommand(job));
  });

  pi.on("agent_end", (event) => {
    const text = lastAssistantText(event.messages);
    writeFileSync(join(jobDir, "result.json"), `${JSON.stringify({ text: text.slice(0, RESULT_MAX_CHARS) })}\n`);
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
