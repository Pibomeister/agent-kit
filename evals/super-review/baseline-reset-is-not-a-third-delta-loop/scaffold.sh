#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
old_base="$(head_sha)"
git checkout -q -b AK-603-settlement
printf '\n// AK-603 records settlement ownership.\n' >> src/billing/renewal.js
commit_all "AK-603: record settlement ownership" "2026-09-23T09:00:00+00:00"
old_head="$(head_sha)"
git checkout -q main
printf '\nSettlement reconciliation now belongs to the ledger service.\n' >> STANDARDS.md
commit_all "standards: move reconciliation ownership" "2026-09-25T09:00:00+00:00"
git checkout -q AK-603-settlement
git rebase -q main
mkdir -p runs/review
cat > runs/review/baseline.json <<JSON
{"status":"material-change","old_base":"$old_base","old_reviewed_head":"$old_head","new_base":"$(git rev-parse main)","new_head":"$(head_sha)","old_approval":"approved","requirement_change":"ledger service now owns reconciliation","delta_cycles_remaining":1}
JSON
