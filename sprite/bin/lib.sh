# Shared helpers for pi-handoff's Sprite scripts. Sourced, never run directly.

export LANG=C.UTF-8 LC_ALL=C.UTF-8
export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:/.sprite/bin:$PATH"

# shellcheck disable=SC2034  # used by the scripts that source this file
HANDOFF_STATE=$HOME/.handoff
# shellcheck disable=SC2034
HANDOFF_HOME=$HOME/.pi-handoff
SPRITE_ENV=/.sprite/bin/sprite-env

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# json_merge <file> <json>: shallow-merge a JSON object into a JSON file, atomically.
json_merge() {
  local file=$1 patch=$2 tmp
  tmp=$(mktemp "$file.XXXXXX") || return 1
  if [ -s "$file" ]; then cat "$file"; else echo '{}'; fi |
    jq --argjson p "$patch" '. + $p' >"$tmp" && mv "$tmp" "$file"
}

# hold_start <name>: keep the Sprite awake through the Tasks API until hold_stop.
# 5 min expiry, renewed every 60 s. The heartbeat exits on its own once the shell
# that started it is gone, so a killed script leaves at most 5 minutes of hold.
hold_start() {
  HOLD_NAME=$1
  _hold_put
  (
    owner=$$
    while sleep 60; do
      kill -0 "$owner" 2>/dev/null || exit 0
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
