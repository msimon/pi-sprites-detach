// The job description the laptop writes to ~/.handoff/<jobId>/job.json on the Sprite.
// Shared by the local extension (writes it), handoff-run (reads it with jq) and the
// remote extension (builds the briefing from it). Lives under src/remote because the
// remote extension is copied to the Sprite on its own and must not import from src/local.

export interface RemoteJob {
  jobId: string;
  /** Session name, also used in notifications. */
  jobName: string;
  /** Id of the laptop session the job split from. */
  mainSessionId: string;
  protocol: "git" | "none";
  /** Laptop folder the job works in. pi runs with this cwd, at the same path. */
  folder: string;
  /** Laptop path the checkout is mounted at: the repo root (git) or the folder (none). */
  mountAt: string;
  /** The job's checkout on the Sprite, shown at mountAt inside the job's namespace. */
  checkout: string;
  /** Git protocol only. */
  cloneUrl?: string;
  /** `<owner>/<repo>`: the cached clone lives at ~/repos/<repoKey>. */
  repoKey?: string;
  jobBranch?: string;
  /** Branch the job split from, the PR base. */
  baseBranch?: string;
  pr?: "auto" | "never";
}
