#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
base="$(head_sha)"
git checkout -q -b AK-611-session-cache
printf '\n// AK-611 keeps session cache reads bounded.\n' >> src/session/store.js
commit_all "AK-611: bound session cache reads" "2026-09-24T11:00:00+00:00"
mkdir -p review
cat > review/input.json <<JSON
{"base":"$base","head":"$(head_sha)","required_seats":["correctness","standards"],"host":{"isolated_contexts":false,"shared_scratchpad":true}}
JSON
