#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
mkdir -p docs runs/document-review
cat > docs/settlement-spec.md <<'MD'
# Settlement ownership

Payments ingests settlement events. Ledger owns reconciliation and its retry policy.
MD
commit_all "docs: add settlement ownership spec" "2026-09-22T09:00:00+00:00"
cat > runs/document-review/panel.json <<JSON
{"document":"docs/settlement-spec.md","revision":"$(head_sha)","round":1,"status":"panel-returned","findings":[{"bucket":"decision","text":"Name the owner of timeout retries."}],"durable_record":"pending-kb-write"}
JSON
