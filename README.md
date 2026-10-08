# pi-handoff

Hand a [pi](https://pi.dev) conversation off from your laptop to a cloud machine (a [Fly.io Sprite](https://sprites.dev)), close the laptop, and let the agent keep working. When it finishes or has a question, the pi window you handed off from shows a card (and a cmux notification). Reply to it from the laptop, or pull the work and the conversation back.

```text
/handoff finish the migration and open a PR
```

The conversation splits like `/clone`: the job continues on the Sprite with a copy of the conversation, while your local session and working tree stay exactly as they were.

## Requirements

- pi 1.0.4 or later on a Mac (cmux is optional; notifications fall back to the pi window).
- A Fly.io account with Sprites, and the `sprite` CLI logged in (`sprite login`).
- For code work: a git repo with an `origin` remote the Sprite can reach. GitHub works out of the box through the `gh` token on the Sprite.

## Setup

Install the package in pi, then start pi once. That writes `~/.pi-handoff/config.json` and builds `~/.pi-handoff/sprite/`, the folder that gets installed on the Sprite.

```sh
pi install git:github.com/msimon/pi-handoff
```

Then paste this prompt into pi. It sets up the Sprite with only what pi-handoff needs, and asks before adding any optional tool:

```text
Set up a Fly.io Sprite for pi-handoff.

1. Read the Sprite name from "sprite" in ~/.pi-handoff/config.json (default pi-handoff). Check that the sprite CLI is logged in (sprite list) and create the Sprite with `sprite create <name> --skip-console` if it does not exist.
2. Install pi-handoff's files on it and start the bootstrap detached (it installs Node at my laptop's version, pi, a UTF-8 locale and git settings, nothing else):
     cd ~/.pi-handoff && COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/pi-handoff-sprite.tgz sprite
     sprite exec -s <name> --file /tmp/pi-handoff-sprite.tgz:/tmp/pi-handoff-sprite.tgz -- bash -c 'mkdir -p ~/.pi-handoff && tar -xzf /tmp/pi-handoff-sprite.tgz -C ~/.pi-handoff || exit 1
       setsid nohup ~/.pi-handoff/sprite/setup/bootstrap.sh "$0" >~/bootstrap.log 2>&1 </dev/null &' "$(node --version | tr -d v)"
   Then check ~/bootstrap.log on the Sprite every 20 seconds or so (short sprite exec calls) until it ends with "== done", and report any error.
3. The files in ~/.pi-handoff/sprite/setup/tools/ are recipes for optional CLI tools. Check which of them are installed on this laptop (`<tool> --version`), show me the list, and ask which ones to add to "remote.tools" in ~/.pi-handoff/config.json. Do not install anything yourself: /handoff sync installs them at my laptop's versions.
4. Finish by telling me which logins to do on the Sprite (they are interactive, so I run them) and to run /handoff sync after them.
```

Or by hand:

1. Create the Sprite: `sprite create pi-handoff --skip-console`.
2. Bootstrap it. It takes a minute or two, so it runs detached and logs to `~/bootstrap.log` on the Sprite:

   ```sh
   cd ~/.pi-handoff && COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/pi-handoff-sprite.tgz sprite
   sprite exec -s pi-handoff --file /tmp/pi-handoff-sprite.tgz:/tmp/pi-handoff-sprite.tgz -- bash -c \
     'mkdir -p ~/.pi-handoff && tar -xzf /tmp/pi-handoff-sprite.tgz -C ~/.pi-handoff || exit 1
      setsid nohup ~/.pi-handoff/sprite/setup/bootstrap.sh "$0" >~/bootstrap.log 2>&1 </dev/null &' "$(node --version | tr -d v)"
   ```

3. Optional tools: add the ones your extensions use to `remote.tools` in the config (see Config).

Either way, finish with the logins, which are interactive:

1. **Model provider**: the agent on the Sprite needs its own login to the model provider you use, most likely Anthropic and/or OpenAI (Codex). Run pi there and `/login` to each one:

   ```sh
   sprite exec -s pi-handoff --tty -- pi
   ```

   These tokens belong to the Sprite, separate from your laptop's, so you can revoke them on their own.

2. **GitHub**, so the Sprite can clone your repos and push the job branches:

   ```sh
   sprite exec -s pi-handoff --tty -- bash -lc 'gh auth login && gh auth setup-git'
   ```

Then run `/handoff sync` in pi. It copies your pi setup to the Sprite (see Config), installs your packages there, and installs the tools in `remote.tools`.

## Commands

| Command | What it does |
| --- | --- |
| `/handoff [prompt]` | Hand this conversation off. Without a prompt, the agent is told to continue where you left off. |
| `/handoff status [filter]` | Open the job browser. Filters: `all`, `running`, `needs-input`, `done`, `failed`, `aborted`, `pulled`. |
| `/handoff reply [job] [text]` | Start another run of a finished job: answer its question or ask for more work. Without text, pi asks (a question with options shows them as a menu). |
| `/handoff pull [job] [--abort] [--switch] [--worktree]` | Bring a job back: its conversation becomes a local session, its branch is fetched, and the Sprite is cleaned up. |
| `/handoff sync` | Bring the Sprite in line with your pi setup now (handoff and reply do this first anyway). |

The job id can be left out when only one job fits; otherwise pi asks. A handoff prompt cannot start with `sync`, `status`, `reply` or `pull`, since those words are read as the subcommand.

Pull options:

- `--abort`: a run in progress is stopped first. Without it, pull refuses while the job is running.
- `--switch`: open the job's conversation right away. Otherwise it is listed in `/resume` and in the job browser.
- `--worktree`: also check the job branch out in a local worktree, `~/pi-handoff/worktrees/<repo>/<job>`. The conversation then works there. Open it from `/resume` in the original folder: the worktree has its own session list, where it does not appear.

## What you see

- **Status line**: `☁ 1 running · 1 needs input · 2 done`, counting every job not yet pulled.
- **Outcome card**: when a run ends, a card in the open conversation with the agent's last message or its question, plus how to continue (`/handoff reply …`) or bring it back (`/handoff pull … --switch`). Cards are never sent to the model.
- **cmux notification** to the pane that handed off (or replied), when run inside cmux.
- **Job browser** (`/handoff status`): ↑/↓ to move, Tab/Shift+Tab to cycle filters, Ctrl+A/R/N/D/F/X/P to jump to one, Enter for the job's actions (reply, show the full message, pull and open, pull and stay, abort a run, open a pulled conversation), Esc to close.

## Config

`~/.pi-handoff/config.json`, written with the defaults on first run:

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

- `sprite`: the Sprite for new jobs.
- `pr`: `auto` asks the agent to open a pull request when the work is pushed; `never` tells it not to.
- `sync.paths`: exactly what is copied to the Sprite. Your `settings.json` always syncs as well, rewritten for the Sprite (the `remote` rules, home paths). A local extension runs on the Sprite only if its folder is listed here.
- `sync.exclude`: globs skipped inside those paths.
- `remote.exclude`: packages or extensions not loaded on the Sprite (substring match on `settings.json`'s `packages` and `extensions`).
- `remote.replace`: same matching, swapped for another source (`npm:…`, `git:…`, or a file under `sync.paths`). The default swaps the interactive question tool, which needs a UI, for `remote-ask.ts`: a version that ends the run with the question, so it reaches you as a card.
- `remote.tools`: CLI tools your extensions need that pi does not install. `/handoff sync` installs each one on the Sprite at the version installed on your laptop, and reinstalls it when yours changes. Recipes exist for `agent-browser`, `rg`, `fd`, `pnpm` and `ast-grep` (`sprite/setup/tools/`); add a recipe for any other tool.
- `copyProjectFiles`: git-ignored project files copied into the job's checkout (never committed). A repo can override it with `copyProjectFiles` in `<repo>/.pi-handoff.json`.

## How it works

- **Git**: uncommitted work is committed to a snapshot (with a temporary index, so your index and working tree are untouched) and pushed to a new branch, `<branch>-handoff-<n>`, on `origin` only. The Sprite keeps one cached clone per repo and gives each job its own worktree. The agent commits and pushes to the job branch; pull commits anything left over and fetches the branch.
- **Same paths**: each job's pi runs in a mount namespace that shows its checkout at your laptop's path, so paths in the conversation stay valid.
- **Runs**: pi runs headless on the job's session file. While a run lasts, a Tasks API hold keeps the Sprite awake and the run is a Sprite service, so the Sprite restarts it if the runner or pi is killed or the Sprite environment restarts; the run then continues with "you were interrupted, check the state and continue" (two interruptions per run at most). When the run ends, the hold is released and the Sprite pauses, so you pay for compute only while the agent works.
- **Status**: your pi windows poll the Sprite every 45 s while jobs are active, and once when pi starts, which reports anything that finished while the laptop was closed.
- **Several jobs** run at once, from the same repo or not.

## Limits

- Folders that are not git repos are handed off conversation-only: the agent gets an empty folder.
- A git repo needs an `origin` remote and at least one commit.
- Only the project folder goes to the Sprite with a job. Files elsewhere, like `~/Downloads`, are there only if their folder is in `sync.paths` (folders under your home); otherwise the agent says which file it needs.
- Skills that read credentials from the local system (like the macOS Keychain) do not work on the Sprite.
- The job's conversation and copied files sit on Fly until you pull. Be careful with sensitive data.

## Development

```sh
npm install
npm test
npm run typecheck
pi install /path/to/pi-handoff    # use a local checkout
```
