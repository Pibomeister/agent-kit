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
mkdir -p runs/alignment
cat > runs/alignment/approved.json <<JSON
{"topic":"settlement ownership","status":"approved","revision":"$(head_sha)","restatement":"Payments ingests settlement events; ledger owns reconciliation and timeout retries.","approval":{"by":"human","at":"2026-09-25T10:00:00Z"},"publication":"pending-kb-write"}
JSON
