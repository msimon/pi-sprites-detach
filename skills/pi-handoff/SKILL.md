---
name: pi-handoff
description: Hand work off to a cloud machine (a Fly.io Sprite) so it keeps running while the user is away, then check on it, answer it and bring it back. Use when the user says they have to leave or go offline, asks to hand off, run something in the background or in the cloud, or asks about a handoff job (h1, h2… ha, h1k, i.e. h + a base-36 counter), its status, its question or its result.
---

# pi-handoff

pi-handoff moves a conversation to a cloud machine. The agent there keeps working without the user and tells the user's pi window when it finishes or needs input. You have tools for it; the user also has the same actions as `/handoff` commands.

## Tools

| Tool | What it does | Asks the user first |
| --- | --- | --- |
| `handoff_status` | Lists jobs, or shows one in full (state, branch, question, last message) | no |
| `handoff_reply` | Starts another run of a finished job: an answer to its question, or more work | no |
| `handoff_pull` | Brings a finished job back (its work into the folder when it can) and returns a summary of what it did, its commits, where its code is and its final message | yes |
| `handoff_join` | Opens a terminal for the user on a finished job (they type there, not you) | only with `abort` |
| `handoff_abort` | Stops a run in progress | yes |
| `handoff_cleanup` | Removes a pulled, merged job's worktree and local branches (nothing on origin) | yes |
| `handoff_start` | Hands the current work off to run unattended | yes |

## Handing work off

1. Use `handoff_start` when the user says they have to leave and the work should continue. Do not hand off on your own initiative.
2. The job continues this conversation **up to your last finished message**. It does not see the turn you are in. Write the `prompt` so it stands alone: what the user asked for, what you already did and found in this turn, and what to do next. Uncommitted changes in the working tree go along; files outside the project do not.
3. After it returns, tell the user the job id and branch, and **stop**. Do not continue the same work here: the job is doing it. Pass on any note it returns (the base branch was pushed to origin for the pull request, or the job runs without one and why).
4. With `pr: auto` in the user's config, origin may have commits their branch lacks; the user is then asked to continue without a pull request or cancel. If they cancel, the tool says so: tell them to `git pull` first, and do not hand off again unless they ask.
5. If the user declines the confirmation, do not ask again unless they bring it up.

## States of a job

- `starting`, `preparing`, `running`: working. It cannot be replied to or pulled; wait for it (the user gets a card), or abort it only if they ask.
- `needs input`: it ended with a question. Show the user the question (`handoff_status` with the job), then `handoff_reply` with their answer.
- `done`: finished. Read its last message with `handoff_status`, then reply for more work or pull it.
- `failed`, `aborted`: ended early. Look at the error or last message, then reply to try again, or pull what is there.
- `joined`: the user is working on it live; leave it alone.
- `pulled`: brought back. Its conversation is saved locally; `handoff_pull` on it returns the summary again, or first retries bringing its work into the folder if that could not happen at pull (`handoff_status` shows "Its work: …").

## Bringing a job back

`handoff_pull` returns what the job did, and where its code is now. By default pull fast-forwards the folder's branch to the job's work (edits made in the folder since the handoff stay on top, uncommitted); with a pull request, the code waits in the PR; when neither could happen, it stays on `origin/<branch>` and the summary says why. **Do not merge, cherry-pick or copy the job's code yourself unless the user asks.** Say where it is and what it contains, and let them decide. After a fast-forward, the branch is not pushed: leave that to the user.

## Answering a job's question

Pass the user's answer as it is; do not guess for them. The job runs again on the same conversation, so the reply can be short ("minus", "yes, go ahead").

## Cleaning up after a pull

Pulling a job with a worktree leaves, on the user's laptop, that worktree, a local branch and the fetched `origin/<branch>`. When the user says the work is merged or done with, use `handoff_cleanup`: it removes those three and keeps the conversation. It only works once the branch is merged into its base branch (a squash-merged pull request counts) and the worktree has no uncommitted changes; otherwise it says why. Pass that on and stop: do not try to force it. Only the user can discard unmerged work, or delete the branch on origin, by typing `/handoff cleanup <job> --discard` or `--remote` themselves.

## Commands only the user can run

You cannot type slash commands. Tell the user about them when they fit:

- `/handoff watch [job]`: a live, read-only view of a job's run (its text and tool calls), or a replay of a finished job's last run. Suggest it when the user asks how a running job is going; you can read its state with `handoff_status`, but the live view is theirs.
- `/handoff status`: the job browser, with every action above and filters by state.
- `/handoff cleanup <job> --discard` and `--remote`: the forced forms of `handoff_cleanup`.
- `/handoff drop <job> [--keep-branch]`: discard a finished job the user does not want (done, needs input, failed or aborted): its work is not brought back and its branch is deleted on origin; its conversation is kept, and the job shows as `dropped`. Suggest it when the user wants to get rid of a job without its work landing in their folder; never pull a job just to clear it, since pull brings its work into the folder.
