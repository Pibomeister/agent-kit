#!/usr/bin/env bash
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
