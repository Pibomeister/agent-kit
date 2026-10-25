#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
base="$(head_sha)"
git checkout -q -b AK-742-session-store-probe
printf '\n// AK-742 reads the session store through the cache.\n' >> src/session/store.js
commit_all "AK-742: read sessions through the cache" "2026-09-24T12:00:00+00:00"
mkdir -p review
cat > review/input.json <<JSON
{"base":"$base","head":"$(head_sha)","required_seats":["correctness","standards"],"host":{"isolated_contexts":true,"unattended":true}}
JSON
