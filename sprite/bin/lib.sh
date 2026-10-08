# Shared helpers for pi-handoff's Sprite scripts. Sourced, never run directly.

export LANG=C.UTF-8 LC_ALL=C.UTF-8
export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:/.sprite/bin:$PATH"

# shellcheck disable=SC2034  # used by the scripts that source this file
HANDOFF_STATE=$HOME/.handoff
# shellcheck disable=SC2034
HANDOFF_HOME=$HOME/.pi-handoff/sprite
SPRITE_ENV=/.sprite/bin/sprite-env

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# emit <json>: the one result line the laptop reads (src/local/exec.ts JSON_MARKER).
emit() { printf '%s%s\n' '@@handoff ' "$1"; }

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

# Each run is the Sprite service handoff-<jobId> while it lasts (handoff-start), so the
# runtime starts it again after an environment restart or a killed runner.
service_registered() { "$SPRITE_ENV" services get "handoff-$1" >/dev/null 2>&1; }
service_delete() { "$SPRITE_ENV" services delete "handoff-$1" >/dev/null 2>&1 || true; }

# runner_alive <jobId>: whether the job's run is in progress: its handoff-run is alive,
# or its service is still registered (the runtime is about to start it again).
runner_alive() {
  pid_alive "$HANDOFF_STATE/$1/runner.pid" || service_registered "$1"
}

# job_pids <jobId>: this user's processes started for the job (pi and its tools), found
# by the HANDOFF_JOB_ID handoff-run passes to pi. Not the runner itself.
job_pids() {
  local p
  for p in /proc/[0-9]*; do
    [ -r "$p/environ" ] || continue
    if tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -qx "HANDOFF_JOB_ID=$1"; then
      echo "${p#/proc/}"
    fi
  done
}

# json_merge <file> <json>: shallow-merge a JSON object into a JSON file, atomically.
json_merge() {
  local file=$1 patch=$2 tmp
  tmp=$(mktemp "$file.XXXXXX") || return 1
  if [ -s "$file" ]; then cat "$file"; else echo '{}'; fi |
    jq --argjson p "$patch" '. + $p' >"$tmp" && mv "$tmp" "$file"
}

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
