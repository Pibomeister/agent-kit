#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
git checkout -q -b AK-812-retry-cap
printf '\n// AK-812 caps provider retries at three attempts.\n' >> src/http/retry.js
commit_all "AK-812: document retry cap" "2026-09-24T09:00:00+00:00"
mkdir -p review
cat > review/comments.json <<JSON
{"pull_request":812,"base":"$(git rev-parse main)","head":"$(head_sha)","threads":[{"id":"T-1","path":"src/http/retry.js","claim":"The retry cap is not enforced."},{"id":"T-2","path":"src/http/retry.js","claim":"The comment should name the provider."}]}
JSON
