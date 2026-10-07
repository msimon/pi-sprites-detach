# pi-handoff — plan

Status: draft for review. Nothing is built yet.

## Goal

Hand a running pi session off from the laptop to a cloud machine (a Fly.io Sprite) when Marc has to leave, let the agent keep working there unattended, get told in the original pi window when it finishes or needs input, then pull the work and the conversation back and continue locally.

The motivating case: mid-task, Marc has to pick up his kid, closes the laptop, and the agent stops. With pi-handoff he runs `/handoff`, closes the laptop, and the work continues.

## Non-goals (v1)

- Moving the agent mid-run. Handoff happens between runs: pi must be idle (or the current run aborted) first.
- Remote-only tools. Keychain-backed skills (Gmail, Google Workspace, gcalcli, `ntn`) will not work on the Sprite. Accepted.
- Live streaming of the remote run. That is v2 (`/handoff watch`), but v1 writes the event log it needs.
- One Sprite per job. One shared Sprite runs several jobs; the Sprite is a per-job setting so this can change later without touching anything else.
- Uploading extra secrets. Only the model auth and a GitHub token go on the Sprite. Anything else is deferred.

## Settled decisions

1. **Target**: one shared Sprite (default name `pi-handoff`), several concurrent jobs on it.
2. **One worktree per agent.** A worktree path that already has an active handoff cannot be handed off again.
3. **Mirrored absolute paths.** The worktree lives at the same absolute path on the Sprite (`/Users/marc/...`). This keeps every path in the conversation history valid and makes pi's session directory name (derived from cwd) identical on both sides.
4. **Code moves through GitHub.** The Sprite holds a GitHub token anyway (the agent pushes branches and opens PRs). Handoff state travels on a `wip/handoff/<id>` branch that is deleted on pull.
5. **The remote pi runs headless**, one run at a time per session: `pi -p --mode json --session <file> "<prompt>"`. Sequential runs per session; parallel across sessions.
6. **The Sprite is held awake only while pi works**, via the Sprites Tasks API (5 min expiry, refreshed every 60 s, released on exit). When the run ends the Sprite pauses and stops billing compute.
7. **Notifications land in the window that started the handoff**: a pi warning (`ctx.ui.notify`) plus `cmux notify` targeted at that pane (`CMUX_SURFACE_ID`).
8. **Pull refuses while a run is in progress.** `--abort` stops the run first; it is never implicit.
9. **Pull cleans up the Sprite**: session file, `.env*`, `.scratch/`, transfer files and the job's state dir are deleted. The worktree and `node_modules` stay warm.
10. **Repo**: `msimon/pi-handoff`, private, topics `ops` + `perso`, TypeScript like `pi-reminders`.

## Components

```
pi-handoff/
  src/local/      pi extension loaded on the laptop: /handoff commands, status line, polling, notifications, input guard
  src/remote/     pi extension loaded only on the Sprite: headless ask_user_question override, final status
  bin/handoff-run runner on the Sprite: Tasks API hold, launches pi, writes status
  setup/          one-time Sprite bootstrap script
  docs/plan.md    this file
```

## State

Local, one record per handoff at `~/.pi-handoff/handoffs/<id>.json` (`<id>` = pi session id):

```json
{
  "id": "01a115cc-…",
  "sprite": "pi-handoff",
  "worktree": "/Users/marc/hatch/…/mvp",
  "branch": "feat/x",
  "baseHead": "<sha>",
  "baseStash": "<sha or null>",
  "sessionFile": "/Users/marc/.pi/agent/sessions/…/….jsonl",
  "surface": "<CMUX_SURFACE_ID>",
  "state": "running | done | needs_input | error | aborted | pulled",
  "startedAt": "…"
}
```

An active record for a worktree path is the lock (decision 2).

Remote, per job at `~/.handoff/<id>/`:

- `status.json`: `{ id, state, runStartedAt, runEndedAt, exitCode, lastAssistantText (truncated), question? }`
- `events.jsonl`: pi's JSON event stream, appended per run (feeds v2 `watch`).
- `runner.pid`, `runner.log`.

## Flows

### Push: `/handoff [prompt]`

1. Wait for idle. Refuse if the worktree already has an active handoff.
2. Snapshot code without touching the working tree: `git stash create` (null if clean). Push the snapshot to `wip/handoff/<id>` (`git push origin <stash-or-HEAD>:refs/heads/wip/handoff/<id>`); pushing the stash commit also pushes its parent `HEAD`.
3. Tar untracked-but-wanted files: `git ls-files --others --exclude-standard` plus an allowlist of ignored files (default `.env*`, `.scratch/`, configurable).
4. On the Sprite: clone `origin` at the mirrored path if absent; `git fetch`; `git checkout -B <branch> <baseHead>`; `git stash apply <stash>` if any; untar.
5. Upload the session JSONL to the same path under `~/.pi/agent/sessions/`.
6. Install dependencies when the lockfile hash differs from the last install (package manager detected from the lockfile).
7. Start `handoff-run <id>` detached so the `sprite exec` call returns immediately. Default prompt: "Continue where we left off."
8. Locally: write the record, show `☁ <sprite>: running` in the status line, start polling, and guard input (typing in this window offers to send it as a reply instead of running locally, because a local run would fork the session).

