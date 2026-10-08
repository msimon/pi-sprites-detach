# Recipe for bun, from npm (it ships the platform binary). Sourced by install-tool.sh.
# nvm's global bin is not on the PATH, so global npm tools go to ~/.local.

tool_version() {
  bun --version 2>/dev/null | head -1
}

tool_install() {
  npm install -g --prefix "$HOME/.local" --allow-scripts=bun "bun@$1"
}
