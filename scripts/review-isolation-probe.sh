#!/usr/bin/env bash
# Probe whether a doc-review seat on <host> starts without the author's context.
#
#   AK_REVIEW_ISOLATION_PROBE=1 scripts/review-isolation-probe.sh claude-code
#   AK_REVIEW_ISOLATION_PROBE=1 scripts/review-isolation-probe.sh codex
#   AK_REVIEW_ISOLATION_PROBE=1 scripts/review-isolation-probe.sh mastracode
#
# Opt-in, live and billed. Refuses without AK_REVIEW_ISOLATION_PROBE=1 so CI and
# `bun run test` cannot start a host. One arm per leak channel (parent turn, hooks
# and memory, auto-loaded instructions, transcript on disk, role file denied). Each
# arm plants a fresh MARKER_ plus 32 hex digits, dispatches a new generic subagent
# through the same path doc-review uses (not a fork or a resume), and scores the
# host's child transcript and the child's launch configuration — never the child's
# answer. A pass means that channel did not leak at this host version. Where the
# host does not expose the channel, the arm is unobservable, not a pass.
#
# Writes research/host-facts/<date>/review-isolation-<host>.md (override the parent
# with AK_PROBE_FACTS_ROOT) and a verdict JSON (AK_PROBE_JSON). Offline tests set
# AK_PROBE_FIXTURE_DIR to a directory of per-arm child.jsonl and launch.json files
# and never call a host. Same env-flag style as scripts/eval-isolation-probe.sh
# (AK_PROBE_JSON, AK_PROBE_WORK, AK_PROBE_DATE).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$root/src/review-isolation-probe/cli.ts" "$@"
