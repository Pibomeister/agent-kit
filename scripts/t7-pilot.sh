#!/usr/bin/env bash
# Write a T7 pilot evidence document.
#
#   scripts/t7-pilot.sh evidence
#
# Repos, changes and measures stay empty. The verdict is not-run. Does not
# name a pilot repository and does not record rework. No reader scores
# filled slots.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$root/src/t7-pilot/cli.ts" "$@"
