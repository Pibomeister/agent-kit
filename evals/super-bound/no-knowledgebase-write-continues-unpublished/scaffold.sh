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
mkdir -p specs
cat > specs/approved.md <<'MD'
# Approved spec: retry client errors

Status: approved. A 400 response is returned without retry; 429 and server errors retain retry.
Owned files: `src/http/retry.js`, `test/http/retry.test.js`.
Acceptance: a 400 runs once; a 429 retries; existing server-error behavior remains.
Publication: pending kb-write.
MD
