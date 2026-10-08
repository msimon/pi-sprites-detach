# Recipe for yarn. Sourced by install-tool.sh.
# Yarn 1 is the `yarn` npm package; Yarn 2 and later ship as `@yarnpkg/cli-dist`.
# nvm's global bin is not on the PATH, so global npm tools go to ~/.local.

tool_version() {
  yarn --version 2>/dev/null | head -1
}

tool_install() {
  # Both packages provide the yarn command: remove the other one first.
  case $1 in
    1.*)
      npm uninstall -g --prefix "$HOME/.local" @yarnpkg/cli-dist >/dev/null 2>&1 || true
      npm install -g --prefix "$HOME/.local" "yarn@$1"
      ;;
    *)
      npm uninstall -g --prefix "$HOME/.local" yarn >/dev/null 2>&1 || true
      npm install -g --prefix "$HOME/.local" "@yarnpkg/cli-dist@$1"
      ;;
  esac
}
