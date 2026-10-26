# pi-sprites-detach

Detach a [pi](https://pi.dev) conversation from your laptop to a cloud machine (a [Fly.io Sprite](https://sprites.dev)), close the laptop, and let the agent keep working. When it finishes or has a question, the pi window you detached from shows a card (and a cmux notification). Reply to it from the laptop, or pull the work and the conversation back.

```text
/detach finish the migration and open a PR
```

The conversation splits like `/clone`: the job continues on the Sprite with a copy of the conversation, while your local session and working tree stay exactly as they were.

Formerly pi-handoff. Updating from it: the first pi start moves `~/.pi-handoff/` to `~/.pi-sprites-detach/` and updates the config's paths, and the next sync moves the Sprite's state the same way (your Sprite keeps its name). Restart every open pi window after updating. `/handoff` is now `/detach`, `/handoff join` is `/attach`, the tools are `detach_*`, and new job ids start with `d`; old jobs, worktrees and conversations keep working.

## Requirements

- pi 1.0.4 or later on a Mac (cmux is optional; notifications fall back to the pi window).
- A Fly.io account with Sprites, and the `sprite` CLI logged in (`sprite login`).
- For code work: a git repo with an `origin` remote the Sprite can reach. GitHub works out of the box through the `gh` token on the Sprite.

## Setup

Install the package in pi, then start pi once. That writes `~/.pi-sprites-detach/config.json` and builds `~/.pi-sprites-detach/sprite/`, the folder that gets installed on the Sprite.

```sh
pi install git:git@github.com:msimon/pi-sprites-detach
```

Then paste this prompt into pi. It sets up the Sprite with only what pi-sprites-detach needs, and asks before adding any optional tool:

```text
Set up a Fly.io Sprite for pi-sprites-detach.

1. Read the Sprite name from "sprite" in ~/.pi-sprites-detach/config.json (default pi-sprites-detach). Check that the sprite CLI is logged in (sprite list) and create the Sprite with `sprite create <name> --skip-console` if it does not exist.
2. Install pi-sprites-detach's files on it and start the bootstrap detached (it installs Node at my laptop's version, pi, a UTF-8 locale and git settings, nothing else):
     cd ~/.pi-sprites-detach && COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/pi-sprites-detach-sprite.tgz sprite
     sprite exec -s <name> --file /tmp/pi-sprites-detach-sprite.tgz:/tmp/pi-sprites-detach-sprite.tgz -- bash -c 'mkdir -p ~/.pi-sprites-detach && tar -xzf /tmp/pi-sprites-detach-sprite.tgz -C ~/.pi-sprites-detach || exit 1
       setsid nohup ~/.pi-sprites-detach/sprite/setup/bootstrap.sh "$0" >~/bootstrap.log 2>&1 </dev/null &' "$(node --version | tr -d v)"
   Then check ~/bootstrap.log on the Sprite every 20 seconds or so (short sprite exec calls) until it ends with "== done", and report any error.
3. The files in ~/.pi-sprites-detach/sprite/setup/tools/ are recipes for optional CLI tools. Check which of them are installed on this laptop (`<tool> --version`), show me the list, and ask which ones to add to "remote.tools" in ~/.pi-sprites-detach/config.json. Do not install anything yourself: /detach sync installs them at my laptop's versions.
4. Finish by telling me which logins to do on the Sprite (they are interactive, so I run them) and to run /detach sync after them.
```

Or by hand:

1. Create the Sprite: `sprite create pi-sprites-detach --skip-console`.
2. Bootstrap it. It takes a minute or two, so it runs detached and logs to `~/bootstrap.log` on the Sprite:

   ```sh
   cd ~/.pi-sprites-detach && COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/pi-sprites-detach-sprite.tgz sprite
   sprite exec -s pi-sprites-detach --file /tmp/pi-sprites-detach-sprite.tgz:/tmp/pi-sprites-detach-sprite.tgz -- bash -c \
     'mkdir -p ~/.pi-sprites-detach && tar -xzf /tmp/pi-sprites-detach-sprite.tgz -C ~/.pi-sprites-detach || exit 1
      setsid nohup ~/.pi-sprites-detach/sprite/setup/bootstrap.sh "$0" >~/bootstrap.log 2>&1 </dev/null &' "$(node --version | tr -d v)"
   ```

3. Optional tools: add the ones your extensions use to `remote.tools` in the config (see Config).

Either way, finish with the logins, which are interactive:

1. **Model provider**: the agent on the Sprite needs its own login to the model provider you use, most likely Anthropic and/or OpenAI (Codex). Run pi there and `/login` to each one:

   ```sh
   sprite exec -s pi-sprites-detach --tty -- pi
   ```

   These tokens belong to the Sprite, separate from your laptop's, so you can revoke them on their own.

2. **GitHub**, so the Sprite can clone your repos and push the job branches:

   ```sh
   sprite exec -s pi-sprites-detach --tty -- bash -lc 'gh auth login && gh auth setup-git'
   ```

Then run `/detach sync` in pi. It copies your pi setup to the Sprite (see Config), installs your packages there, and installs the tools in `remote.tools`.

## Commands

| Command | What it does |
| --- | --- |
| `/detach [prompt]` | Detach this conversation. Without a prompt, the agent is told to continue where you left off. |
| `/detach status [filter]` | Open the job browser. Filters: `all`, `running`, `joined`, `needs-input`, `done`, `failed`, `aborted`, `pulled`, `dropped`. |
| `/detach reply [job] [text]` | Start another run of a finished job: answer its question or ask for more work. Without text, pi asks (a question with options shows them as a menu). |
| `/detach pull [job] [--here] [--switch] [--abort] [--worktree]` | Bring a job back: its conversation becomes a local session, its work comes back, and the Sprite is cleaned up. The folder's branch is fast-forwarded to the job's work when it is still on that branch at the commit the job started from (edits made since stay on top, uncommitted; conflicting ones stop it); with a pull request (`pr: auto`), the PR is the way back. When the work cannot come back yet (another branch checked out, conflicts), nothing changes and `/detach pull <job>` again retries. `--worktree` checks the job branch out in a worktree instead. |
| `/attach [job] [--abort]` | Work with a job's agent live on the Sprite, without pulling: pi opens in a cmux split next to this pane (outside cmux, pi-sprites-detach prints the command to run in any terminal). Close the pane whenever you like: the agent finishes its turn, pi quits once nobody is attached, and the usual card appears. `--abort` stops a headless run first; without it pi asks. |
| `/detach watch [job]` | Follow a run as it happens, read-only, in a full-screen view: the agent's text, its tool calls with their output. On a finished job still on the Sprite it replays its last run. Scroll with ↑/↓ and PgUp/PgDn, `End` follows the latest line, `t` shows or hides the thinking (hidden by default), `e` unfolds the tool output, `Esc` closes (that stops the stream; the job keeps running). Not for a joined job: attach to it with `/attach`. |
| `/detach cleanup [job] [--discard] [--remote]` | Remove what a pull left on this laptop for a job: its worktree (from `pull --worktree`), the local branch made for it, and the fetched `origin/<branch>`. Only when its work is merged into the base branch (a squash-merged pull request counts), and not over uncommitted changes in the worktree; `--discard` removes it anyway. `--remote` also deletes the branch on origin. It shows what it will remove and asks first. The job's conversation is kept. |
| `/detach drop [job] [--keep-branch]` | Discard a job you don't want, running or finished: a run in progress is stopped first (abort and drop in one), its work is not brought back, its branch is deleted on origin (`--keep-branch` keeps it), and it is removed from the Sprite. Its conversation is still saved with this folder's sessions, and the job shows under the `dropped` filter. Your folder is never touched. It asks first. To stop a run but keep its work, abort instead. |
| `/detach sync` | Bring the Sprite in line with your pi setup now (detach, reply, pull, attach and drop do this first anyway). |

The job id can be left out when only one job fits; otherwise pi asks. A `/detach` prompt cannot start with `sync`, `status`, `reply`, `pull`, `watch`, `cleanup` or `drop`, since those words are read as the subcommand.

Pull options:

- `--here`: also bring the job's context into this conversation, so you can continue here as if it had done the work: a summary of what it did, learned and decided (made with your current model, like `/tree` summarizes a branch you leave), its final message, its commits and changed files, and where its full conversation is saved. The code stays on the job branch until you ask for it. Works on a job you already pulled, too.
- `--abort`: a run in progress is stopped first. Without it, pull refuses while the job is running.
- `--switch`: open the job's conversation right away. Otherwise it is listed in `/resume` and in the job browser.
- `--worktree`: also check the job branch out in a local worktree, `~/pi-sprites-detach/worktrees/<repo>/<job>`. The conversation then works there. Open it from `/resume` in the original folder: the worktree has its own session list, where it does not appear.

## The model can drive it too

The package also installs a skill and seven tools, so you can say "I have to leave, detach this" or "what did d3 find?" and the model does it:

| Tool | What it does | Asks you first |
| --- | --- | --- |
| `detach_status` | Lists jobs, or shows one in full | no |
| `detach_reply` | Answers a finished job or asks it for more work | no |
| `detach_pull` | Brings a job back and returns a summary of what it did (like `pull --here`) | yes |
| `detach_attach` | Opens a live session on a finished job | only to stop a run |
| `detach_abort` | Stops a run in progress | yes |
| `detach_cleanup` | Removes a pulled, merged job's worktree and local branches (never anything on origin, and never unmerged work: that stays a command you type) | yes |
| `detach_start` | Detaches the current work | yes |

"Asks you first" is a yes/no dialog in pi; without a UI the tool refuses. `detach_start` forks the conversation at the model's last finished message, as `/split` does, so the job does not see the turn that called it: the model puts what the job needs in the prompt, and tells you it detached and stops. The tools are not loaded on the Sprite.
## What you see

- **Status line**: `☁ 1 running · 1 needs input · 2 done`, counting every job not yet pulled.
- **Outcome card**: when a run ends, a card in the open conversation with the agent's last message or its question, plus how to continue (`/detach reply …`) or bring it back (`/detach pull … --switch`). Cards are never sent to the model.
- **cmux notification** to the pane that detached (or replied), when run inside cmux.
- **Job browser** (`/detach status`): ↑/↓ to move, Tab/Shift+Tab to cycle filters, Ctrl+A/R/O/N/D/F/X/P/T to jump to one (O is for joined, T for dropped), Enter for the job's actions (reply, attach on the Sprite, show the full message, watch it, pull with its context into this conversation, pull and open, pull and stay, abort a run, open a pulled conversation or bring its context here, clean up a pulled job's worktree and branch), Esc to close. A joined job is counted apart from the running ones: `☁ 1 running · 1 joined`.

