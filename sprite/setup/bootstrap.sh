#!/bin/bash
# bootstrap.sh [node-version]: base setup of a fresh Sprite for pi-handoff. Idempotent.
#
# Reproduces M0: Node at the laptop's version as the nvm default, pi as a managed
# install, the CLI tools pi's extensions expect, a UTF-8 locale and git settings.
# Interactive logins are not done here; run them yourself afterwards:
#   sprite exec -s <sprite> --tty -- pi        then /login for each provider
#   sprite exec -s <sprite> --tty -- gh auth login && gh auth setup-git
# Long-running: start it detached, or from a --tty session you keep open.
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

echo "== apt packages"
need=()
command -v rg >/dev/null || need+=(ripgrep)
command -v fdfind >/dev/null || need+=(fd-find)
dpkg -s locales >/dev/null 2>&1 || need+=(locales)
if [ ${#need[@]} -gt 0 ]; then
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${need[@]}"
fi
mkdir -p "$HOME/.local/bin"
[ -e "$HOME/.local/bin/fd" ] || ln -s "$(command -v fdfind)" "$HOME/.local/bin/fd"

echo "== npm CLI tools"
# nvm's global bin is not on the PATH, so global tools go to ~/.local.
command -v pnpm >/dev/null || npm install -g --prefix "$HOME/.local" pnpm
command -v ast-grep >/dev/null || npm install -g --prefix "$HOME/.local" --allow-scripts=@ast-grep/cli @ast-grep/cli

echo "== locale"
if ! locale -a 2>/dev/null | grep -qi '^en_GB.utf8$'; then
  sudo locale-gen en_GB.UTF-8
fi
grep -q '^export LANG=C.UTF-8' "$HOME/.profile" || printf 'export LANG=C.UTF-8\nexport LC_ALL=C.UTF-8\n' >>"$HOME/.profile"

echo "== git"
# pi git packages written as git@github.com:… must go over HTTPS with the gh token.
git config --global url."https://github.com/".insteadOf "git@github.com:"

echo "== done"
