# Recipe for agent-browser, the CLI that pi-agent-browser-native wraps. Sourced by install-tool.sh.

tool_version() {
  agent-browser --version 2>/dev/null | awk '{print $2}'
}

tool_install() {
  npm install -g --prefix "$HOME/.local" --allow-scripts=agent-browser "agent-browser@$1"
  # Chrome and the system libraries it needs (~300 MB, slow the first time).
  agent-browser install --with-deps
}
