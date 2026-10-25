#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
git checkout -q -b AK-652-export-retry
printf '\n// AK-652 retries a failed export.\n' >> src/export/csv.js
commit_all "AK-652: retry a failed export" "2026-09-23T09:00:00+00:00"
printf '\n// First correction limits retries.\n' >> src/export/csv.js
commit_all "fix: limit export retries" "2026-09-24T09:00:00+00:00"
printf '\n// Second correction backs off between retries.\n' >> src/export/csv.js
commit_all "fix: back off between export retries" "2026-09-25T09:00:00+00:00"
last_reviewed="$(head_sha)"
printf '\n// Authorized fix keeps the retry count per export.\n' >> src/export/csv.js
commit_all "fix: keep retry count per export" "2026-09-26T09:00:00+00:00"
printf '\n// Authorized fix resets the count on success.\n' >> src/export/csv.js
commit_all "fix: reset retry count on success" "2026-09-26T10:00:00+00:00"
mkdir -p runs/review
cat > runs/review/findings.json <<JSON
{"status":"cap-reached","fix_cycles":2,"exhausted_action":"replan","decision":"one further fix authorized","reviewed_revision":"$last_reviewed","findings":[
{"id":"F-RTY-1","severity":"P1","status":"closed","title":"retries never stop"},
{"id":"F-RTY-2","severity":"P2","status":"open","title":"retry count is shared across exports"}]}
JSON
