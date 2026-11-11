#!/usr/bin/env bash
# Write a T4 held-out eval evidence document.
#
#   scripts/t4-held-out.sh evidence
#
# Scores, adjudication records and corpus location stay empty. The verdict is
# not-run. Does not hold the curator corpus and does not adjudicate. No reader
# scores filled slots.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$root/src/held-out/cli.ts" "$@"
