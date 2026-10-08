// The job's conversation: a copy of the main session's active branch, like /clone.
// pi's own createBranchedSession builds it (labels and compactions handled), with a
// new session id and parentSession pointing at the main session file.

import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export interface JobSession {
  file: string;
  sessionId: string;
}

export function cloneForJob(mainSessionFile: string, leafId: string, name: string, outDir: string): JobSession {
  const manager = SessionManager.open(mainSessionFile, outDir);
  const file = manager.createBranchedSession(leafId);
  if (file === undefined) throw new Error("could not copy the session");
  manager.appendSessionInfo(name);
  return { file, sessionId: manager.getSessionId() };
}

/** Stop reasons of an assistant message that ended normally (not mid-turn tool use). */
const COMPLETED = new Set(["stop", "length"]);

/**
 * The last assistant message on the branch that ended its turn normally, as /split
 * finds it. A tool runs in the middle of a turn, so its handoff forks here and leaves
 * out the turn in progress.
 */
export function lastCompletedLeaf(branch: readonly SessionEntry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message") continue;
    const message = entry.message as { role?: string; stopReason?: string };
    if (message.role === "assistant" && message.stopReason !== undefined && COMPLETED.has(message.stopReason)) {
      return entry.id;
    }
  }
  return undefined;
}
