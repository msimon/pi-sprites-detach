# pi-handoff — plan

Status: draft for review. Nothing is built yet.

## Goal

Hand a pi conversation off from the laptop to a cloud machine (a Fly.io Sprite) when Marc has to leave, let the agent keep working there unattended, get told in the original pi window when it finishes or needs input, then pull the work and the conversation back.

The motivating case: mid-task, Marc has to pick up his kid, closes the laptop, and the agent stops. With pi-handoff he runs `/handoff`, closes the laptop, and the work continues.

## Non-goals (v1)

- Moving the agent mid-run. Handoff happens between runs: pi must be idle (or the current run aborted) first.
- Merging conversations or code. A handoff splits off a job; the main session and the original working tree are never modified by it.
- Remote-only tools. Keychain-backed skills (Gmail, Google Workspace, gcalcli, `ntn`) will not work on the Sprite. Accepted.
- Live streaming of the remote run. That is v2 (`/handoff watch`), but v1 writes the event log it needs.
- One Sprite per job. One shared Sprite runs several jobs; the Sprite is a per-job setting so this can change later without touching anything else.
- Uploading extra secrets. Only the model auth and a GitHub token go on the Sprite. Anything else is deferred.

## Settled decisions

1. **Target**: one shared Sprite (default name `pi-handoff`), several concurrent jobs on it.
2. **The conversation splits like `/clone`.** A job runs on a copy of the session's active branch with its own session id and a name. The main session continues locally, untouched. On pull, the job's conversation becomes its own local session file with `parentSession` pointing at the main session; it is opened from `/resume`, or immediately with `/handoff pull --switch`.
3. **The workspace protocol depends on the folder.** A git work tree uses the git protocol below. A non-git folder is still an open question (see Workspace protocols).
4. **Each job has its own checkout** on the Sprite, under `<jobRoot>` (`~/jobs/<jobId>/`), so several jobs can come from the same folder. Paths from the conversation history are handled by a per-job mount namespace that shows the job's checkout at the original `/Users/marc/...` path, if spike S9 confirms the Sprite allows it. Otherwise the remote briefing states the path rule and a `tool_call` hook rewrites old paths (see Briefings).
5. **The remote pi runs headless**, one run at a time per job: `pi -p --mode json --session <file> "<prompt>"`. Runs are sequential within a job and parallel across jobs.
6. **The Sprite is held awake only while pi works**, via the Sprites Tasks API (5 min expiry, refreshed every 60 s, released on exit). When the run ends the Sprite pauses and stops billing compute.
7. **Notifications land in the window that started the handoff**: a pi warning (`ctx.ui.notify`) plus `cmux notify` targeted at that pane (`CMUX_SURFACE_ID`).
8. **Pull refuses while a run is in progress.** `--abort` stops the run first; it is never implicit.
9. **Pull cleans up the Sprite**: session file, `.env*`, `.scratch/`, transfer files and the job's state dir are deleted. The checkout and `node_modules` stay warm.
10. **Repo**: `msimon/pi-handoff`, private, topics `ops` + `perso`, TypeScript like `pi-reminders`.

## Workspace protocols

### Git protocol

Applies when the folder is inside a git work tree with an `origin` remote.

1. **One branch per job.** The job gets its own branch, `<current-branch>-handoff-<n>`, created from `HEAD`. The original branch and working tree stay free for local work.
2. **Uncommitted work travels as a snapshot commit on the job branch.** Tracked changes and untracked, non-ignored files are committed with a temporary index (`GIT_INDEX_FILE=… git add -A`, `git write-tree`, `git commit-tree`), so the local working tree and index are not touched. Because the branch is new, the snapshot commit does not pollute the original branch.
3. **Ignored-but-wanted files never get committed.** An allowlist (default `.env*`, `.scratch/`, configurable) travels as a tarball over `sprite exec`.
4. **On the Sprite**, the job branch is checked out in the job's own checkout under `<jobRoot>` (a clone of `origin`, or a worktree of a cached clone so repeated jobs stay fast). The agent commits on it, pushes it and opens a PR when the work is ready (configurable: `pr: auto | never`). It is a normal branch, not a temporary one.
5. **On pull**, any uncommitted remote changes get a final snapshot commit and are pushed. Locally the job branch is fetched; `--worktree` also creates a local worktree for it. Combining it with local work is ordinary git, if and when Marc chooses.

### Non-git folders (open)

Code transfer has no safe merge story here, but the conversation can still continue (research, planning, writing). Proposed default: conversation-only. The job runs in an empty job folder and the briefing tells it the local files are not available. Open: whether to also offer a tarball of small folders up, with remote files brought back into a separate `<path>.handoff-<job>/` folder on pull, never in place.

## Components

