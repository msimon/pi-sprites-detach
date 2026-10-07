# pi-handoff — plan

Status: draft for review. Nothing is built yet.

## Goal

Hand a pi conversation off from the laptop to a cloud machine (a Fly.io Sprite) when Marc has to leave, let the agent keep working there unattended, get told in the original pi window when it finishes or needs input, then pull the work and the conversation back.

The motivating case: mid-task, Marc has to pick up his kid, closes the laptop, and the agent stops. With pi-handoff he runs `/handoff`, closes the laptop, and the work continues.

## Non-goals (v1)

- Moving the agent mid-run. Handoff happens between runs: pi must be idle (or the current run aborted) first.
- Merging conversations or code. A handoff splits off a job; the main session and the original working tree are never modified by it.
- Keychain-backed skills on the Sprite. Gmail, Google Workspace, gcalcli and `ntn` read their credentials from the macOS Keychain, so they will not work there in v1. Later the Sprite gets its own tokens (separate from the laptop's, revocable on their own), and those skills read them from the environment or a file when no Keychain is available.
- Live streaming of the remote run. That is v2 (`/handoff watch`), but v1 writes the event log it needs.
- No dedicated Sprite per job. All jobs share one Sprite; the Sprite is a per-job setting, so per-job Sprites can be added later without touching anything else.
- Uploading extra secrets. Only the model auth and a GitHub token go on the Sprite. Anything else is deferred.

## Settled decisions

1. **Target**: one shared Sprite (default name `pi-handoff`), several concurrent jobs on it.
2. **The conversation splits like `/clone`.** A job runs on a copy of the session's active branch with its own session id and a name. The main session continues locally, untouched. On pull, the job's conversation becomes its own local session file with `parentSession` pointing at the main session; it is opened from `/resume`, or immediately with `/handoff pull --switch`.
3. **The workspace protocol depends on the folder.** A git work tree uses the git protocol below. A non-git folder is conversation-only in v1 (see Workspace protocols).
4. **Each job has its own checkout** on the Sprite, under `<jobRoot>` (`~/jobs/<jobId>/`), so several jobs can come from the same folder. Each job's pi runs in its own mount namespace that shows the job's checkout at the original `/Users/marc/...` path (confirmed by S9), so paths in the conversation history stay valid and no path rewriting is needed. The path rule and `tool_call` rewrite below are kept only as a fallback if the namespace ever stops working.
5. **The remote pi runs headless**, one run at a time per job: `pi -p --mode json --session <file> "<prompt>"`. Runs are sequential within a job and parallel across jobs.
6. **The Sprite is held awake only while pi works**, via the Sprites Tasks API (5 min expiry, refreshed every 60 s, released on exit). When the run ends the Sprite pauses and stops billing compute.
7. **Notifications land in the window that started the handoff**: a pi warning (`ctx.ui.notify`) plus `cmux notify` targeted at that pane (`CMUX_SURFACE_ID`).
8. **Pull refuses while a run is in progress.** `--abort` stops the run first; it is never implicit.
9. **Pull cleans up the Sprite**: session file, `.env*`, `.scratch/`, transfer files and the job's state dir are deleted. The job's worktree is removed (its work is on `origin`); the repo's cached clone and the npm `node_modules` cache stay warm.
10. **Repo**: `msimon/pi-handoff`, private, topics `ops` + `perso`, TypeScript like `pi-reminders`.

## Workspace protocols

### Git protocol

Applies when the folder is inside a git work tree with an `origin` remote.

1. **One branch per job, on `origin` only.** The job branch `<current-branch>-handoff-<n>` is pushed straight from `HEAD` (or the snapshot commit) with `git push origin <sha>:refs/heads/<jobBranch>`; no local branch is created. `<n>` is the next free number on `origin`. The original branch, working tree and local branch list are untouched.
2. **Uncommitted work travels as a snapshot commit on the job branch.** Tracked changes and untracked, non-ignored files are committed with a temporary index (`GIT_INDEX_FILE=… git add -A`, `git write-tree`, `git commit-tree`), so the local working tree and index are not touched. The snapshot commit becomes the job branch's tip on `origin`; no local ref is created or moved.
3. **Ignored-but-wanted files never get committed.** An allowlist (default `.env*`, `.scratch/`, configurable) travels as a tarball, built with `COPYFILE_DISABLE=1 tar --no-xattrs` and uploaded with `sprite file push` (S5).
4. **On the Sprite**, each repo has one cached clone at `~/repos/<owner>/<repo>`, made once with `git clone --filter=blob:none` (full history, file contents fetched on demand). Each job fetches its branch into it and gets its own worktree: `git worktree add <jobRoot>/<repo> <jobBranch>`. The agent commits on it, pushes it and opens a PR when the work is ready (configurable: `pr: auto | never`). It is a normal branch, not a temporary one.
5. **On pull**, any uncommitted remote changes get a final snapshot commit and are pushed. Locally the job branch is only fetched (`origin/<jobBranch>`); `--worktree` creates the local branch and a worktree for it (see Local worktrees). Combining it with local work is ordinary git, if and when Marc chooses.

### Local worktrees

`pull --worktree` puts every job worktree under one folder: `~/pi-handoff/worktrees/<repo>/<jobId>`, on a local branch `<jobBranch>` tracking `origin`. A worktree can also be added later by hand with `git worktree add <path> <jobBranch>`.
### Non-git folders

Code transfer has no safe merge story here, but the conversation can still continue (research, planning, writing). v1: conversation-only. The job runs in an empty job folder and the briefing tells it the local files are not available. Later: optionally upload small folders as a tarball, with remote files brought back into a separate `<path>.handoff-<job>/` folder on pull, never in place.

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

- `session.jsonl`: the job's conversation; every run reads and appends to it, and pull downloads it.
- `status.json`: `{ jobId, state, runStartedAt, runEndedAt, exitCode, lastAssistantText (truncated), question? }`
- `events.jsonl`: pi's JSON event stream, appended per run (feeds v2 `watch`).
- `runner.pid`, `runner.log`.

## Flows

### Push: `/handoff [prompt]`

1. Wait for idle.
2. Detect the protocol and prepare the workspace (git protocol steps 1–4, or conversation-only).
3. Create the job session: a copy of the active branch with a new session id, `parentSession` set to the main session file, and a job name. Record `forkLeafId`. Its header `cwd` stays the original path, which the job sees through its mount namespace. Upload it to the job's state dir with `sprite file push` (create the dir first: push does not); the runner passes it with `--session`.
4. Prepare dependencies, without installing them. For npm projects (no shared store), the job's checkout gets a copy of the cached `node_modules` for that repo and lockfile hash, if one exists. The agent runs the install itself (see Briefings); after the run, the runner saves the job's `node_modules` as the cache for a new lockfile hash.
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
- Fallback only (namespace unavailable): a `tool_call` hook rewrites the original folder path to the job's checkout in tool arguments, as a safety net for paths copied from the history.
- Overrides `ask_user_question`: writes the questions to `status.json`, returns `terminate: true` so the run ends cleanly, and the runner reports `needs_input`.
- On `agent_settled`: records the final assistant text (the end-of-run summary) in `status.json`.

### Briefings

**Remote briefing**, a system prompt section on every remote run:

1. Situation: running unattended on a cloud machine as job `<jobId>`, split from session `<id>`; the user is away.
2. No TUI: no dialogs and no live user. `ask_user_question` ends the run and the question is delivered. Prefer reasonable decisions and list the assumptions made; stop only when truly blocked.
3. Path rule, fallback only (namespace unavailable): `/Users/marc/<folder>` from the history now lives at `<jobRoot>/<folder>`.
4. Unavailable tools and skills, with the reason (Keychain, macOS-only, no cmux).
5. Git rules: work only on `<jobBranch>`, commit as you go, push it, open a PR when ready (or never, per config), do not touch other branches.
6. Dependencies: not installed. Run `<install command>` (from the detected lockfile, e.g. `pnpm install`, `npm install`, `uv sync`) before running tests or builds.
7. Credentials: a GitHub token is available, nothing else.
8. End of run: finish with a short summary of what was done and what is next. It becomes the notification text.

**Return briefing**, appended to the job session on pull, before it is opened locally: the job ran on the Sprite at `<path>`; its work is now on branch `<jobBranch>` (and in local worktree `<path>` with `--worktree`); the normal tools are available again. Without it, the resumed conversation would keep using remote paths.

### Status and notification (local)

- While any job is `running`, read its `status.json` over `sprite exec` every ~45 s. This is free: the Sprite is awake anyway while the hold is live.
- Wall-clock based, re-checked on wake (macOS suspends timers during sleep; same lesson as `pi-reminders`). If the laptop slept, the warning shows when it wakes.
- On `done` / `needs_input` / `error`: `ctx.ui.notify` warning with the job name and last message or question, `cmux notify --surface <surface>`, status line updated, polling for that job stops.

### Reply: `/handoff reply [job] <text>`

Refuse while the job is `running`. Start a new run of that job with `<text>` as the prompt. The run reuses the job's worktree and session file: pi loads the full history from the session file and appends `<text>` as the next user message. The job defaults to the only one when there is just one.

### Pull: `/handoff pull [job] [--abort] [--switch] [--worktree]`

1. Read `status.json`. If `running`: refuse, or with `--abort` kill the runner's process group, wait for exit, mark `aborted`.
2. Git protocol: final snapshot commit and push on the Sprite (git protocol step 5); fetch the job branch locally; `--worktree` creates a local worktree for it.
3. Download the job session file (`sprite file pull`) into the local session directory for the original folder, so it appears in `/resume` there. Reset its header `cwd` to the original folder (or the new worktree with `--worktree`) and append the return briefing.
4. `--switch`: open the job session now (`switchSession`, a command-context operation). Otherwise the main session stays active.
5. Clean up (decision 9) and mark the job `pulled`.

## Spikes — verify before building

Each is a short experiment on a real Sprite. Results go back into this plan.

- **S1 Detached runs and the hold.** ✅ Mostly done, 2026-10-07. A `setsid nohup … &` process survives `sprite exec` returning, also inside the mount namespace (running as `sprite` at `/Users/marc/<repo>`). Without a hold it ran ~10 s, froze, and resumed with the same pid on the next exec (no reboot). With a hold (5 min expiry, PUT every 60 s) a 5 s ticker ran 150 s without a gap. Tasks API (docs and test): `POST /v1/tasks {name, expire}` (201, 409 if taken), `PUT /v1/tasks/<name> {expire}` upserts and resets `started_at`, `DELETE` releases; `expire` is at most 1 h. The Sprite's state can be read without waking it via `sprite api /v1/sprites/<name>` (`running`/`warm`/`cold`), but it flaps, so don't rely on it. Caveats: a `cold` Sprite drops memory, so frozen processes only survive a `warm` pause; a hold that lapses mid-run can kill the run; run recovery (M5) restarts it from the session file. `pkill -f`/`pgrep -f` match the calling `sh -c` itself; the runner uses pid files. pi across freezes (no hold, Haiku, a `sleep 120` tool call): the Sprite froze ~10 s into the tool call and stayed frozen 194 s until the next exec; an open pi process, an open HTTPS connection and even a streaming LLM response do not keep it awake (the response only advanced during the ~10 s after each exec, so a 2 s answer took 3 min). Each time it woke, pi carried on: the stream survived repeated ~10 s freezes and the run finished cleanly with no errors or retries. So the hold is mandatory for every run, and a short lapse only slows the run down. A long freeze mid-stream (server drops the connection) was not forced; pi's `retry` settings (3 attempts) and `httpIdleTimeoutMs` (300 s) cover it, and a missed heartbeat only happens if the runner itself died.
- **S2 Cloned session resume.** ✅ Done 2026-10-07. A local session (code word plus a `git log` tool call) was cloned: header with a new id and `parentSession` set to the original file, entries on the path from leaf to root, a `session_info` name. Uploaded with `sprite file push` and resumed inside the mount namespace with `pi -p --mode json --session <file>`: the model recalled the code word and the commit hash, `pwd` returned the laptop path and `ls` the job checkout. pi appended to the same file (a new system message for the remote prompt, then the turn) and created no other session file. Pulled back into the local session dir unchanged (no `cwd` rewrite needed), `SessionManager.list` showed it with its name and `parentSessionPath`, and `pi --session <id>` resumed it locally. Findings: inside `sudo unshare` the PATH must be passed through (`env PATH=$PATH`), or `node` (in `/.sprite/bin`) is not found. Back on the laptop the model assumed the remote `ls` ran on the Mac, because the path looks local, which confirms the return briefing is needed.
- **S3 Headless dialogs.** What happens in print/JSON mode to `ask_user_question` and to extensions calling `ctx.ui.confirm` (`ctx.hasUI` is false there). The override must cover every interactive path in Marc's loadout.
- **S4 Extensions on Linux.** Which of Marc's pi extensions install and work on the Sprite (pi-lens native binaries, LSPs). Decide which to load remotely.
- **S5 File transfer.** ✅ Done 2026-10-07. Upload: `sprite exec --file src:dest` and `sprite file push` are both byte-exact (5 MB in ~7 s, upload-bound). Download: `sprite file pull` is byte-exact (5 MB in 0.4 s). `sprite exec` stdout is not usable for bulk data: 200 KB already fails with `cannot resume output at byte 0`, and base64 or `--http-post` don't help; keep it for small JSON such as `status.json`. macOS `tar` needs `COPYFILE_DISABLE=1 tar --no-xattrs`, or the tarball carries `._*` files and xattr headers.
- **S6 cmux notify from an extension** targeting the originating surface via `CMUX_SURFACE_ID`.
- **S7 Base image.** ✅ Done 2026-10-07. Ubuntu 26.04 x86_64, 8 vCPU, 8 GiB RAM visible, 99 GB disk. Runs as user `sprite` (uid 1001, home `/home/sprite`) with passwordless `sudo`. Preinstalled: Node 24, npm, bun, Python 3.13, uv, Go 1.25, git, `gh`, jq, curl, tmux, `unshare`, Claude Code, Codex and **pi 0.84.4** (with a `~/.pi`). Missing: pnpm, ripgrep, fd, ast-grep, nu, docker. Tasks API socket at `/.sprite/api.sock` answers `{"tasks":[]}`; `sprite-env` at `/.sprite/bin/sprite-env`. Bootstrap must upgrade pi to the laptop's version (1.0.4) so session files are compatible, and install the missing tools.
- **S8 Snapshot commit.** ✅ Done 2026-10-07 (local). Copy `.git/index` to a temp file, `GIT_INDEX_FILE=<tmp> git add -A && git write-tree`, then `git commit-tree <tree> -p HEAD`. Captures modified, staged, partially staged (the working-tree version wins), untracked and deleted files; ignored files such as `.env` are excluded, as intended. Afterwards `git status`, the real index (byte-identical), `HEAD` and all refs were unchanged, and no hooks ran. On a clean tree the tree equals `HEAD^{tree}`, so no snapshot is made.
- **S9 Mount namespace.** ✅ Works, 2026-10-07. `sudo unshare --mount --propagation private` + `mount --bind ~/jobs/<job>/proj /Users/marc/proj`, then `setpriv --reuid=sprite --regid=sprite --init-groups` to drop back to the `sprite` user. Two concurrent jobs each saw their own checkout at the same `/Users/marc/proj` path, wrote into their own job dir, and the path stayed empty outside the namespaces. Decision 4 uses the namespace; the path rule and rewrite hook are not needed. Unprivileged `unshare -rm` also works, but would make pi run as a mapped root, so the sudo + setpriv form is preferred. Still to confirm in S1: a detached runner inside the namespace survives `sprite exec` returning.
- **S10 Briefing behavior.** The remote briefing actually changes the model's behavior: correct paths, no attempts at user questions, unavailable tools avoided, an end-of-run summary.

## Milestones

- **M0 Account and Sprite** (Marc + agent): ✅ Done 2026-10-07. Fly account with Sprites, `sprite login`, `sprite create pi-handoff --skip-console`. Bootstrap: Node 24.21.0 as the nvm default (matches the laptop); pi 1.0.4 via `curl -fsSL https://pi.dev/install.sh | sh` (managed install, `pi update` later; never `npm install -g`); pnpm and ast-grep via `npm install -g --prefix ~/.local` (nvm's global bin is not on the PATH); ripgrep and fd from apt (`fd` linked to `fdfind`); `LANG`/`LC_ALL=C.UTF-8` in `~/.profile`; git identity Marc Simon; model auth via `/login` in `sprite exec --tty -- pi` (Anthropic and Codex, Sprite-only tokens); `gh auth login` + `gh auth setup-git`. Checkpoint `v4` (`base`). Not done: Marc's pi config and extensions (S4).
- **M1 Spikes** S1–S10.
- **M2 Push + run + notify** (git protocol): `/handoff`, `handoff-run`, remote extension with the remote briefing, tool filtering and path handling, polling, warning. Usable on its own: hand off, get told, then inspect manually.
- **M3 Reply**: `/handoff reply`.
- **M4 Pull**: refusal, `--abort`, session file with return briefing, `--switch`, `--worktree`, cleanup.
- **M5 Hardening**: concurrent jobs, `/handoff status` listing all jobs, README. Run recovery: a Sprite service `handoff-recover` (services restart at boot) finds jobs whose `status.json` says `running` but whose runner pid is dead, for example after a `cold` pause dropped memory, and restarts each runner on the same session file with a "You were interrupted; check the state and continue" prompt. The session file keeps everything up to the last completed step. A retry limit per job stops a crash loop; past it the job is marked `error`.

## Open questions

- **Git repo without `origin`**: refuse, or fall back to `git bundle` over `sprite exec`.

## v2

- `/handoff watch`: overlay (`ctx.ui.custom`, like `/btw`) following `events.jsonl` over `sprite exec`; closing it stops the follow so the Sprite can sleep.
- Answer from the notification via `cmux notify --reply`.
- Consider `--mode rpc` on the Sprite so remote dialogs forward to the laptop instead of ending the run.
- `/handoff cleanup [job]`: remove a job's local worktree and branch once merged or discarded; refuse if it has uncommitted changes.
- Sprite credentials for Keychain-backed skills: Sprite-only tokens (Gmail app password, Google OAuth, `ntn`) stored on the Sprite, and each skill falls back to an environment variable or file when the Keychain is unavailable. This lifts the "extra secrets" non-goal for those skills.
- Non-git folders: optional tarball round-trip for small folders, returned into `<path>.handoff-<job>/`, never in place.

## Cost expectations

Sprite compute is billed only while running: about $0.038/CPU-hour and $0.021875/GB-hour of memory actually used, plus storage. A working pi with tooling is roughly $0.05–0.10/hour; a paused Sprite costs only storage. LLM tokens will dominate.

## Risks

- **Forgotten holds**: the heartbeat expires within 5 min if the runner dies; never use a hold without an expiry.
- **Data at rest on Fly**: the session file contains tool outputs. Mitigated by pull-time cleanup; be careful with client or patient data.
- **Stale paths in the job's history**: avoided by the per-job mount namespace (S9). If it ever stops working, the fallback is the briefing rule plus the `tool_call` rewrite (bash commands are harder to rewrite safely than path arguments).
