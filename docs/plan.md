# pi-handoff — plan

Status: M0–M2 built and tested end to end on the Sprite (2026-10-08). M3–M5 to do.

## Goal

Hand a pi conversation off from the laptop to a cloud machine (a Fly.io Sprite) when Marc has to leave, let the agent keep working there unattended, get told in the original pi window when it finishes or needs input, then pull the work and the conversation back.

The motivating case: mid-task, Marc has to pick up his kid, closes the laptop, and the agent stops. With pi-handoff he runs `/handoff`, closes the laptop, and the work continues.

## Non-goals (v1)

- Moving the agent mid-run. Handoff happens between runs: pi must be idle (or the current run aborted) first.
- Merging conversations or code. A handoff splits off a job; the main session and the original working tree are never modified by it.
- Keychain-backed skills on the Sprite. Gmail, Google Workspace, gcalcli and `ntn` read their credentials from the macOS Keychain, so they will not work there in v1. Later the Sprite gets its own tokens (separate from the laptop's, revocable on their own), and those skills read them from the environment or a file when no Keychain is available.
- Live streaming of the remote run. That is v2 (`/handoff watch`), but v1 writes the event log it needs.
- No dedicated Sprite per job. All jobs share one Sprite; the Sprite is a per-job setting, so per-job Sprites can be added later without touching anything else.
- Uploading extra secrets. Only the model auth, a GitHub token and the web search keys (`~/.pi/web-search.json`) go on the Sprite. Anything else is deferred.

## Settled decisions

1. **Target**: one shared Sprite (default name `pi-handoff`), several concurrent jobs on it.
2. **The conversation splits like `/clone`.** A job runs on a copy of the session's active branch with its own session id and a name. The main session continues locally, untouched. On pull, the job's conversation becomes its own local session file with `parentSession` pointing at the main session; it is opened from `/resume`, or immediately with `/handoff pull --switch`.
3. **The workspace protocol depends on the folder.** A git work tree uses the git protocol below. A non-git folder is conversation-only in v1 (see Workspace protocols).
4. **Each job has its own checkout** on the Sprite, under `<jobRoot>` (`~/jobs/<jobId>/`), so several jobs can come from the same folder. Each job's pi runs in its own mount namespace that shows the job's checkout at the original `/Users/marc/...` path (confirmed by S9), so paths in the conversation history stay valid and no path rewriting is needed. The path rule and `tool_call` rewrite below are kept only as a fallback if the namespace ever stops working.
5. **The remote pi runs headless**, one run at a time per job: `pi -p --mode json --session <file> "<prompt>"`. Runs are sequential within a job and parallel across jobs.
6. **The Sprite is held awake only while pi works**, via the Sprites Tasks API (5 min expiry, refreshed every 60 s, released on exit). When the run ends the Sprite pauses and stops billing compute.
7. **Notifications land in the window that started the handoff**: an outcome card in the chat plus `cmux notify` targeted at that pane (`CMUX_SURFACE_ID`).
8. **Pull refuses while a run is in progress.** `--abort` stops the run first; it is never implicit.
9. **Pull cleans up the Sprite**: session file, the copied project files (`copyProjectFiles`), transfer files and the job's state dir are deleted. The job's worktree is removed (its work is on `origin`); the repo's cached clone and the npm `node_modules` cache stay warm.
10. **Repo**: `msimon/pi-handoff`, private, topics `ops` + `perso`, TypeScript like `pi-reminders`.

## Workspace protocols

### Git protocol

Applies when the folder is inside a git work tree with an `origin` remote.

1. **One branch per job, on `origin` only.** The job branch `<current-branch>-handoff-<n>` is pushed straight from `HEAD` (or the snapshot commit) with `git push --no-verify origin <sha>:refs/heads/<jobBranch>` (a snapshot of work in progress would trip pre-push checks); no local branch is created. `<n>` is the next free number on `origin`. The original branch, working tree and local branch list are untouched.
2. **Uncommitted work travels as a snapshot commit on the job branch.** Tracked changes and untracked, non-ignored files are committed with a temporary index (`GIT_INDEX_FILE=… git add -A`, `git write-tree`, `git commit-tree`), so the local working tree and index are not touched. The snapshot commit becomes the job branch's tip on `origin`; no local ref is created or moved.
3. **Ignored-but-wanted files never get committed.** The files matched by `copyProjectFiles` (see Config; default `.env*`, `.scratch/`) travel as a tarball, built with `COPYFILE_DISABLE=1 tar --no-xattrs` and uploaded with `sprite exec --file` (S5). Files inside `node_modules/` or `.venv/` are never copied.
4. **On the Sprite**, each repo has one cached clone at `~/repos/<owner>/<repo>`, made once with `git clone --filter=blob:none` (full history, file contents fetched on demand). Each job fetches its branch into it and gets its own worktree: `git worktree add <jobRoot>/<repo> <jobBranch>`. The agent commits on it, pushes it and opens a PR when the work is ready (configurable: `pr: auto | never`). It is a normal branch, not a temporary one.
5. **On pull**, any uncommitted remote changes get a final snapshot commit and are pushed. Locally the job branch is only fetched (`origin/<jobBranch>`); `--worktree` creates the local branch and a worktree for it (see Local worktrees). Combining it with local work is ordinary git, if and when Marc chooses.

### Local worktrees

`pull --worktree` puts every job worktree under one folder: `~/pi-handoff/worktrees/<repo>/<jobId>`, on a local branch `<jobBranch>` tracking `origin`. A worktree can also be added later by hand with `git worktree add <path> <jobBranch>`.
### Non-git folders

Code transfer has no safe merge story here, but the conversation can still continue (research, planning, writing). v1: conversation-only. The job runs in an empty job folder and the briefing tells it the local files are not available. Later: optionally upload small folders as a tarball, with remote files brought back into a separate `<path>.handoff-<job>/` folder on pull, never in place.

## Components

The GitHub repository and an installed copy have different layouts. The repo holds sources; the install is what actually runs, and its Sprite part is a self-contained folder that gets synced as-is.

**Repository** (`msimon/pi-handoff`, installed with `pi install git:github.com/msimon/pi-handoff`):

```
pi-handoff/
  src/local/        pi extension loaded on the laptop: /handoff commands, config sync, status line, polling, notifications
  src/remote/       pi extension loaded only for job runs on the Sprite: briefing, final message
  sprite/bin/       handoff-run (Tasks API hold, checkout, mount namespace, pi, status), handoff-sync-apply, lib.sh
  sprite/setup/     bootstrap.sh (base Sprite: Node, pi, CLI tools, locale, git config), install-tool.sh, tools/<name>.sh recipes
  examples/         user extensions the default config refers to (remote-ask.ts)
  docs/plan.md      this file
```

**Install on the laptop** (`~/.pi-handoff/`):

```
~/.pi-handoff/
  config.json       Marc's config (see Config)
  extensions/       Marc's own extensions for the Sprite, e.g. remote-ask.ts (synced, see Config)
  jobs/             one record per job (see State)
  sprite/           everything the Sprite needs, built from the package: bin/, setup/, extension/ (src/remote
                    copied as .ts files; pi loads them directly, no build step), manifest.json { version, hash }
```

pi has no install hook, so the local extension builds `~/.pi-handoff/sprite/` itself on `session_start` (and before every sync) when it is missing or the package's files changed (content hash). Nothing in it is edited by hand. The first run also writes `config.json` with the defaults and copies `examples/remote-ask.ts` into `extensions/`; from then on both are Marc's, and an existing file is never overwritten.

**On the Sprite**, the same paths: `~/.pi-handoff/sprite/` is an exact copy of the laptop's, delivered by Config sync and replaced wholesale on update, so it never holds state; `~/.pi-handoff/extensions/` arrives through `sync.paths` like any synced folder, so an update never touches it. Job state lives in `~/.handoff/` (see State).

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
  "state": "starting | preparing | running | done | needs_input | error | aborted | pulled",
  "startedAt": "…"
}
```

Remote, per job at `~/.handoff/<jobId>/`:

- `job.json`: what the laptop knows about the job (folder, mount point, checkout, branch, clone URL, PR policy); read by `handoff-run` and the remote extension.
- `session.jsonl`: the job's conversation; every run reads and appends to it, and pull downloads it.
- `prompt.txt`: the prompt for the next run.
- `status.json`: `{ jobId, state, runStartedAt, runEndedAt, exitCode, lastAssistantText (truncated), question, error }`, written only by `handoff-run`. `preparing` covers the runner's setup before pi starts (first clone, worktree, copied files, `node_modules`), so a setup failure reads as such; the laptop counts it as running.
- `question.json` (written by the user's `ask_user_question` extension) and `result.json` (the final assistant text, written by the remote extension): per-run outputs that `handoff-run` merges into `status.json` when pi exits.
- `events.jsonl`: pi's JSON event stream, appended per run (feeds v2 `watch`).
- `runner.pid`, `runner.log`.

## Config

`~/.pi-handoff/config.json`. The first run writes it with these defaults, so everything that syncs or is skipped is visible and editable; nothing is hidden in code.

```json
{
  "sprite": "pi-handoff",
  "pr": "auto",
  "sync": {
    "paths": [
      "~/.pi/agent/AGENTS.md",
      "~/.pi/agent/extensions",
      "~/.pi/agent/skills",
      "~/.pi/agent/loadouts.json",
      "~/.pi/agent/subagents.json",
      "~/.pi/agent/trust.json",
      "~/.agents/skills",
      "~/.pi/web-search.json",
      "~/.pi-handoff/extensions"
    ],
    "exclude": ["**/.venv", "**/node_modules", "**/__pycache__", "**/.DS_Store", "**/*.lock"]
  },
  "remote": {
    "exclude": ["msimon/pi-handoff", "pi-cron-jobs", "pi-reminders"],
    "replace": { "npm:@juicesharp/rpiv-ask-user-question": "~/.pi-handoff/extensions/remote-ask.ts" },
    "tools": ["agent-browser"]
  },
  "copyProjectFiles": [".env*", ".scratch/"]
}
```

- `sprite`: the Sprite for new jobs; each job records its own.
- `pr`: `auto` tells the remote agent to open a pull request once the work is pushed and put its URL in its final message; `never` tells it not to. A detached `HEAD` always means `never` (no base branch).
- `sync.paths`: exactly what Config sync sends. `settings.json` is not listed because it always syncs (it carries the package list), rewritten for the Sprite: the `remote` rules, then laptop home paths `/Users/marc/` → `/home/sprite/`. `trust.json` is listed because project trust is keyed by path and the job sees the same paths, so Marc's saved answers apply as they are (S3). `~/.pi-handoff/extensions` holds Marc's own extensions for the Sprite.
- `sync.exclude`: globs skipped inside those paths.
- `remote.exclude`: entries not loaded on the Sprite. pi's `settings.json` has two lists: `packages` (`npm:…` / `git:…` sources pi installs and updates; a package can bundle extensions, skills, prompts and themes) and `extensions` (paths to local `.ts` files loaded directly). An entry matches either list by substring, so `"pi-reminders"` is enough. `msimon/pi-handoff` keeps pi-handoff's own laptop extension off the Sprite when it is installed as a package. Separately, any extension path outside `sync.paths` is dropped, because the file would not exist there; to run a local extension on the Sprite, add its folder to `sync.paths` (today only `pi-cron-jobs` and `pi-reminders`, which live in their repos); `/handoff sync` lists everything it drops.
- `remote.replace`: same matching, swapped for another source: `npm:…` or `git:…` (goes to `packages`), or a file of Marc's own (`~/…`, goes to `extensions`; it must exist and be under `sync.paths`, or the sync stops with an error). The default swaps `rpiv-ask-user-question`, which hides its tool when there is no UI (S3), for `~/.pi-handoff/extensions/remote-ask.ts`, copied from `examples/` on first run. Only one of them may be loaded: two extensions registering the same tool name stop pi from starting (S3). A replacement `ask_user_question` follows the runner's contract: the job's state folder is in `$HANDOFF_DIR` (unset outside a job run); write the questions to `$HANDOFF_DIR/question.json`; end the run with `terminate: true`. The runner then reports `needs_input`. If the model asks in plain text instead, the run ends `done` and the notification carries that text.
- `remote.tools`: programs an extension needs that pi does not install, e.g. `agent-browser`, the CLI that `pi-agent-browser-native` wraps (S4). Names only: Config sync reads the laptop's installed version (`<tool> --version`, falling back to `brew list --versions <tool>`) and reinstalls on the Sprite only when the versions differ, so both machines stay on the same version without a pinned number going stale. How each tool is installed on Linux (for `agent-browser`: `npm install -g --prefix ~/.local agent-browser@<version>`, then `agent-browser install --with-deps`) lives in the setup script.
- `copyProjectFiles`: git-ignored files from the handed-off project that are copied into the job's checkout (git protocol step 3). A project can override the list with `copyProjectFiles` in `<repo>/.pi-handoff.json`.
## Flows

### Push: `/handoff [prompt]`

1. Wait for idle.
2. Sync the pi config, pi-handoff's Sprite files and `remote.tools` if anything changed (see Config sync). It runs first, so a failed sync never leaves a pushed job branch behind. A tool install blocks the push: the status line shows `installing <tool>…` until it finishes (the first `agent-browser` install takes minutes; version bumps are quick).
3. Detect the protocol and prepare the workspace (git protocol steps 1–3, or conversation-only). The folder is the session's own `cwd` (from its header), not pi's current directory: they differ when a symlink is involved (`/tmp` is `/private/tmp` on macOS), and pi refuses to resume a session whose `cwd` does not exist.
4. Create the job session with pi's own `createBranchedSession` (as `/clone` does): the active branch with a new session id, `parentSession` set to the main session file, and the name `<session name> [<jobId>]`. Record `forkLeafId`. Its header `cwd` stays the original path, which the job sees through its mount namespace.
5. Upload the session, `job.json`, `prompt.txt` and the copied project files with `sprite exec --file` (S5) into a staging folder that becomes the job's state dir; refuse if that dir already exists. Dependencies are prepared by the runner, not installed (see Run).
6. Start `handoff-run <jobId>` detached so the `sprite exec` call returns immediately. Default prompt: "Continue where we left off."
7. Locally: while steps 1–6 run, a line above the input shows the current step (`☁ Handing off: syncing the Sprite…`); typing the command empties the input, so the footer alone was too easy to miss. Then: write the job record, a start message (`Handoff started: job <jobId> on Sprite <sprite>`, the conversation name, the branch), show `☁ <n> running` in the status line, start polling. The main session stays fully usable.

### Config sync

The laptop is the source of truth for Marc's pi setup; the Sprite gets a copy, refreshed only when something changed.

1. **What syncs:** the files under `sync.paths` minus `sync.exclude` (see Config), plus `settings.json` rewritten for the Sprite.
2. **What never syncs:** `auth.json` (the Sprite has its own logins), sessions, caches and logs; they are simply not in `sync.paths`.
3. **When:** on every `/handoff`, hash the synced set and compare it with what the Sprite last applied (`~/.handoff/sync/applied.json`). Unchanged costs one small read. Changed: upload a tarball (`COPYFILE_DISABLE=1 tar --no-xattrs`, `sprite exec --file`) and start `handoff-sync-apply` detached, which unpacks it over the Sprite's home, writes the settings, runs `pi update --extensions` only if the package list changed, and reports progress in `~/.handoff/sync/state.json`, which the laptop polls. A file a previous sync wrote and the laptop no longer has is deleted; nothing else is ever deleted, so the Sprite's own files (its skills `sprite` and `sprite-api-gateway`, its logins) stay. `/handoff sync` does the same on demand and lists what it updated and dropped.
4. **Per-machine rules** come from `remote` in the config: `exclude` and `replace` are applied while rewriting `settings.json`; `tools` are compared by version with the laptop and installed by the setup script when they differ.
5. **Long installs** (`pi update`, apt, `remote.tools`) run detached under their own Tasks hold, never inside one `sprite exec`: a dropped exec session would kill them. Tools: the laptop compares each tool's version with the Sprite's (`tool_version` from its recipe, one small exec); on a mismatch `handoff-sync-apply` runs `~/.pi-handoff/sprite/setup/install-tool.sh <name> <version>`, logging to `~/.handoff/sync/sync.log`. A name with no recipe in `setup/tools/` is a warning, not an error.
6. **pi-handoff's own files:** `~/.pi-handoff/sprite/` is uploaded to the same path on the Sprite with the same hash check (its `manifest.json` hash) and swapped in at once, so updating pi-handoff on the laptop updates the Sprite on the next `/handoff`.
7. **Secrets:** `~/.pi/web-search.json` syncs like the rest, but keeps its `0600` permissions and is never logged. The Sprite's own logins (`auth.json`, `gh`) are never overwritten.
### Run: `handoff-run <jobId>` (on the Sprite)

1. Create the Tasks API hold `handoff-<jobId>`; start the heartbeat (it stops by itself if the runner dies); `trap` deletes the hold on any exit.
2. `status.json` → `preparing`. On the first run, prepare the checkout: clone the repo into the cache if needed, fetch the job branch, `git worktree add -B <jobBranch> <checkout> origin/<jobBranch>`, unpack the copied project files, and for npm projects copy the cached `node_modules` for that repo and lockfile hash, if one exists. Dependencies are not installed: the agent runs the install itself (see Briefings).
3. `status.json` → `running`. Run pi headless inside the job's mount namespace (the checkout bind-mounted at the laptop path, `cwd` the laptop folder, back to the `sprite` user with `setpriv`) with the remote extension loaded (`-e ~/.pi-handoff/sprite/extension/index.ts`) and `HANDOFF_JOB_ID` / `HANDOFF_DIR` set; append stdout to `events.jsonl`.
4. On exit: save the job's `node_modules` as the cache for a new lockfile hash; then `needs_input` if `question.json` exists, else `done` (exit 0) or `error` (with the end of `runner.log`). Release the hold. The Sprite pauses ~30 s later.

### Remote extension

- Adds the remote briefing to the system prompt on every run (see Briefings).
- No tool filtering: the tools that cannot work on the Sprite come from laptop-only extensions, which the `settings.json` rewrite already removes, and tools that need a UI either hide themselves headless or are replaced (`remote.replace`).
- Fallback only, not built (the namespace works): a `tool_call` hook rewriting the original folder path to the job's checkout in tool arguments.
- Asking the user is not built in: `ask_user_question` comes from a user extension (default `~/.pi-handoff/extensions/remote-ask.ts`, see `remote.replace`).
- On `agent_end`: records the final assistant text (the end-of-run summary) in `result.json`.

### Briefings

**Remote briefing**, a system prompt section on every remote run:

1. Situation: running unattended on a cloud machine as job `<jobId>`, split from session `<id>`; the user is away.
2. No TUI: no dialogs and no live user, nobody reads the messages until the run ends. Make reasonable decisions and list the assumptions made. (The briefing does not mention `ask_user_question`: when a user extension provides it, the model sees it as a tool like any other.)
3. Files: the checkout of `<jobBranch>` at the laptop path (or, without git, an empty folder whose files are not brought back). Only the project folder is copied: files elsewhere on the laptop (for example under `/tmp`) are not there, so the agent says which one it needs, or asks, instead of guessing. Path rule, fallback only (namespace unavailable, not built): `/Users/marc/<folder>` from the history now lives at `<jobRoot>/<folder>`.
4. Unavailable tools and skills, with the reason (Keychain, macOS-only, no cmux).
5. Git rules: work only on `<jobBranch>`, commit as you go, push it, open a PR with `gh pr create --base <baseBranch> --fill` once the work is pushed and give its URL (or never, per config), do not touch other branches, never force-push. Committing and pushing the job branch is how the work gets back, so it applies even if the user said earlier not to commit yet (otherwise the agent obeys the conversation and the work is lost).
6. Dependencies: not installed. Run `<install command>` (from the detected lockfile, e.g. `pnpm install`, `npm install`, `uv sync`) before running tests or builds.
7. Credentials: a GitHub token and web search are available, nothing else.
8. End of run: finish with a short summary of what was done and what is next. It becomes the notification text.

**Return briefing**, appended to the job session on pull, before it is opened locally: the job ran on the Sprite at `<path>`; its work is now on branch `<jobBranch>` (and in local worktree `<path>` with `--worktree`); the normal tools are available again. Without it, the resumed conversation would keep using remote paths.

### Status and notification (local)

- The window that started a job (same cmux surface, or same pi process outside cmux) reads `status.json` of its active jobs over `sprite exec` every ~45 s, one exec per Sprite. This is free: the Sprite is awake anyway while the hold is live.
- No timing state: each tick reads the current status, so a tick missed during a laptop sleep only delays the warning until it wakes.
- Status line in every window: `☁ 1 running · 1 needs input · 2 done · 1 failed` (zero counts hidden; pulled and aborted jobs are not counted), so a finished job stays visible until it is pulled.
- `/handoff status` opens the job browser (below).
- On `done` / `needs_input` / `error` / `aborted`: an outcome card in the chat of the handed-off session: a custom session entry (`pi.appendEntry` with `registerEntryRenderer`), saved with the conversation and drawn by pi but never sent to the model, with the agent's final message (or the question, or the error) as Markdown, cut after 12 lines unless tool output is expanded. The card goes into whichever conversation the window has open, even if it is not the handed-off one. Also `cmux notify --surface <surface> --title … --body …` (binary at `/Applications/cmux.app/Contents/Resources/bin/cmux` if not on the PATH), status line updated, polling for that job stops. A closed surface fails with `not_found`; the pi that was polling is gone with it, so on `session_start` the local extension also checks every active job once and reports jobs that finished while no pi was watching. Each run's notification is claimed with an exclusive file (`~/.pi-handoff/jobs/notified/`), so several open windows never notify twice.

### Job browser: `/handoff status [filter]`

A full-screen view in the style of `/tree` and `/model` (`ctx.ui.custom`). It works from any pi window, since job records live in `~/.pi-handoff/jobs/`, not in a session.

1. Opens at once on the local records and refreshes the active jobs from the Sprite in the background.
2. Filters follow the job states: all (everything except pulled), running (starting, preparing, running), needs input, done, failed, aborted, pulled. A bar at the top shows them with their counts. Tab and Shift+Tab cycle through them; Ctrl+A/R/N/D/F/X/P jump to one, and the same key again goes back to all. `/handoff status <filter>` opens on that filter.
3. One line per job: id, state, conversation name, branch, age. Jobs waiting on the user (needs input, failed, done) come first, newest first.
4. A preview under the list follows the cursor: state, conversation, branch, times and the first ~8 lines of the last message, question or error.
5. Enter opens the job's actions, only those that fit its state and are built. A finished job (done, needs input, failed, aborted): Show full message (posts the outcome card in the chat), Reply (M3), Pull and open, Pull and stay here (M4). A running job: Abort (M4), which only stops the run (the job becomes `aborted`, to pull or reply to later), and Watch (v2). A pulled job: Open its conversation (M4). Esc goes back to the list; Esc in the list closes it.
6. Without a UI (print or RPC mode) it prints the plain list.
### Reply: `/handoff reply [job] [text]`

Works on any job whose run has ended (done, needs input, failed, aborted): to answer its question, or to ask for more work on the same branch. Refuse while a run is in progress, and once the job is pulled (its Sprite state is gone; continue locally instead). Start a new run of that job with `<text>` as the prompt. The run reuses the job's worktree and session file: pi loads the full history from the session file and appends `<text>` as the next user message. The job defaults to the only one when there is just one.

- On the Sprite, `handoff-reply` takes the uploaded text (from `~/.handoff/incoming/`, so a job that no longer exists gets no stray folder), refuses if a run is in progress, and starts `handoff-run` detached. Config sync runs first, as for a handoff.
- Without text, pi asks: a single question with options offers them in a menu (plus Write a reply…); otherwise an editor, prefilled with the questions when there are several. The job browser's Reply does the same.
- Notifications for the new run go to the window that replied (its cmux surface or pi process), not the one that handed off.
- The outcome card gains `Continue there: /handoff reply <jobId> <text>`.
- A prompt for `/handoff` cannot start with `sync`, `status`, `reply` or `pull`: those words are read as the subcommand.

### Pull: `/handoff pull [job] [--abort] [--switch] [--worktree]`

1. On the Sprite (`handoff-pull`, one exec): if a run is in progress, refuse; with `--abort`, stop it first (`handoff-stop`: TERM to the runner's process group, KILL after 20 s; the runner marks the job `aborted`). Git protocol: commit whatever the agent left uncommitted in the job checkout (`git add -A`, `--no-verify`) and push the job branch (git protocol step 5). Returns the final status.
2. Download the job session file (`sprite file pull`) into the local session directory of the original folder, as `<header timestamp>_<jobSessionId>.jsonl` like pi names its own, so it appears in `/resume` there. Set its header `cwd` to the original folder (or the new worktree with `--worktree`) and append the return briefing as a visible custom message (sent to the model, drawn as one line).
3. Git protocol: fetch the job branch locally (`origin/<jobBranch>`); `--worktree` creates the local branch and a worktree for it (see Local worktrees).
4. Clean up the Sprite (`handoff-clean`, decision 9) only once the session file is safely on the laptop, then mark the job `pulled` with the local session path.
5. `--switch`: open the job session now (`switchSession`, a command-context operation). Otherwise the main session stays active; the job browser's Open its conversation opens it later, as does `/resume`.

## Spikes — verify before building

Each is a short experiment on a real Sprite. Results go back into this plan.

- **S1 Detached runs and the hold.** ✅ Done 2026-10-07. A `setsid nohup … &` process survives `sprite exec` returning, also inside the mount namespace (running as `sprite` at `/Users/marc/<repo>`). Without a hold it ran ~10 s, froze, and resumed with the same pid on the next exec (no reboot). With a hold (5 min expiry, PUT every 60 s) a 5 s ticker ran 150 s without a gap. Tasks API (docs and test): `POST /v1/tasks {name, expire}` (201, 409 if taken), `PUT /v1/tasks/<name> {expire}` upserts and resets `started_at`, `DELETE` releases; `expire` is at most 1 h. The Sprite's state can be read without waking it via `sprite api /v1/sprites/<name>` (`running`/`warm`/`cold`), but it flaps, so don't rely on it. Caveats: a `cold` Sprite drops memory, so frozen processes only survive a `warm` pause; a hold that lapses mid-run can kill the run; run recovery (M5) restarts it from the session file. `pkill -f`/`pgrep -f` match the calling `sh -c` itself; the runner uses pid files. pi across freezes (no hold, Haiku, a `sleep 120` tool call): the Sprite froze ~10 s into the tool call and stayed frozen 194 s until the next exec; an open pi process, an open HTTPS connection and even a streaming LLM response do not keep it awake (the response only advanced during the ~10 s after each exec, so a 2 s answer took 3 min). Each time it woke, pi carried on: the stream survived repeated ~10 s freezes and the run finished cleanly with no errors or retries. So the hold is mandatory for every run, and a short lapse only slows the run down. A long freeze mid-stream (server drops the connection) was not forced; pi's `retry` settings (3 attempts) and `httpIdleTimeoutMs` (300 s) cover it, and a missed heartbeat only happens if the runner itself died.
- **S2 Cloned session resume.** ✅ Done 2026-10-07. A local session (code word plus a `git log` tool call) was cloned: header with a new id and `parentSession` set to the original file, entries on the path from leaf to root, a `session_info` name. Uploaded with `sprite file push` and resumed inside the mount namespace with `pi -p --mode json --session <file>`: the model recalled the code word and the commit hash, `pwd` returned the laptop path and `ls` the job checkout. pi appended to the same file (a new system message for the remote prompt, then the turn) and created no other session file. Pulled back into the local session dir unchanged (no `cwd` rewrite needed), `SessionManager.list` showed it with its name and `parentSessionPath`, and `pi --session <id>` resumed it locally. Findings: inside `sudo unshare` the PATH must be passed through (`env PATH=$PATH`), or `node` (in `/.sprite/bin`) is not found. Back on the laptop the model assumed the remote `ls` ran on the Mac, because the path looks local, which confirms the return briefing is needed.
- **S3 Headless dialogs.** ✅ Done 2026-10-07. In print/JSON mode pi swaps in a no-op UI: `confirm` returns `false`, `select`/`input`/`custom`/`editor` return `undefined`, nothing hangs. Project trust uses the same rule, so an untrusted repo's `.pi/` config is ignored (sync `trust.json`). `rpiv-ask-user-question` removes its tool when `!hasUI`, and two extensions registering the same tool name stop pi from starting, so rpiv is not loaded on the Sprite and a user extension provides `ask_user_question` instead (`remote.replace`, default `~/.pi-handoff/extensions/remote-ask.ts`). Of Marc's extensions, only commands and menus use dialogs (`pi-subagents` settings and wizards, `pi-web-access` `/search`); no tool the agent calls does. Prototype (`/tmp/pi-handoff-prototypes/remote-ask.ts`): writes the questions and returns `terminate: true`; the run ends right after the tool with no follow-up turn, and a resumed run with the answer as the next prompt continues correctly. With options required (min 2), an open question failed validation and the model fell back to a plain-text question, hence options are optional.
- **S4 Extensions on Linux.** ✅ Done 2026-10-07. The full laptop setup was copied (see Config sync) and all 11 packages installed with `pi update --extensions`; the git package `git@github.com:msimon/pi-subagents` needs `git config --global url."https://github.com/".insteadOf "git@github.com:"` so it uses the gh token. pi starts with no load errors. One run with Haiku called each tool once, all without error: `nu` (Linux build 0.108.0 ships as an npm package), `read` with hashline anchors, `ast_search`, `lens_diagnostics` (found the TypeScript error and an ast-grep rule hit), `agent_browser` open + get title (needs `agent-browser` 0.38.2 from npm plus `agent-browser install --with-deps` for Chrome and ~300 MB of libraries), `todo`, and an `Agent` subagent. `web_search` works without keys (falls back to Exa's keyless tier); `~/.pi/web-search.json` holds API keys and is not synced. `fetch_content` on tiny pages fails the same way on the laptop. Not registered in headless mode: `ask_user_question` and `plannotator` (S3). Left on the laptop: `pi-cron-jobs`, `pi-reminders`, and the Keychain or cmux based tools and skills.
- **S5 File transfer.** ✅ Done 2026-10-07. Upload: `sprite exec --file src:dest` and `sprite file push` are both byte-exact (5 MB in ~7 s, upload-bound). Use `sprite exec --file`: it creates missing directories, while `sprite file push` refuses a directory that does not exist and does not see one created in the last few minutes (S4). Download: `sprite file pull` is byte-exact (5 MB in 0.4 s). `sprite exec` stdout is not usable for bulk data: 200 KB already fails with `cannot resume output at byte 0`, and base64 or `--http-post` don't help; keep it for small JSON such as `status.json`. macOS `tar` needs `COPYFILE_DISABLE=1 tar --no-xattrs`, or the tarball carries `._*` files and xattr headers.
- **S6 cmux notify.** ✅ Done 2026-10-07. An extension running `cmux notify --surface $CMUX_SURFACE_ID --title … --body … --json` from `session_start` posted to the exact pane pi runs in (response and `cmux list-notifications` carry that surface and its tab title). A stale surface id fails with `not_found`, exit 1. Prototype: `/tmp/pi-handoff-prototypes/notify.ts`.
- **S7 Base image.** ✅ Done 2026-10-07. Ubuntu 26.04 x86_64, 8 vCPU, 8 GiB RAM visible, 99 GB disk. Runs as user `sprite` (uid 1001, home `/home/sprite`) with passwordless `sudo`. Preinstalled: Node 24, npm, bun, Python 3.13, uv, Go 1.25, git, `gh`, jq, curl, tmux, `unshare`, Claude Code, Codex and **pi 0.84.4** (with a `~/.pi`). Missing: pnpm, ripgrep, fd, ast-grep, nu, docker. Tasks API socket at `/.sprite/api.sock` answers `{"tasks":[]}`; `sprite-env` at `/.sprite/bin/sprite-env`. Bootstrap must upgrade pi to the laptop's version (1.0.4) so session files are compatible, and install the missing tools.
- **S8 Snapshot commit.** ✅ Done 2026-10-07 (local). Copy `.git/index` to a temp file, `GIT_INDEX_FILE=<tmp> git add -A && git write-tree`, then `git commit-tree <tree> -p HEAD`. Captures modified, staged, partially staged (the working-tree version wins), untracked and deleted files; ignored files such as `.env` are excluded, as intended. Afterwards `git status`, the real index (byte-identical), `HEAD` and all refs were unchanged, and no hooks ran. On a clean tree the tree equals `HEAD^{tree}`, so no snapshot is made.
- **S9 Mount namespace.** ✅ Works, 2026-10-07. `sudo unshare --mount --propagation private` + `mount --bind ~/jobs/<job>/proj /Users/marc/proj`, then `setpriv --reuid=sprite --regid=sprite --init-groups` to drop back to the `sprite` user. Two concurrent jobs each saw their own checkout at the same `/Users/marc/proj` path, wrote into their own job dir, and the path stayed empty outside the namespaces. Decision 4 uses the namespace; the path rule and rewrite hook are not needed. Unprivileged `unshare -rm` also works, but would make pi run as a mapped root, so the sudo + setpriv form is preferred. Still to confirm in S1: a detached runner inside the namespace survives `sprite exec` returning.
- **S10 Briefing behavior.** ✅ Done 2026-10-08, during M2. The model followed the briefing: it worked at the laptop path, recalled the history, ran the install command itself (`npm install`), committed and pushed only the job branch, and ended with a summary that became the notification. The first git run did not open a PR ("open a PR when ready" was too soft); after the briefing asked for `gh pr create … --fill` and the URL in the final message, it did. With `remote-ask.ts` loaded, Sonnet asked through `ask_user_question` (`needs_input`); Haiku asked in plain text, so the run ended `done` with the question as the notification text.

## Milestones

- **M0 Account and Sprite** (Marc + agent): ✅ Done 2026-10-07. Fly account with Sprites, `sprite login`, `sprite create pi-handoff --skip-console`. Bootstrap: Node 24.21.0 as the nvm default (matches the laptop); pi 1.0.4 via `curl -fsSL https://pi.dev/install.sh | sh` (managed install, `pi update` later; never `npm install -g`); pnpm and ast-grep via `npm install -g --prefix ~/.local` (nvm's global bin is not on the PATH); ripgrep and fd from apt (`fd` linked to `fdfind`); `LANG`/`LC_ALL=C.UTF-8` in `~/.profile`; git identity Marc Simon; model auth via `/login` in `sprite exec --tty -- pi` (Anthropic and Codex, Sprite-only tokens); `gh auth login` + `gh auth setup-git`. Checkpoint `v4` (`base`). Then Marc's pi config, the 11 packages, `agent-browser` 0.38.2 with Chrome and the `en_GB.UTF-8` locale (S4): checkpoint `v6`.
- **M1 Spikes**: ✅ Done 2026-10-07. S1–S9 verified on the Sprite (results above); S10 done during M2.
- **M2 Push + run + notify** (git protocol): ✅ Done 2026-10-08. Repo skeleton and the `~/.pi-handoff/sprite/` install builder, `/handoff`, config sync and `/handoff sync`, `handoff-run`, remote extension with the remote briefing, `examples/remote-ask.ts`, polling, outcome card, status line, job browser (`/handoff status`), S10. Tested end to end against `msimon/pi-handoff-e2e` (snapshot commit, `.env` copied, clone, worktree, namespace, `npm install`, commit, push, PR #1, `node_modules` cache reused) and without git (done, needs_input, error), then from the interactive TUI in cmux (progress line, start message, outcome card).
- **M3 Reply**: ✅ Done 2026-10-08. `/handoff reply`, the Reply action in the job browser, the card line. Tested from a script on one git job: it asked with options (`needs_input`), the reply `minus` led to the commit and push (`done`), a further reply ran `sleep 600` and was aborted, and a reply after the abort resumed the conversation and answered. Four runs on the same checkout and branch, no re-clone.
- **M4 Pull**: ✅ Done 2026-10-08. Refusal, `--abort`, session file with return briefing, `--switch`, `--worktree`, cleanup. The outcome card gains `Bring it back: /handoff pull <jobId> --switch`; the job browser gains Pull and open, Pull and stay here, Abort and Open its conversation. Built 2026-10-08 and tested from scripts against `msimon/pi-handoff-e2e`: a done job with uncommitted leftovers (committed and pushed at pull, local working tree untouched, Sprite cleaned, the model read the return briefing correctly), a running job (pull refused, Abort stopped pi and its `sleep` tool in ~1 s, no hold left), and an aborted job pulled with `--worktree`. In pi itself: the browser's Pull and open and Open its conversation work (2026-10-08). Still to try: resuming a `--worktree` session from `/resume`.
- **M5 Hardening**: concurrent jobs, README. Run recovery: a Sprite service `handoff-recover` (services restart at boot) finds jobs whose `status.json` says `running` but whose runner pid is dead, for example after a `cold` pause dropped memory, and restarts each runner on the same session file with a "You were interrupted; check the state and continue" prompt. The session file keeps everything up to the last completed step. A retry limit per job stops a crash loop; past it the job is marked `error`.

## Open questions

- **Git repo without `origin`**: refuse, or fall back to `git bundle` over `sprite exec`.

## v2

- `/handoff watch`: overlay (`ctx.ui.custom`, like `/btw`) following `events.jsonl` over `sprite exec`; closing it stops the follow so the Sprite can sleep. Also the Watch action on running jobs in the job browser.
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
