# pi-sprites-detach: architecture

How pi-sprites-detach works inside, why it is built this way, and what was learned about Sprites and pi while building it. For installing and using it, see the [README](../README.md).

## Design decisions

1. **One shared Sprite, several concurrent jobs.** The Sprite is recorded per job, so per-job Sprites could be added later without touching anything else.
2. **The conversation splits like `/clone`.** A job runs on a copy of the session's active branch (`createBranchedSession`) with its own session id, `parentSession` pointing at the main session, and the name `<session name> [<jobId>]`. The main session and the working tree are never modified by a detach.
3. **Detaching happens between runs.** pi must be idle, or the current run aborted. Moving an agent mid-run is a non-goal.
4. **Each job has its own checkout and sees it at the laptop path.** Each job's pi runs in its own mount namespace with the checkout bind-mounted at the original laptop path, so paths in the conversation history stay valid and nothing is rewritten.
5. **The remote pi runs headless**: `pi -p --mode json --session <file> "<prompt>"`. Runs are sequential within a job and parallel across jobs.
6. **The Sprite is held awake only while pi works**, through the Sprites Tasks API. When the run ends the Sprite pauses and stops billing compute.
7. **Notifications land in the window that started (or last replied to) the job**: an outcome card in the chat plus `cmux notify` to that pane.
8. **Nothing is implicit.** Pull refuses while a run is in progress (`--abort` is explicit); drop and cleanup ask first; the model can never merge, drop, or delete on origin.
9. **Pull cleans up the Sprite.** The session file, copied project files, transfer files, state dir and worktree go; the repo's cached clone and the `node_modules` cache stay warm.

## Components

The repository holds sources; the install is what runs. The Sprite part is a self-contained folder synced as-is.

```
pi-sprites-detach/            (repository)
  src/local/        laptop extension: commands, tools, config sync, status line, polling, notifications, job browser, watch view
  src/remote/       extension loaded only for job runs on the Sprite: briefing, final message
  sprite/bin/       detach-run, detach-start, detach-stop, detach-reply, detach-pull, detach-clean, detach-join, detach-joined, detach-attach, detach-watch, detach-sync-apply, lib.sh
  sprite/setup/     bootstrap.sh, install-tool.sh, tools/<name>.sh recipes for optional CLI tools
  examples/         user extensions the default config refers to (remote-ask.ts)
  skills/detach/    the skill that teaches the model when and how to use the detach_* tools

~/.pi-sprites-detach/         (laptop install)
  config.json       user config, written with defaults on first run, never overwritten
  extensions/       user extensions for the Sprite, e.g. remote-ask.ts (synced)
  jobs/             one record per job
  sprite/           built from the package: bin/, setup/, extension/ (src/remote as .ts, no build step), manifest.json { version, hash }
```

pi has no install hook, so the local extension builds `~/.pi-sprites-detach/sprite/` itself on `session_start` and before every sync, whenever it is missing or the package's files changed (content hash). The Sprite gets an exact copy at the same path, replaced wholesale on update, so it never holds state. Job state on the Sprite lives in `~/.detach/`.

## State

**Laptop**, one record per job at `~/.pi-sprites-detach/jobs/<jobId>.json`. Job ids are `d` + a lowercase base-36 counter (d1 … d9, da … dz, d10 …; older jobs start with `h`), reserved by creating the record exclusively. A reserved record is `{}` until the push finishes, so readers skip it.

```json
{
  "jobId": "d3",
  "sprite": "pi-sprites-detach",
  "protocol": "git | none",
  "folder": "/Users/<you>/<project>",
  "mainSessionFile": "/Users/<you>/.pi/agent/sessions/…/….jsonl",
  "forkLeafId": "<entry id the job split from>",
  "jobSessionId": "<uuid>",
  "jobBranch": "feat/x-detach-1",
  "jobRoot": "/home/sprite/jobs/d3",
  "baseHead": "<sha>",
  "snapshotSha": "<sha of the snapshot commit, when there was uncommitted work>",
  "pr": "auto | never",
  "wayBack": "fast-forwarded | pr | worktree | pending | manual",
  "wayBackText": "<what happened or what to do>",
  "jobHead": "<job branch tip at pull>",
  "surface": "<CMUX_SURFACE_ID>",
  "state": "starting | preparing | running | joined | done | needs_input | error | aborted | pulled | dropped",
  "startedAt": "…"
}
```

