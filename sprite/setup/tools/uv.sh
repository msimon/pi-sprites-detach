# Recipe for uv, from its GitHub release so any version can match the laptop's.
# Sourced by install-tool.sh.

tool_version() {
  uv --version 2>/dev/null | awk '{print $2}'
}

tool_install() {
  local arch tmp
  case $(uname -m) in
    x86_64) arch=x86_64-unknown-linux-musl ;;
    aarch64) arch=aarch64-unknown-linux-musl ;;
    *) echo "no uv build for $(uname -m)" >&2; return 1 ;;
  esac
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/$1/uv-$arch.tar.gz" |
    tar -xz -C "$tmp" --strip-components=1
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$tmp/uv" "$tmp/uvx" "$HOME/.local/bin/"
  rm -rf "$tmp"
}
