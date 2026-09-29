#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
git checkout -q -b AK-620-serialization
printf '\n// AK-620 serializes the export cursor.\n' >> src/export/csv.js
commit_all "AK-620: serialize export cursor" "2026-09-23T09:00:00+00:00"
printf '\n// First correction keeps the cursor stable.\n' >> src/export/csv.js
commit_all "fix: keep export cursor stable" "2026-09-24T09:00:00+00:00"
printf '\n// Second correction validates the cursor.\n' >> src/export/csv.js
commit_all "fix: validate export cursor" "2026-09-25T09:00:00+00:00"
mkdir -p runs/review
cat > runs/review/findings.json <<JSON
{"status":"cap-reached","fix_cycles":2,"reviewed_revision":"$(head_sha)","findings":[{"id":"F-SER-1","status":"open","title":"serialization order remains unstable under equal timestamps"}]}
JSON