`forkLeafId` is what tells the job's own entries apart from the shared history (for `pull --here`); comparing against the main session file fails once that file is gone.

**Sprite**, per job at `~/.detach/<jobId>/`:

- `job.json`: folder, mount point, checkout, branch, clone URL, PR policy; read by `detach-run` and the remote extension.
- `session.jsonl`: the job's conversation; every run appends to it, pull downloads it.
- `prompt.txt`: the prompt for the next run.
- `status.json`: `{ jobId, state, runStartedAt, runEndedAt, exitCode, lastAssistantText, question, error }`, written only by the runner. `preparing` covers setup before pi starts, so a setup failure reads as such.
- `question.json` (written by the `ask_user_question` replacement) and `result.json` (final assistant text, written by the remote extension): merged into `status.json` when pi exits.
- `events.jsonl`: pi's JSON event stream, appended per run; feeds `/detach watch`.
- `runner.pid` (pid and start time), `runner.log`, `stop` (abort marker).

## Git protocol

Applies when the folder is inside a git work tree with an `origin` remote and at least one commit. Other folders are conversation-only: the job gets an empty folder and is told the local files are not there.

1. **One branch per job, on `origin` only**: `<current-branch>-detach-<n>`, pushed with `git push --no-verify origin <sha>:refs/heads/<jobBranch>` (a work-in-progress snapshot would trip pre-push hooks). No local branch is created. Concurrent detaches race for `<n>` with an empty `--force-with-lease` and `--porcelain`: a push counts only if it created the branch, otherwise try the next number.
2. **Uncommitted work travels as a snapshot commit**, built with a temporary index: copy `.git/index` (keeping its timestamps, see Platform learnings 19), `GIT_INDEX_FILE=<tmp> git add -A`, `git write-tree`, `git commit-tree <tree> -p HEAD`. It captures modified, staged, partially staged (working-tree version wins), untracked and deleted files, excludes ignored files, runs no hooks, and leaves the real index, working tree and refs untouched. A clean tree gives `HEAD^{tree}`, so no snapshot is made.
3. **Ignored-but-wanted files** (`copyProjectFiles`, default `.env*` and `.scratch/`) travel as a tarball, never committed. `node_modules/` and `.venv/` are never copied.
4. **On the Sprite** each repo has one cached clone at `~/repos/<owner>/<repo>` (`git clone --filter=blob:none`), guarded by a per-repo `flock`. Each job fetches its branch and gets its own worktree. For npm projects the cached `node_modules` for that repo and lockfile hash is copied in; dependencies are otherwise installed by the agent.
5. **Base branch for a PR** (`pr: auto` only), checked before anything syncs: missing or behind on origin, push `HEAD` to it (hooks run, never forced); ahead or diverged, ask to continue without a PR or cancel. Without this check, an unpushed base made the agent open its PR against `main`.
6. **On pull**, leftovers on the Sprite are committed and pushed, then the work comes back by its **way back** (`src/local/wayback.ts`):
   - `pr: auto`: open PR, nothing changes locally; merged, `git pull`; none or closed, fast-forward as below.
   - **Fast-forward**, only when the folder is on the base branch and `HEAD` is still `baseHead`. With S = snapshot or `baseHead`, W = the folder's tree now, J = the job tip: `git merge-tree --write-tree --merge-base S J W` merges without touching anything, then `update-ref` (refused if the branch moved), `read-tree W` + `read-tree -m -u W R`, `reset -q`. Edits made since detaching stay on top, uncommitted. A conflict, or a result that would overwrite an ignored file (`read-tree -u` does so silently), changes nothing. Nothing is pushed.
   - Otherwise `pending` (retried by `/detach pull <job>` without the Sprite) or `manual` (local commits since detaching, detached `HEAD`, or a job branch that no longer builds on `baseHead`).
7. `pull --worktree` checks the job branch out at `~/pi-sprites-detach/worktrees/<repo>/<jobId>`. The session file stays in the original folder's session directory with the worktree as its `cwd`, so `/resume` there lists it; started inside the worktree, `/resume` does not find it.

