#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
git checkout -q -b AK-640-import-notes
printf '\n// AK-640 imports formatted notes.\n' >> src/export/csv.js
commit_all "AK-640: import formatted notes" "2026-09-23T09:00:00+00:00"
printf '\n// First correction caps nesting depth.\n' >> src/export/csv.js
commit_all "fix: cap note nesting depth" "2026-09-24T09:00:00+00:00"
printf '\n// Second correction caps total length.\n' >> src/export/csv.js
commit_all "fix: cap note length" "2026-09-25T09:00:00+00:00"
mkdir -p runs/review
cat > runs/review/findings.json <<JSON
{"status":"cap-reached","fix_cycles":2,"reviewed_revision":"$(head_sha)","findings":[
{"id":"F-IMP-1","severity":"P1","status":"closed","cycle":1,"theme":"parse cost of untrusted input","title":"deep nesting makes the parser slow"},
{"id":"F-IMP-2","severity":"P1","status":"closed","cycle":2,"theme":"parse cost of untrusted input","title":"a long document makes the parser slow"},
{"id":"F-IMP-3","severity":"P1","status":"open","cycle":2,"theme":"parse cost of untrusted input","title":"a long run of attributes makes the parser slow"}]}
JSON
