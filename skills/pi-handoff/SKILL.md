---
name: pi-handoff
description: Hand work off to a cloud machine (a Fly.io Sprite) so it keeps running while the user is away, then check on it, answer it and bring it back. Use when the user says they have to leave or go offline, asks to hand off, run something in the background or in the cloud, or asks about a handoff job (h1, h2…), its status, its question or its result.
---

# pi-handoff

pi-handoff moves a conversation to a cloud machine. The agent there keeps working without the user and tells the user's pi window when it finishes or needs input. You have tools for it; the user also has the same actions as `/handoff` commands.

## Tools

| Tool | What it does | Asks the user first |
| --- | --- | --- |
| `handoff_status` | Lists jobs, or shows one in full (state, branch, question, last message) | no |
| `handoff_reply` | Starts another run of a finished job: an answer to its question, or more work | no |
| `handoff_pull` | Brings a finished job back and returns a summary of what it did, its commits and final message | yes |
| `handoff_join` | Opens a terminal for the user on a finished job (they type there, not you) | only with `abort` |
| `handoff_abort` | Stops a run in progress | yes |
| `handoff_start` | Hands the current work off to run unattended | yes |

## Handing work off

1. Use `handoff_start` when the user says they have to leave and the work should continue. Do not hand off on your own initiative.
2. The job continues this conversation **up to your last finished message**. It does not see the turn you are in. Write the `prompt` so it stands alone: what the user asked for, what you already did and found in this turn, and what to do next. Uncommitted changes in the working tree go along; files outside the project do not.
3. After it returns, tell the user the job id and branch, and **stop**. Do not continue the same work here: the job is doing it.
4. If the user declines the confirmation, do not ask again unless they bring it up.

## States of a job

- `starting`, `preparing`, `running`: working. It cannot be replied to or pulled; wait for it (the user gets a card), or abort it only if they ask.
- `needs input`: it ended with a question. Show the user the question (`handoff_status` with the job), then `handoff_reply` with their answer.
- `done`: finished. Read its last message with `handoff_status`, then reply for more work or pull it.
- `failed`, `aborted`: ended early. Look at the error or last message, then reply to try again, or pull what is there.
- `joined`: the user is working on it live; leave it alone.
- `pulled`: brought back. Its conversation is saved locally; `handoff_pull` on it only returns the summary again.

## Bringing a job back

`handoff_pull` returns what the job did, and that is context for you, not changes in this working directory. The job's code is on its branch (`origin/<branch>`). **Do not merge, cherry-pick or copy it unless the user asks.** Say where it is and what it contains, and let them decide.

## Answering a job's question

Pass the user's answer as it is; do not guess for them. The job runs again on the same conversation, so the reply can be short ("minus", "yes, go ahead").
