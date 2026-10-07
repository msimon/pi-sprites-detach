// The job's conversation: a copy of the main session's active branch, like /clone.
// pi's own createBranchedSession builds it (labels and compactions handled), with a
// new session id and parentSession pointing at the main session file.

import { SessionManager } from "@earendil-works/pi-coding-agent";

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