```
pi-handoff/
  src/local/      pi extension loaded on the laptop: /handoff commands, status line, polling, notifications
  src/remote/     pi extension loaded only on the Sprite: briefing, tool filtering, path rewrite, headless ask_user_question override, final status
  bin/handoff-run runner on the Sprite: Tasks API hold, launches pi, writes status
  setup/          one-time Sprite bootstrap script
  docs/plan.md    this file
```

## State

Local, one record per job at `~/.pi-handoff/jobs/<jobId>.json`:

```json
{
  "jobId": "h3",
  "sprite": "pi-handoff",
  "protocol": "git | none",
  "folder": "/Users/marc/hatch/…/mvp",
  "mainSessionFile": "/Users/marc/.pi/agent/sessions/…/….jsonl",
  "forkLeafId": "<entry id the job split from>",
  "jobSessionId": "<uuid>",
  "jobBranch": "feat/x-handoff-1",
  "jobRoot": "/home/sprite/jobs/h3",
  "baseHead": "<sha>",
  "surface": "<CMUX_SURFACE_ID>",
  "state": "running | done | needs_input | error | aborted | pulled",
  "startedAt": "…"
}
```

Remote, per job at `~/.handoff/<jobId>/`:

- `status.json`: `{ jobId, state, runStartedAt, runEndedAt, exitCode, lastAssistantText (truncated), question? }`
- `events.jsonl`: pi's JSON event stream, appended per run (feeds v2 `watch`).
- `runner.pid`, `runner.log`.

## Flows

### Push: `/handoff [prompt]`

