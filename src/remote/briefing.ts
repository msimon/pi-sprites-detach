// The remote briefing: a system prompt section on every run on the Sprite. It tells
// the model where it is, that nobody is watching, and the rules of the job.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RemoteJob } from "./job.ts";

/** Lockfile → install command, first match wins. */
const INSTALLERS: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm install"],
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["yarn.lock", "yarn install"],
  ["package-lock.json", "npm install"],
  ["uv.lock", "uv sync"],
];

/** Install command for the folder, looking in the folder first, then the repo root. */
export function detectInstallCommand(job: RemoteJob): string | undefined {
  for (const dir of [job.folder, job.mountAt]) {
    for (const [lockfile, command] of INSTALLERS) {
      if (existsSync(join(dir, lockfile))) {
        return dir === job.folder ? command : `${command} (in ${dir})`;
      }
    }
  }
  return undefined;
}

export function buildBriefing(job: RemoteJob, installCommand: string | undefined): string {
  const lines: string[] = [];
  const n = (text: string): void => {
    lines.push(`${lines.length + 1}. ${text}`);
  };

  n(
    `Situation: you are running unattended on a cloud machine (a Fly.io Sprite, Linux) as handoff job ${job.jobId} ("${job.jobName}"), split from the user's laptop session ${job.mainSessionId}. The user handed this conversation off because they are away. Earlier messages in this conversation happened on their Mac; from here on, every tool runs on this Linux machine.`,
  );
  n(
    "No live user and no UI: dialogs do not work and nobody reads your messages until the run ends. Make reasonable decisions yourself and list the assumptions you made in your final message. If you are truly blocked and need the user to decide, call the ask_user_question tool: it ends this run and delivers the question to the user, and their answer arrives as the next message. Never ask a question in plain text and stop: that question is not delivered as one.",
  );
  if (job.protocol === "git") {
    n(
      `Files: ${job.mountAt} is a fresh checkout of branch ${job.jobBranch}, made from the user's working tree (uncommitted work included as a snapshot commit). Paths from earlier in the conversation still work. Git-ignored files other than the copied ones (such as .env files) and anything outside this repository are not here.`,
    );
  } else {
    n(
      `Files: ${job.folder} is an empty folder here; the user's local files are not available. Files you create are not brought back to the laptop, so put results in your messages.`,
    );
  }
  n(
    "Not available here: macOS-only tools and apps, the macOS Keychain (so skills that read credentials from it, such as Gmail, Google Workspace, Google Calendar and Notion, will fail), cmux, and the user's browser profiles. Do not try them; say what you would have done instead.",
  );
  if (job.protocol === "git") {
    const pr =
      job.pr === "never"
        ? "Do not open a pull request."
        : `When the task is complete and pushed, open a pull request with \`gh pr create --base ${job.baseBranch} --fill\` (or update the existing one), and put its URL in your final message.`;
    n(
      `Git: work only on branch ${job.jobBranch}. Commit as you go with clear messages and push with \`git push origin ${job.jobBranch}\`, so the work is safe even if this machine stops. ${pr} Never touch other branches and never force-push.`,
    );
  }
  n(
    installCommand === undefined
      ? "Dependencies: none are installed. If the project needs any, install them before running tests or builds."
      : `Dependencies: not installed yet. Run \`${installCommand}\` before running tests or builds.`,
  );
  n("Credentials: a GitHub token (git and gh) and web search are available. No other credentials are.");
  n(
    "End of run: finish with a short summary of what you did, what is left, and any assumptions. It becomes the notification the user reads first.",
  );

  return lines.join("\n");
}
