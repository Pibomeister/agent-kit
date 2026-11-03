#!/usr/bin/env bash
# Cloud Agent install: pin Bun to the version CI uses, then frozen-lockfile deps.
# Same pin as .github/workflows/ci.yml oven-sh/setup-bun bun-version.
# Linux zips and hashes are tools/cursor/bun-v1.3.14.sha256 (SHASUMS256.txt on that tag).
set -euo pipefail
PIN=1.3.14
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SUMS=$HERE/bun-v${PIN}.sha256
export PATH="${HOME}/.bun/bin:${PATH}"

install_bun() {
  arch=$(uname -m)
  case $arch in
    x86_64) asset=bun-linux-x64.zip ;;
    aarch64 | arm64) asset=bun-linux-aarch64.zip ;;
    *)
      echo "unsupported uname -m '$arch'. Need x86_64 or aarch64." >&2
      exit 1
      ;;
  esac
  expected=$(awk -v a="$asset" '$2 == a { print $1 }' "$SUMS")
  if [ -z "$expected" ]; then
    echo "no sha256 for $asset in $SUMS" >&2
    exit 1
  fi
  url="https://github.com/oven-sh/bun/releases/download/bun-v${PIN}/${asset}"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/$asset" "$url"
  got=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
  if [ "$got" != "$expected" ]; then
    echo "bun $asset checksum mismatch: got $got want $expected" >&2
    exit 1
  fi
  echo "bun $asset sha256 $got ok" >&2
  unzip -o -q "$tmp/$asset" -d "$tmp/out"
  src=$(find "$tmp/out" -type f -name bun -print -quit)
  if [ -z "$src" ]; then
    echo "bun zip $asset had no bun binary" >&2
    exit 1
  fi
  mkdir -p "${HOME}/.bun/bin"
  cp -a "$src" "${HOME}/.bun/bin/bun"
  chmod +x "${HOME}/.bun/bin/bun"
}

link_bun() {
  src=${HOME}/.bun/bin/bun
  dst=/usr/local/bin/bun
  [ -x "$src" ] || return 0
  if [ -w /usr/local/bin ]; then
    ln -sf "$src" "$dst" || true
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo ln -sf "$src" "$dst" || true
  fi
}

if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "$PIN" ]; then
  install_bun
fi
link_bun

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not on PATH after install" >&2
  exit 1
fi
if [ "$(bun --version)" != "$PIN" ]; then
  echo "bun $(bun --version) is not the pinned ${PIN}" >&2
  exit 1
fi

cd "$ROOT"
bun install --frozen-lockfile
