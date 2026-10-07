#!/bin/bash
# install-tool.sh <name> <version>: install one tool at the laptop's version.
#
# The recipe in tools/<name>.sh defines tool_version (prints the installed version,
# or nothing) and tool_install <version>. Runs under its own Tasks hold because
# some installs (agent-browser with Chrome) take minutes.
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
# shellcheck source=../bin/lib.sh
source "$here/../bin/lib.sh"

name=${1:?usage: install-tool.sh <name> <version>}
want=${2:?usage: install-tool.sh <name> <version>}
# shellcheck disable=SC1090
source "$here/tools/$name.sh"

if [ "$(tool_version 2>/dev/null)" = "$want" ]; then
  echo "$name $want already installed"
  exit 0
fi

hold_start "setup-$name"
trap hold_stop EXIT

echo "installing $name $want"
tool_install "$want"

have=$(tool_version 2>/dev/null || true)
if [ "$have" != "$want" ]; then
  echo "installed ${have:-nothing}, wanted $want" >&2
  exit 1
fi
echo "$name $want installed"