1. Wait for idle.
2. Detect the protocol and prepare the workspace (git protocol steps 1–4, or conversation-only).
3. Create the job session: a copy of the active branch with a new session id, `parentSession` set to the main session file, and a job name. Record `forkLeafId`. Set its header `cwd` to the path pi will see on the Sprite (the original path with S9, otherwise the job's checkout). Upload it to the job's state dir; the runner passes it with `--session`.
4. Install dependencies when the lockfile hash differs from the last install (package manager detected from the lockfile).
5. Start `handoff-run <jobId>` detached so the `sprite exec` call returns immediately. Default prompt: "Continue where we left off."
6. Locally: write the job record, show `☁ <n> job(s)` in the status line, start polling. The main session stays fully usable.

### Run: `handoff-run <jobId>` (on the Sprite)

1. Create the Tasks API hold `handoff-<jobId>`; start the heartbeat; `trap` deletes it on any exit.
2. `status.json` → `running`.
3. Run pi headless in the job's checkout (inside its mount namespace if S9 works) with the remote extension loaded; append stdout to `events.jsonl`.
4. On exit: `needs_input` if the remote extension recorded a question, else `done` (exit 0) or `error`. Release the hold. The Sprite pauses ~30 s later.

### Remote extension

- Adds the remote briefing to the system prompt on every run (see Briefings).
- Removes unavailable tools from the active set (`setActiveTools`) and filters unavailable skills out of the skills section, so the rules are enforced rather than only stated.
- Without S9: a `tool_call` hook rewrites the original folder path to the job's checkout in tool arguments, as a safety net for paths copied from the history.
- Overrides `ask_user_question`: writes the questions to `status.json`, returns `terminate: true` so the run ends cleanly, and the runner reports `needs_input`.
- On `agent_settled`: records the final assistant text (the end-of-run summary) in `status.json`.

### Briefings

**Remote briefing**, a system prompt section on every remote run:

1. Situation: running unattended on a cloud machine as job `<jobId>`, split from session `<id>`; the user is away.
2. No TUI: no dialogs and no live user. `ask_user_question` ends the run and the question is delivered. Prefer reasonable decisions and list the assumptions made; stop only when truly blocked.
3. Path rule (without S9): `/Users/marc/<folder>` from the history now lives at `<jobRoot>/<folder>`.
4. Unavailable tools and skills, with the reason (Keychain, macOS-only, no cmux).
5. Git rules: work only on `<jobBranch>`, commit as you go, push it, open a PR when ready (or never, per config), do not touch other branches.
6. Credentials: a GitHub token is available, nothing else.
7. End of run: finish with a short summary of what was done and what is next. It becomes the notification text.

**Return briefing**, appended to the job session on pull, before it is opened locally: the job ran on the Sprite at `<path>`; its work is now on branch `<jobBranch>` (and in local worktree `<path>` with `--worktree`); the normal tools are available again. Without it, the resumed conversation would keep using remote paths.

### Status and notification (local)

- While any job is `running`, read its `status.json` over `sprite exec` every ~45 s. This is free: the Sprite is awake anyway while the hold is live.
- Wall-clock based, re-checked on wake (macOS suspends timers during sleep; same lesson as `pi-reminders`). If the laptop slept, the warning shows when it wakes.
- On `done` / `needs_input` / `error`: `ctx.ui.notify` warning with the job name and last message or question, `cmux notify --surface <surface>`, status line updated, polling for that job stops.

### Reply: `/handoff reply [job] <text>`

Refuse while the job is `running`. Start a new run of that job with `<text>` as the prompt. The job defaults to the only one when there is just one.

### Pull: `/handoff pull [job] [--abort] [--switch] [--worktree]`

1. Read `status.json`. If `running`: refuse, or with `--abort` kill the runner's process group, wait for exit, mark `aborted`.
2. Git protocol: final snapshot commit and push on the Sprite (git protocol step 5); fetch the job branch locally; `--worktree` creates a local worktree for it.
3. Download the job session file into the local session directory for the original folder, so it appears in `/resume` there. Reset its header `cwd` to the original folder (or the new worktree with `--worktree`) and append the return briefing.
4. `--switch`: open the job session now (`switchSession`, a command-context operation). Otherwise the main session stays active.
5. Clean up (decision 9) and mark the job `pulled`.

## Spikes — verify before building

Each is a short experiment on a real Sprite. Results go back into this plan.

- **S1 Detached runs and the hold.** A process started via `sprite exec … setsid nohup … &` survives the exec returning; with a Tasks hold the Sprite stays running; without one it pauses after ~30 s (`sprite list` state).
- **S2 Cloned session resume.** A copied session with a new id, `parentSession` set and a rewritten `cwd` resumes with full context via `pi -p --mode json --session <file>` on the Sprite, and shows up correctly in local `/resume` after pull.
- **S3 Headless dialogs.** What happens in print/JSON mode to `ask_user_question` and to extensions calling `ctx.ui.confirm` (`ctx.hasUI` is false there). The override must cover every interactive path in Marc's loadout.
- **S4 Extensions on Linux.** Which of Marc's pi extensions install and work on the Sprite (pi-lens native binaries, LSPs). Decide which to load remotely.
- **S5 File transfer.** `sprite exec --file` upload and binary-safe download (stdout or base64) for the tarball and session file.
- **S6 cmux notify from an extension** targeting the originating surface via `CMUX_SURFACE_ID`.
- **S7 Base image.** What the Sprite ships with (Node, git, ripgrep, agents) to size the bootstrap.
- **S8 Snapshot commit.** The temporary-index snapshot captures tracked and untracked changes without touching the local working tree or index.
- **S9 Mount namespace.** `unshare --mount` plus a bind mount works on the Sprite, so each job's pi sees its own checkout at the original `/Users/marc/...` path while other jobs see theirs.
- **S10 Briefing behavior.** The remote briefing actually changes the model's behavior: correct paths, no attempts at user questions, unavailable tools avoided, an end-of-run summary.

## Milestones

- **M0 Account and Sprite** (Marc + agent): Fly account with Sprites, `sprite login`, `sprite create pi-handoff --skip-console`, bootstrap (Node, pi, toolchain, pi config, model auth, GitHub token, git identity), `sprite checkpoint create --comment base`.
- **M1 Spikes** S1–S10.
- **M2 Push + run + notify** (git protocol): `/handoff`, `handoff-run`, remote extension with the remote briefing, tool filtering and path handling, polling, warning. Usable on its own: hand off, get told, then inspect manually.
- **M3 Reply**: `/handoff reply`.
- **M4 Pull**: refusal, `--abort`, session file with return briefing, `--switch`, `--worktree`, cleanup.
- **M5 Hardening**: concurrent jobs, stale-runner detection (dead pid with `running` status), `/handoff status` listing all jobs, README.

## Open questions

- **Non-git folders**: conversation-only by default; whether to offer a tarball round-trip into a separate folder.
- **Git repo without `origin`**: refuse, or fall back to `git bundle` over `sprite exec`.

## v2

- `/handoff watch`: overlay (`ctx.ui.custom`, like `/btw`) following `events.jsonl` over `sprite exec`; closing it stops the follow so the Sprite can sleep.
- Answer from the notification via `cmux notify --reply`.
- Consider `--mode rpc` on the Sprite so remote dialogs forward to the laptop instead of ending the run.

## Cost expectations

Sprite compute is billed only while running: about $0.038/CPU-hour and $0.021875/GB-hour of memory actually used, plus storage. A working pi with tooling is roughly $0.05–0.10/hour; a paused Sprite costs only storage. LLM tokens will dominate.

## Risks

- **Forgotten holds**: the heartbeat expires within 5 min if the runner dies; never use a hold without an expiry.
- **Data at rest on Fly**: the session file contains tool outputs. Mitigated by pull-time cleanup; be careful with client or patient data.
- **Stale paths in the job's history**: without S9 the model can still reach for original paths. Mitigated by the briefing rule, the `tool_call` rewrite (bash commands are harder to rewrite safely than path arguments) and the return briefing.
