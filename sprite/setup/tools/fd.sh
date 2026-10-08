# Recipe for fd, from its GitHub release so any version can match the laptop's.
# Sourced by install-tool.sh.

tool_version() {
  fd --version 2>/dev/null | awk '{print $2}'
}

tool_install() {
  local arch tmp
  case $(uname -m) in
    x86_64) arch=x86_64-unknown-linux-musl ;;
    aarch64) arch=aarch64-unknown-linux-musl ;;
    *) echo "no fd build for $(uname -m)" >&2; return 1 ;;
  esac
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/sharkdp/fd/releases/download/v$1/fd-v$1-$arch.tar.gz" |
    tar -xz -C "$tmp" --strip-components=1
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$tmp/fd" "$HOME/.local/bin/fd"
  rm -rf "$tmp"
}