## Config

`~/.pi-sprites-detach/config.json`, written with the defaults on first run:

```json
{
  "sprite": "pi-sprites-detach",
  "pr": "never",
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
      "~/.pi-sprites-detach/extensions"
    ],
    "exclude": ["**/.venv", "**/node_modules", "**/__pycache__", "**/.DS_Store", "**/*.lock"]
  },
  "remote": {
    "exclude": ["msimon/pi-sprites-detach"],
    "replace": { "npm:@juicesharp/rpiv-ask-user-question": "~/.pi-sprites-detach/extensions/remote-ask.ts" },
    "tools": []
  },
  "copyProjectFiles": [".env*", ".scratch/"]
}
```

- `sprite`: the Sprite for new jobs.
- `pr`: `never` (default) means no pull request: pull fast-forwards your branch to the job's work. `auto` asks the agent to open a pull request against your branch when the work is pushed; the branch is pushed to origin first if it is missing there or behind, and if origin has commits you lack, pi asks whether to go without a PR or cancel and `git pull` first.
- `sync.paths`: exactly what is copied to the Sprite. Your `settings.json` always syncs as well, rewritten for the Sprite (the `remote` rules, home paths). A local extension runs on the Sprite only if its folder is listed here.
- `sync.exclude`: globs skipped inside those paths.
- `remote.exclude`: packages or extensions not loaded on the Sprite (substring match on `settings.json`'s `packages` and `extensions`).
- `remote.replace`: same matching, swapped for another source (`npm:…`, `git:…`, or a file under `sync.paths`). The default swaps the interactive question tool, which needs a UI, for `remote-ask.ts`: a version that ends the run with the question, so it reaches you as a card.
- `remote.tools`: CLI tools your extensions or projects need that pi does not install. `/detach sync` installs each one on the Sprite at the version installed on your laptop, and reinstalls it when yours changes. Recipes exist for `agent-browser`, `rg`, `fd`, `ast-grep`, and the package managers `pnpm`, `yarn`, `bun` and `uv` (`sprite/setup/tools/`); add a recipe for any other tool. A tool that comes inside a pi package (like `nu` with a nushell extension) needs no entry: the package brings it on the Sprite too. A repo with a `pnpm`, `yarn`, `bun` or `uv` lockfile is not detached until that tool is listed here (npm comes with Node).
- `copyProjectFiles`: git-ignored project files copied into the job's checkout (never committed). A repo can override it with `copyProjectFiles` in `<repo>/.pi-sprites-detach.json`.

## How it works

- **Git**: uncommitted work is committed to a snapshot (with a temporary index, so your index and working tree are untouched) and pushed to a new branch, `<branch>-detach-<n>`, on `origin` only. The Sprite keeps one cached clone per repo and gives each job its own worktree. The agent commits and pushes to the job branch; pull commits anything left over and fetches the branch.
- **Same paths**: each job's pi runs in a mount namespace that shows its checkout at your laptop's path, so paths in the conversation stay valid.
- **Runs**: pi runs headless on the job's session file. While a run lasts, a Tasks API hold keeps the Sprite awake and the run is a Sprite service, so the Sprite restarts it if the runner or pi is killed or the Sprite environment restarts; the run then continues with "you were interrupted, check the state and continue" (two interruptions per run at most). When the run ends, the hold is released and the Sprite pauses, so you pay for compute only while the agent works.
- **Status**: your pi windows poll the Sprite every 45 s while jobs are active, and once when pi starts, which reports anything that finished while the laptop was closed.
- **Several jobs** run at once, from the same repo or not.

## Limits

- Folders that are not git repos are detached conversation-only: the agent gets an empty folder.
- A git repo needs an `origin` remote and at least one commit.
- Only the project folder goes to the Sprite with a job. Files elsewhere, like `~/Downloads`, are there only if their folder is in `sync.paths` (folders under your home); otherwise the agent says which file it needs.
- Skills that read credentials from the local system (like the macOS Keychain) do not work on the Sprite.
- The job's conversation and copied files sit on Fly until you pull. Be careful with sensitive data.

## Development

```sh
npm install
npm test
npm run typecheck
pi install /path/to/pi-sprites-detach    # use a local checkout
```