## Flows

**Detach** (`/detach [prompt]`, or `detach_start`):

1. Wait for idle (`detach_start` instead forks at the last completed assistant message, like `/split`, so the job never sees the turn that called it).
2. Config sync, first, so a failed sync never leaves a pushed job branch behind. Refuse a repo whose lockfile names a package manager that is not in `remote.tools`.
3. Prepare the workspace (git protocol 1–3). The folder is the session header's `cwd`, not `process.cwd()`: they differ through symlinks (`/tmp` is `/private/tmp`), and pi refuses to resume a session whose `cwd` does not exist.
4. Create the job session, upload it with `job.json`, `prompt.txt` and the copied files into a staging folder that becomes the state dir.
5. Start the run as the Sprite service `detach-<jobId>` and return immediately. Default prompt: "Continue where we left off."

**Config sync.** The laptop is the source of truth. What syncs is `sync.paths` minus `sync.exclude`, plus `settings.json` rewritten for the Sprite: the `remote.exclude` / `remote.replace` rules applied, extension paths outside `sync.paths` dropped (the file would not exist there), and laptop home paths mapped to `/home/sprite/`. `auth.json`, sessions, caches and logs never sync; the Sprite's own logins are never overwritten. The synced set is hashed and compared with `~/.detach/sync/applied.json`, so an unchanged setup costs one small read. A change uploads a tarball and starts `detach-sync-apply` detached, which unpacks over the Sprite's home, runs `pi update --extensions` only if the package list changed, installs `remote.tools` whose version differs from the laptop's, and reports progress in `~/.detach/sync/state.json`. Only files a previous sync wrote are ever deleted. Concurrent windows take turns through a laptop lock (`~/.pi-sprites-detach/sprite.lock`) and a `flock` on the Sprite.

**Run** (`detach-run <jobId>`, on the Sprite):

1. Create the Tasks API hold `detach-<jobId>`, start the heartbeat, `trap` releases it on any exit.
2. `preparing`: clone if needed, fetch, `git worktree add -B`, unpack copied files, restore the `node_modules` cache.
3. `running`: `sudo unshare --mount --propagation private`, bind-mount the checkout at the laptop path, `setpriv --reuid=sprite --regid=sprite --init-groups` back to the `sprite` user, `env PATH=$PATH`, then pi with `-e ~/.pi-sprites-detach/sprite/extension/index.ts` and `DETACH_JOB_ID` / `DETACH_DIR`.
4. On exit: save the `node_modules` cache for a new lockfile hash; `needs_input` if `question.json` exists, else `done` or `error`; release the hold; delete the service.

**Recovery.** The run is the Sprite service while it lasts, so the runtime restarts `detach-run` after an environment restart, a checkpoint restore, or a killed runner. The restarted runner finds `preparing` (starts setup over) or `running` (waits for any pi still alive, records its outcome, or resumes with "your previous run was interrupted; check the state and continue"). Two interruptions per run, then `error`. Every intended ending deletes the service; `detach-stop` first leaves a `stop` marker so the runner records `aborted`.

**Status.** Each window polls `status.json` of its active jobs every ~45 s over `sprite exec`, one exec per Sprite (free while the hold keeps the Sprite awake). Each tick reads current state, so a tick missed during laptop sleep only delays the card. On `session_start` every active job is checked once, which reports jobs that finished while no pi was open. Each run's notification is claimed with an exclusive file in `~/.pi-sprites-detach/jobs/notified/`, so several windows never notify twice. A pull or drop whose Sprite cleanup fails marks `cleanupPending`, which the poll retries (`detach-clean` is idempotent).

**Reply.** A new run on the same worktree and session file with the text as the next user message. Refused during a run and after pull. Notifications go to the window that replied.

**Pull.** Commit and push leftovers on the Sprite, download the session as `<timestamp>_<jobSessionId>.jsonl` into the original folder's session directory, set its `cwd`, run the way back, append the return briefing, then clean the Sprite only once the session file is safely on the laptop. `--here` summarizes the job's own entries with pi's branch summarizer (`generateBranchSummary`, as `/tree` does) and adds it as a custom message with the final message, `git log` and `git diff --stat`, and the path of the full conversation. Nothing is merged.

