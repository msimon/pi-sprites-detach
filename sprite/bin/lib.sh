# Shared helpers for pi-sprites-detach's Sprite scripts. Sourced, never run directly.

export LANG=C.UTF-8 LC_ALL=C.UTF-8
export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:/.sprite/bin:$PATH"

# shellcheck disable=SC2034  # used by the scripts that source this file
DETACH_STATE=$HOME/.detach
# shellcheck disable=SC2034
DETACH_HOME=$HOME/.pi-sprites-detach/sprite
SPRITE_ENV=/.sprite/bin/sprite-env

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# emit <json>: the one result line the laptop reads (src/local/exec.ts JSON_MARKER).
emit() { printf '%s%s\n' '@@detach ' "$1"; }

# migrate_legacy_state: state and files from before the rename (pi-handoff). ~/.handoff
# moves into ~/.detach, entry by entry (the laptop may have uploaded into ~/.detach
# already; an entry both have stays the new one, and sync's own state is just redone),
# and ~/.pi-handoff goes: the old build, and the synced files the laptop now sends to
# ~/.pi-sprites-detach. Not while anything from the old build still runs, which would
# lose its state under it: the next sync tries again.
migrate_legacy_state() {
  local old=$HOME/.handoff entry
  [ -d "$old" ] || [ -d "$HOME/.pi-handoff" ] || return 0
  if pgrep -f '\.pi-handoff/sprite/bin/' >/dev/null 2>&1; then
    echo "kept the state from before the rename: a run from then is still going"
    return 0
  fi
  if [ -d "$old" ]; then
    mkdir -p "$DETACH_STATE"
    for entry in "$old"/* "$old"/.[!.]*; do
      [ -e "$entry" ] || continue
      [ -e "$DETACH_STATE/$(basename "$entry")" ] || mv "$entry" "$DETACH_STATE/"
    done
    rm -rf "$old"
  fi
  rm -rf "$HOME/.pi-handoff"
  echo "moved the state from before the rename into $DETACH_STATE"
}

# Pid files hold "<pid> <start time>". Pids start again from low numbers when the
# Sprite environment restarts, so a bare pid could name an unrelated process.
proc_start() {
  local s
  s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  s=${s##*) }   # drop "<pid> (<comm>) ": the start time is then field 20
  # shellcheck disable=SC2086
  set -- $s
  echo "${20}"
}
pid_record() { echo "$1 $(proc_start "$1")" >"$2"; }
pid_alive() {
  local pid start
  [ -f "$1" ] && read -r pid start <"$1" || return 1
  [ -n "$pid" ] && [ -n "$start" ] && [ "$(proc_start "$pid")" = "$start" ]
}
pid_of() { cut -d' ' -f1 "$1" 2>/dev/null; }

# Each run is the Sprite service detach-<jobId> while it lasts (detach-start), so the
# runtime starts it again after an environment restart or a killed runner.
service_registered() { "$SPRITE_ENV" services get "detach-$1" >/dev/null 2>&1; }
service_delete() { "$SPRITE_ENV" services delete "detach-$1" >/dev/null 2>&1 || true; }

# runner_alive <jobId>: whether the job's run is in progress: its detach-run (or the
# detach-joined wrapper of a joined pi) is alive, or its service is still registered
# (the runtime is about to start it again).
runner_alive() {
  pid_alive "$DETACH_STATE/$1/runner.pid" || service_registered "$1"
}

# The tmux session a joined pi runs in (detach-join).
join_session() { echo "detach-$1"; }

# fix_stale_joined <jobId>: a job still marked `joined` whose wrapper is gone (the
# Sprite environment restarted, or it was killed hard) ended without recording it:
# record `done` now, with the last answer pi wrote. A joined pi is not a service, so
# nothing brings it back; joining again starts a fresh one on the same conversation.
fix_stale_joined() {
  local dir=$DETACH_STATE/$1 text
  [ "$(jq -r '.state // empty' "$dir/status.json" 2>/dev/null)" = joined ] || return 0
  pid_alive "$dir/runner.pid" && return 0
  text=$(jq '.text // null' "$dir/result.json" 2>/dev/null || echo null)
  json_merge "$dir/status.json" "$(jq -n --arg t "$(now)" --argjson x "${text:-null}" \
    '{state:"done", runEndedAt:$t, lastAssistantText:$x, error:null, question:null}')"
  rm -f "$dir/runner.pid"
  echo "== $(now) the joined pi had ended without recording it; recorded done" >>"$dir/runner.log"
}

# job_pids <jobId>: this user's processes started for the job (pi and its tools), found
# by the DETACH_JOB_ID detach-run passes to pi. Not the runner itself.
job_pids() {
  local p
  for p in /proc/[0-9]*; do
    # Other users' environ files cannot be read; the shell reports a failed `<`
    # itself, so the group, not tr, gets the 2>/dev/null.
    if { tr '\0' '\n' <"$p/environ" | grep -qx "DETACH_JOB_ID=$1"; } 2>/dev/null; then
      echo "${p#/proc/}"
    fi
  done
}

# proc_running <pid>: the process exists and has not exited. Works on a root-owned
# child (kill -0 would say EPERM) and on an unreaped one (a zombie until `wait`).
proc_running() {
  local s
  s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  s=${s##*) }
  [ "${s%% *}" != Z ]
}

# end_job_pids <jobId>: TERM the job's pi and tools, KILL whatever is left after 20 s.
end_job_pids() {
  # shellcheck disable=SC2046  # one pid per word
  kill -TERM $(job_pids "$1") 2>/dev/null
  for _ in $(seq 40); do
    [ -n "$(job_pids "$1")" ] || return 0
    sleep 0.5
  done
  # shellcheck disable=SC2046
  kill -KILL $(job_pids "$1") 2>/dev/null
}

# json_merge <file> <json>: shallow-merge a JSON object into a JSON file, atomically.
json_merge() {
  local file=$1 patch=$2 tmp
  tmp=$(mktemp "$file.XXXXXX") || return 1
  if [ -s "$file" ]; then cat "$file"; else echo '{}'; fi |
    jq --argjson p "$patch" '. + $p' >"$tmp" && mv "$tmp" "$file"
}

# repo_lock <repoKey> ... repo_unlock: one job at a time runs git on a cached clone
# (clone, fetch, worktree add/remove, branch -D); concurrent ones fail on git's own
# lock files. On fd 9, so the lock goes with the process if it dies.
repo_lock() {
  mkdir -p "$HOME/repos/.locks"
  exec 9>"$HOME/repos/.locks/${1//\//__}.lock"
  flock 9
}
repo_unlock() { exec 9>&-; }
# hold_start <name> [jobId]: keep the Sprite awake through the Tasks API until
# hold_stop. 5 min expiry, renewed every 60 s. The heartbeat exits on its own once the
# shell that started it is gone, so a killed script leaves at most 5 minutes of hold.
# With a jobId it also keeps going while the job's pi is alive: a killed runner must
# not let the Sprite pause under pi, whose turn the restarted runner then records.
hold_start() {
  HOLD_NAME=$1
  _hold_put
  (
    owner=$$ job=${2:-}
    while sleep 60; do
      kill -0 "$owner" 2>/dev/null || { [ -n "$job" ] && [ -n "$(job_pids "$job")" ]; } || exit 0
      _hold_put
    done
  ) &
  HOLD_HEARTBEAT=$!
}

_hold_put() {
  "$SPRITE_ENV" curl -s -X PUT "/v1/tasks/$HOLD_NAME" -d '{"expire":"5m"}' >/dev/null || true
}

hold_stop() {
  [ -n "${HOLD_HEARTBEAT:-}" ] && kill "$HOLD_HEARTBEAT" 2>/dev/null
  [ -n "${HOLD_NAME:-}" ] && "$SPRITE_ENV" curl -s -X DELETE "/v1/tasks/$HOLD_NAME" >/dev/null
  HOLD_NAME=
  return 0
}
