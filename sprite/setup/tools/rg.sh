# Recipe for ripgrep (rg), from its GitHub release so any version can match the laptop's.
# Sourced by install-tool.sh.

tool_version() {
  rg --version 2>/dev/null | head -1 | awk '{print $2}'
}

tool_install() {
  local arch tmp
  case $(uname -m) in
    x86_64) arch=x86_64-unknown-linux-musl ;;
    aarch64) arch=aarch64-unknown-linux-gnu ;;
    *) echo "no ripgrep build for $(uname -m)" >&2; return 1 ;;
  esac
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/$1/ripgrep-$1-$arch.tar.gz" |
    tar -xz -C "$tmp" --strip-components=1
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$tmp/rg" "$HOME/.local/bin/rg"
  rm -rf "$tmp"
}
