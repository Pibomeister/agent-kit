#!/usr/bin/env bash
# Vendor or check the repo-root .cursor overlay against `ak build --host cursor`.
# Repo-owned and left alone: .cursor/environment.json. Never writes root AGENTS.md.
# Usage: tools/cursor/self-host.sh --vendor | --check
# ROOT is this script's repository, not $PWD, so rm -rf cannot escape it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
BUNDLE=$ROOT/dist/cursor
OVERLAY=$ROOT/.cursor
FIX="tools/cursor/self-host.sh --vendor"

usage() {
  echo "Usage: tools/cursor/self-host.sh --vendor | --check" >&2
  echo "--vendor always runs bun run ak build --host cursor, then copies dist/cursor/.cursor." >&2
  echo "--vendor deletes top-level .cursor entries the bundle no longer produces. It keeps environment.json." >&2
  echo "--check diffs .cursor/ against the current dist/cursor/.cursor and does not rebuild." >&2
  echo "On drift, --check prints: $FIX" >&2
  exit 2
}

[ $# -eq 1 ] || usage
cd "$ROOT"

rm_overlay_entry() {
  dst=$1
  case $dst in
    "$OVERLAY"/*) ;;
    *)
      echo "refusing to remove $dst (not under $OVERLAY)" >&2
      exit 1
      ;;
  esac
  rm -rf "$dst"
}

copy_tree() {
  src=$1
  dst=$2
  rm_overlay_entry "$dst"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    cp -a "$src"/. "$dst"/
  else
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
  fi
}

vendor() {
  bun run ak build --host cursor
  if [ ! -d "$BUNDLE/.cursor" ]; then
    echo "missing $BUNDLE/.cursor after build" >&2
    exit 1
  fi
  mkdir -p "$OVERLAY"
  saved=
  if [ -f "$OVERLAY/environment.json" ]; then
    saved=$(mktemp)
    cp -a "$OVERLAY/environment.json" "$saved"
  fi
  for src in "$BUNDLE/.cursor"/*; do
    [ -e "$src" ] || continue
    copy_tree "$src" "$OVERLAY/$(basename "$src")"
  done
  for dst in "$OVERLAY"/*; do
    [ -e "$dst" ] || continue
    name=$(basename "$dst")
    [ "$name" = environment.json ] && continue
    if [ ! -e "$BUNDLE/.cursor/$name" ]; then
      rm_overlay_entry "$dst"
    fi
  done
  if [ -n "$saved" ]; then
    cp -a "$saved" "$OVERLAY/environment.json"
    rm -f "$saved"
  fi
}

check() {
  if [ ! -d "$BUNDLE/.cursor" ]; then
    echo "missing $BUNDLE/.cursor (no rebuild). Re-vendor with: $FIX" >&2
    exit 1
  fi
  if ! diff -rq -x environment.json "$BUNDLE/.cursor" "$OVERLAY"; then
    echo "Cursor overlay drifted. Re-vendor with: $FIX" >&2
    exit 1
  fi
}

case $1 in
  --vendor) vendor ;;
  --check) check ;;
  *) usage ;;
esac
