#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
mkdir -p tickets
cat > tickets/BILL-412.md <<'MD'
# BILL-412 — Reject duplicate settlement imports

Status: reviewed and approved. Goal: reject a settlement file whose digest was already imported.
Non-goals: changing settlement parsing or reconciliation.
Acceptance: duplicate digest returns `duplicate`; first import still succeeds; audit event names the digest.
Owned files: `src/import/pipeline.js`, `test/import/pipeline.test.js`.
Verification: `npm run check -- --test-name-pattern="BILL-412"`.
MD
commit_all "tickets: add reviewed BILL-412" "2026-09-24T09:00:00+00:00"
