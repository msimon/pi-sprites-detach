#!/bin/bash
# bootstrap.sh [node-version]: what pi-handoff needs on a fresh Sprite. Idempotent.
#
# Node at the laptop's version as the nvm default, pi as a managed install, a UTF-8
# locale and git settings. Nothing else: CLI tools your extensions use (rg, fd,
# ast-grep, agent-browser…) are optional and go in remote.tools in the config, which
# /handoff sync installs at the laptop's version from the recipes in tools/.
# Interactive logins are not done here; run them yourself afterwards:
#   sprite exec -s <sprite> --tty -- pi        then /login for each model provider
#   sprite exec -s <sprite> --tty -- bash -lc 'gh auth login && gh auth setup-git'
# Takes a minute or two: start it detached, never inside one sprite exec.
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
# shellcheck source=../bin/lib.sh
source "$here/../bin/lib.sh"

node_version=${1:-24.21.0}

hold_start setup-bootstrap
trap hold_stop EXIT

echo "== node $node_version"
export NVM_DIR=${NVM_DIR:-/.sprite/languages/node/nvm}
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$node_version"
nvm alias default "$node_version"

echo "== pi"
if [ ! -x "$HOME/.pi/agent/bin/pi" ]; then
  # The Sprite image ships an old npm-installed pi in ~/.local. The install script
  # would migrate it with `npm uninstall`, which hangs here: the package sits in the
  # image's read-only layer, renaming it fails with EXDEV, and npm's copy fallback
  # crawls. Deleting it directly is instant, and leaves the script nothing to migrate.
  old=$HOME/.local/lib/node_modules/@earendil-works/pi-coding-agent
  if [ -d "$old" ]; then
    echo "removing the image's npm-installed pi $(jq -r .version "$old/package.json" 2>/dev/null)"
    rm -rf "$old" "$HOME"/.local/lib/node_modules/@earendil-works/.pi-coding-agent-*
    rmdir "$HOME/.local/lib/node_modules/@earendil-works" 2>/dev/null || true
    [ -L "$HOME/.local/bin/pi" ] && rm -f "$HOME/.local/bin/pi"
  fi
  # Managed install, updated with `pi update`, as pi advises. Never npm install -g.
  curl -fsSL https://pi.dev/install.sh | sh
fi

echo "== locale"
grep -q '^export LANG=C.UTF-8' "$HOME/.profile" || printf 'export LANG=C.UTF-8\nexport LC_ALL=C.UTF-8\n' >>"$HOME/.profile"

echo "== git"
# pi git packages written as git@github.com:… must go over HTTPS with the gh token.
git config --global url."https://github.com/".insteadOf "git@github.com:"

echo "== done"