**Drop.** Ask first, stop a run if needed (a run that started after the question is not stopped: refuse), download the conversation before deleting anything, delete the job branch on origin (unless `--keep-branch`), save the conversation with a briefing saying the work was discarded, clean the Sprite. No model tool: dropping discards work.

**Attach** (built as join). `detach-join` starts `detach-joined` as the only program of a detached tmux session, which runs interactive pi on the job's session inside the namespace with `DETACH_JOINED=1`. The laptop opens a cmux split running `sprite exec --tty … detach-attach <jobId>`. tmux means a dropped connection or closed pane does not kill pi. The remote extension checks every 5 s: idle (from `agent_start` / `agent_end`) with no `tmux list-clients` on two checks in a row calls `ctx.shutdown()`, so closing the pane mid-turn lets the turn finish. With nobody ever attached, pi quits after 2 minutes. A joined pi is not a service (it cannot resume without the user), so a `joined` state whose wrapper is gone is repaired to `done`.

**Watch.** `detach-watch` prints `events.jsonl` from the last session header and follows it with `tail -F` while the run lasts. The laptop runs it with `sprite exec --no-stdin` and kills that process to stop, which ends the remote `tail` within 2 s. `src/local/transcript.ts` folds pi's JSON events into blocks; the view ignores the system-prompt copies (most of the bytes).

## Briefings

**Remote briefing**, a system prompt section on every remote run: running unattended as job `<jobId>`, the user is away (or present, when joined); no dialogs, make reasonable decisions and list assumptions; files are the job branch's checkout at the laptop path, and nothing outside the project folder is there; which tools and skills are unavailable and why; work only on the job branch, commit and push as you go, never force-push, open a PR with `gh pr create --base <base> --fill` and give its URL (when `pr: auto`); dependencies are not installed, run `<install command>` first; only a GitHub token and web search are available; end with a short summary, which becomes the notification. Committing applies even if the user said earlier not to commit yet: pushing the job branch is how the work gets back.

**Return briefing**, appended to the job session on pull: the job ran on the Sprite, where its work is now (per the way back), and the normal tools are available again. Without it the resumed conversation assumes remote output came from the laptop, because the paths look local.

## Platform learnings

Sprites:

