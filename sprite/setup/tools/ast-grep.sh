# Recipe for ast-grep. Sourced by install-tool.sh.
# nvm's global bin is not on the PATH, so global npm tools go to ~/.local.

tool_version() {
  ast-grep --version 2>/dev/null | awk '{print $2}'
}

tool_install() {
  npm install -g --prefix "$HOME/.local" --allow-scripts=@ast-grep/cli "@ast-grep/cli@$1"
}
