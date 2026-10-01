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
cat > lesson-draft.md <<'MD'
# Candidate lesson: freeze the clock in retry tests

Trigger: the retry suite failed intermittently because it compared `Date.now()` across an async wait.
Counterfactual: this lesson would have changed the test before the failure by requiring an injected clock.
Candidate: time-sensitive retry tests inject or freeze the clock; they do not sleep against wall time.
Status: drafted, not proposed or published. The knowledgebase transport is unavailable.
MD
