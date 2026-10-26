#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
git checkout -q -b AK-631-export-paging
printf '\n// AK-631 pages the export.\n' >> src/export/csv.js
commit_all "AK-631: page the export" "2026-09-23T09:00:00+00:00"
printf '\n// First correction bounds the page size.\n' >> src/export/csv.js
commit_all "fix: bound the export page size" "2026-09-24T09:00:00+00:00"
printf '\n// Second correction resumes from the cursor.\n' >> src/export/csv.js
commit_all "fix: resume export from the cursor" "2026-09-25T09:00:00+00:00"
mkdir -p runs/review
cat > runs/review/findings.json <<JSON
{"status":"cap-reached","fix_cycles":2,"reviewed_revision":"$(head_sha)","findings":[
{"id":"F-EXP-1","severity":"P1","status":"closed","title":"export skips the last page"},
{"id":"F-EXP-2","severity":"P2","status":"closed","title":"page size is unbounded"},
{"id":"F-EXP-3","severity":"P3","status":"open","title":"cursor variable is named c"},
{"id":"F-EXP-4","severity":"P3","status":"open","title":"row formatting helper is duplicated"},
{"id":"F-EXP-5","severity":"P3","status":"open","title":"exportCsv has no doc comment"}]}
JSON
