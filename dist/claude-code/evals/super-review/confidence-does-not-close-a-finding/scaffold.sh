#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
mkdir -p runs/review
cat > runs/review/findings.json <<JSON
{"reviewed_revision":"$(head_sha)","findings":[{"id":"F-RACE-1","status":"open","title":"Concurrent refresh can overwrite a newer session","reviewer_votes":["not-reproduced","not-reproduced"],"classifier_likelihood":0.12,"implementer_claim":"fixed last week","verification":null,"closure_policy":"independent evidence bound to the reviewed revision"}]}
JSON
