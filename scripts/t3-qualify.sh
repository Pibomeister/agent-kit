#!/usr/bin/env bash
# Write a T3 adapter-integration evidence document for <host>.
#
#   scripts/t3-qualify.sh cursor
#
# Host must be a packaging host with a directory under adapters/. Slots (discovery, slash, readonly,
# isolation) are empty. The verdict is not-qualified. strict is false. Does not
# call a host and does not invent traces. No reader scores filled slots.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$root/src/adapter-qualification/t3-cli.ts" "$@"