### Run: `handoff-run <id>` (on the Sprite)

1. Create the Tasks API hold `handoff-<id>`; start the heartbeat; `trap` deletes it on any exit.
2. `status.json` → `running`.
3. Run pi headless in the worktree with the remote extension loaded; append stdout to `events.jsonl`.
4. On exit: `needs_input` if the remote extension recorded a question, else `done` (exit 0) or `error`. Release the hold. The Sprite pauses ~30 s later.

### Remote extension

- Overrides `ask_user_question`: writes the questions to `status.json`, returns `terminate: true` so the run ends cleanly, and the runner reports `needs_input`.
- On `agent_settled`: records the final assistant text in `status.json`.

### Status and notification (local)

- While `running`, read `status.json` over `sprite exec` every ~45 s. This is free: the Sprite is awake anyway while the hold is live.
- Wall-clock based, re-checked on wake (macOS suspends timers during sleep; same lesson as `pi-reminders`). If the laptop slept, the warning shows when it wakes.
- On `done` / `needs_input` / `error`: `ctx.ui.notify` warning with the last message or question, `cmux notify --surface <surface>`, status line updated, polling stops.

### Reply: `/handoff reply <text>`

Refuse while `running`. Start a new run with `<text>` as the prompt. Plain input typed in the window while handed off goes through the same path after a confirm.

### Pull: `/handoff pull [--abort]`

1. Read `status.json`. If `running`: refuse, or with `--abort` kill the runner's process group, wait for exit, mark `aborted`.
2. On the Sprite: `git stash create`; force-push `HEAD` + stash to `wip/handoff/<id>`; tar the untracked allowlist; read back the session file.
3. Locally: verify the worktree is unchanged since the handoff (`HEAD == baseHead` and the local stash snapshot matches `baseStash`); refuse otherwise. Fetch, move the branch to the remote `HEAD` (`git reset --keep`), `git stash apply` the remote stash, untar.
4. Replace the local session file and reload the session (session replacement is a command-context operation in pi).
5. Clean up (decision 9); delete `wip/handoff/<id>` on origin; mark the record `pulled`.

## Spikes — verify before building

Each is a short experiment on a real Sprite. Results go back into this plan.

- **S1 Detached runs and the hold.** A process started via `sprite exec … setsid nohup … &` survives the exec returning; with a Tasks hold the Sprite stays running; without one it pauses after ~30 s (`sprite list` state).
- **S2 Session resume at the mirrored path.** `pi -p --mode json --session <copied file>` at `/Users/marc/...` on Linux resumes the conversation with full context.
- **S3 Headless dialogs.** What happens in print/JSON mode to `ask_user_question` and to extensions calling `ctx.ui.confirm` (`ctx.hasUI` is false there). The override must cover every interactive path in Marc's loadout.
- **S4 Extensions on Linux.** Which of Marc's pi extensions install and work on the Sprite (pi-lens native binaries, LSPs). Decide which to load remotely.
- **S5 File transfer.** `sprite exec --file` upload and binary-safe download (stdout or base64) for the tarball and session file.
- **S6 cmux notify from an extension** targeting the originating surface via `CMUX_SURFACE_ID`.
- **S7 Base image.** What the Sprite ships with (Node, git, ripgrep, agents) to size the bootstrap.

## Milestones

- **M0 Account and Sprite** (Marc + agent): Fly account with Sprites, `sprite login`, `sprite create pi-handoff --skip-console`, bootstrap (Node, pi, toolchain, pi config, model auth, GitHub token, git identity), `sprite checkpoint create --comment base`.
- **M1 Spikes** S1–S7.
- **M2 Push + run + notify**: `/handoff`, `handoff-run`, remote extension, polling, warning. Usable on its own: hand off, get told, then inspect manually.
- **M3 Reply**: `/handoff reply` and the input guard.
- **M4 Pull**: refusal, `--abort`, local-change check, session reload, cleanup.
- **M5 Hardening**: concurrent jobs, stale-runner detection (dead pid with `running` status), `/handoff status` listing all jobs, README.

## v2

- `/handoff watch`: overlay (`ctx.ui.custom`, like `/btw`) following `events.jsonl` over `sprite exec`; closing it stops the follow so the Sprite can sleep.
- Answer from the notification via `cmux notify --reply`.
- Consider `--mode rpc` on the Sprite so remote dialogs forward to the laptop instead of ending the run.

## Cost expectations

Sprite compute is billed only while running: about $0.038/CPU-hour and $0.021875/GB-hour of memory actually used, plus storage. A working pi with tooling is roughly $0.05–0.10/hour; a paused Sprite costs only storage. LLM tokens will dominate.

## Risks

- **Session divergence**: a local run in the handed-off window would fork the conversation. Mitigated by the input guard and the pull-time check.
- **Forgotten holds**: the heartbeat expires within 5 min if the runner dies; never use a hold without an expiry.
- **Data at rest on Fly**: the session file contains tool outputs. Mitigated by pull-time cleanup; be careful with client or patient data.
