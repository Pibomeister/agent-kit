#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
cat > lesson-draft.md <<'MD'
# Candidate lesson: freeze the clock in retry tests

Trigger: the retry suite failed intermittently because it compared `Date.now()` across an async wait.
Counterfactual: this lesson would have changed the test before the failure by requiring an injected clock.
Candidate: time-sensitive retry tests inject or freeze the clock; they do not sleep against wall time.
Status: drafted, not proposed or published. The knowledgebase transport is unavailable.
MD
