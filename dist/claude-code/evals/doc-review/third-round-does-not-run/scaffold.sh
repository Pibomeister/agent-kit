#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
mkdir -p plans runs/settlement
cat > plans/settlement.md <<'MD'
# Settlement reconciliation plan

The ledger team owns the reconciliation job. The payments team owns settlement ingestion.
The remaining fork is who owns retries after a reconciliation timeout.
MD
commit_all "docs: add settlement reconciliation plan" "2026-09-22T09:00:00+00:00"
cat > runs/settlement/review.json <<JSON
{"status":"cap-reached","rounds_completed":2,"document":"plans/settlement.md","revision":"$(head_sha)","open_fork":"ownership of retries after a reconciliation timeout","findings":[{"round":1,"disposition":"revised"},{"round":2,"disposition":"open-decision"}]}
JSON
