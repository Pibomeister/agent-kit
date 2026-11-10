#!/usr/bin/env bash
# Score a review-seat adapter launch JSON for parent-context, memory and
# instruction leaks (TP-ISO contaminated variant / AT-27).
#
#   scripts/adapter-isolation-check.sh tests/fixtures/adapter-isolation/contaminated.json
#   scripts/adapter-isolation-check.sh tests/fixtures/adapter-isolation/clean.json
#
# Exit 0 on a clean seat, 1 on a leak, 2 on a missing or malformed document.
# Offline. No host call.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$root/src/adapter-qualification/isolation-cli.ts" "$@"
