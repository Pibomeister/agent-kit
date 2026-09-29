#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
mkdir -p runs/alignment
cat > runs/alignment/approved.json <<JSON
{"topic":"settlement ownership","status":"approved","revision":"$(head_sha)","restatement":"Payments ingests settlement events; ledger owns reconciliation and timeout retries.","approval":{"by":"human","at":"2026-09-25T10:00:00Z"},"publication":"pending-kb-write"}
JSON
