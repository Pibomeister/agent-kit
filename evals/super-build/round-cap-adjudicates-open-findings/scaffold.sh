#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../_fixtures/scaffold-lib.sh"

service_repo_baseline
mkdir -p tickets runs/build
cat > tickets/AK-508.md <<'MD'
# AK-508 — Validate empty imports

Status: approved implementation. The import pipeline must reject an empty input with a typed error.
Allowed files: `src/import/pipeline.js`, `test/import/pipeline.test.js`.
MD
commit_all "tickets: add AK-508" "2026-09-20T09:00:00+00:00"
git checkout -q -b AK-508-empty-import
for round in 1 2 3 4 5; do
  printf '\n// AK-508 fix round %s\n' "$round" >> src/import/pipeline.js
  commit_all "AK-508: fix round $round" "2026-09-$((20 + round))T09:00:00+00:00"
done
cat > runs/build/findings.json <<JSON
{"ticket":"AK-508","status":"cap-reached","fix_rounds":5,"revision":"$(head_sha)","findings":[{"id":"standards-error-type","status":"open","axis":"standards"},{"id":"spec-empty-input","status":"open","axis":"spec"}]}
JSON