1. **A Sprite freezes ~10 s after the last `sprite exec`**, whatever is running: an open pi process, an HTTPS connection, even a streaming LLM response do not keep it awake. Frozen processes resume in place on the next exec (only from a `warm` pause; `cold` drops memory). So every run needs a Tasks API hold. pi survives repeated freezes mid-stream without errors; a lapse only slows it down.
2. **Tasks API**: `POST /v1/tasks {name, expire}` (201, 409 if taken), `PUT /v1/tasks/<name> {expire}` upserts and resets the clock, `DELETE` releases; `expire` is at most 1 h. Use 5 min refreshed every 60 s, and never a hold without an expiry. The socket is at `/.sprite/api.sock`.
3. **Sprite state** can be read without waking it (`sprite api /v1/sprites/<name>`), but it flaps; do not rely on it.
4. **Services**: same environment and pid namespace as `sprite exec`. Any exit restarts them, `exit 0` included, so a run-once boot script does not work; the run itself is the service. The runtime waits until every process of the service is gone before restarting. A quiet service does not keep the Sprite awake (contrary to the Sprite's own `services.md`). `stop` is sticky. A checkpoint restore restarts the environment like a cold boot with the same boot id, so liveness checks use pid plus start time.
5. **File transfer**: use `sprite exec --file src:dest` for uploads (creates missing directories; `sprite file push` refuses a directory created in the last few minutes). Uploads lose the executable bit. `sprite file pull` is byte-exact and fast for downloads. `sprite exec` stdout fails on bulk data (~200 KB, `cannot resume output at byte 0`); keep it for small JSON.
6. **macOS tarballs** need `COPYFILE_DISABLE=1 tar --no-xattrs`, or they carry `._*` files and xattr headers.
7. **Long installs** (`pi update`, apt, tools) run detached under their own hold, never inside one `sprite exec`: a dropped exec session kills them.
8. **Mount namespace**: `sudo unshare --mount --propagation private` + `mount --bind` + `setpriv` works, and concurrent jobs each see their own checkout at the same path. Unprivileged `unshare -rm` works too but runs pi as a mapped root. Inside `sudo unshare` the PATH must be passed through, or `node` (in `/.sprite/bin`) is not found.
9. **Base image** (checked 2026-10): Ubuntu x86_64, 8 vCPU, 8 GiB, user `sprite` with passwordless sudo; Node, npm, bun, Python, uv, Go, git, `gh`, jq, tmux, and an old pi preinstalled. Missing: pnpm, ripgrep, fd, ast-grep. The bootstrap deletes the image's npm-installed pi (its migration hangs on the overlay with EXDEV) and installs the laptop's pi version so session files are compatible. nvm's global bin is not on the PATH, so global npm tools go to `--prefix ~/.local`. The `node` shim recurses through `npm --version` when nvm's bin is on the PATH after `/.sprite/bin`.
10. **Git over SSH URLs**: git packages like `git@github.com:…` need `git config --global url."https://github.com/".insteadOf "git@github.com:"` to use the `gh` token.
11. **`pkill -f` / `pgrep -f`** match the calling `sh -c` itself; use pid files.

pi:

12. **Headless dialogs**: in print/JSON mode `confirm` returns `false` and `select` / `input` / `custom` / `editor` return `undefined`; nothing hangs. Project trust follows the same rule, so `trust.json` must sync or a repo's `.pi/` config is ignored.
13. **Two extensions registering the same tool name stop pi from starting.** `rpiv-ask-user-question` hides its tool without a UI, so the Sprite gets `remote-ask.ts` instead: it writes `$DETACH_DIR/question.json` and returns `terminate: true`, which ends the run right after the tool. Options must be optional: requiring them made the model fall back to a plain-text question. Sonnet uses the tool; Haiku sometimes asks in plain text, which ends the run `done` with the question as the text.
14. **Cloned sessions resume anywhere**: a branched session file uploaded and resumed with `pi -p --mode json --session <file>` recalls the history, appends to the same file, and needs no `cwd` rewrite when pulled back.
15. **Briefing wording matters**: "open a PR when ready" was too soft; asking for `gh pr create … --fill` and the URL in the final message worked.
16. **pi's JSON mode output** repeats the full system prompt per run (~150 KB each), so a tiny run is ~450 KB of events.
17. **`plannotator` and `ask_user_question`** are not registered headless. `web_search` works without keys (keyless fallback).
18. **Ctrl+J is newline**, which pi's key matcher also reads as Enter; do not bind it.

git:

19. **Racy git with a temporary index**: a copied index stamped "now" makes git trust stale stat data and miss a same-size edit made in the same second. Keep the index's timestamps when copying it (`copyIndex`).

## Limits and risks

- Keychain-backed skills (Google, Gmail, Notion's `ntn`, gcalcli) do not work on the Sprite. Later: Sprite-only tokens, with each skill falling back to an environment variable or file when no Keychain is available.
- The job's conversation (tool outputs included) sits on Fly until pull. Be careful with client or patient data.
- If the mount namespace ever stops working, the fallback is a briefing rule (laptop folder now lives at `<jobRoot>/<folder>`) plus a `tool_call` hook rewriting paths; bash commands are harder to rewrite safely than path arguments.
- Cost: Sprite compute is billed only while running (about $0.038/CPU-hour plus $0.021875/GB-hour of memory used, plus storage), roughly $0.05–0.10/hour for a working pi. LLM tokens dominate.

## Ideas not built

- A live mode (`--mode rpc` on the Sprite) that forwards remote dialogs to the laptop, for when the user stays around. Not the default: a run waiting on a dialog holds the Sprite awake with nobody to answer.
- Sprite credentials for Keychain-backed skills (see Limits).
- A git repo without `origin`: refuse today; could fall back to `git bundle` over `sprite exec`.
- Dropped: answering from the notification (`cmux notify --reply`), non-git folders as a tarball round trip, joining a running headless job.
