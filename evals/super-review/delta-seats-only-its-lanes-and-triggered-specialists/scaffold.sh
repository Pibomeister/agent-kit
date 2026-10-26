#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
git checkout -q -b AK-671-export-columns
printf '\n// AK-671 adds export columns.\n' >> src/export/csv.js
commit_all "AK-671: add export columns" "2026-09-23T09:00:00+00:00"
last_reviewed="$(head_sha)"
printf '\n// Fix trims whitespace when formatting a row.\n' >> src/export/csv.js
commit_all "fix: trim whitespace when formatting a row" "2026-09-24T09:00:00+00:00"
mkdir -p runs/review
cat > runs/review/findings.json <<JSON
{"status":"changes-requested","fix_cycles":1,"reviewed_revision":"$last_reviewed","findings":[
{"id":"F-COL-1","severity":"P2","lane":"code-review/data-migration","status":"open","title":"export column order changed without a migration note"},
{"id":"F-COL-2","severity":"P1","lane":"code-review/correctness","status":"closed","title":"empty rows are exported"}]}
JSON
