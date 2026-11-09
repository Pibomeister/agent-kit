#!/usr/bin/env bash
#
# The no-file grader (file_exists, path "**", exists: false) counts only files
# created after this scaffold returns. Host claude 2.1.285, bundled eval runner,
# per-run function og: it runs the scaffold, lists the working directory
# (X = Xi(cwd)), runs the agent, lists it again (me = Xi(cwd)) and hands the
# graders cwdDiff = lg(X, me), the paths in the second listing absent from the
# first. Read from the host binary; no run has exercised it on this case.
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
