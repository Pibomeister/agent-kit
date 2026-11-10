#!/usr/bin/env bash
#
# The unattended policy is active from the default branch: ak.lifecycle.json is committed and
# refs/remotes/origin/HEAD points at that commit, which is where the policy is read (never the
# working tree). No agent-kit project record exists, so there is no delegation guidance.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
cat > ak.lifecycle.json <<'JSON'
{ "policy": "unattended" }
JSON
mkdir -p specs runs
cat > specs/approved.md <<'MD'
# Approved spec: retry client errors

Status: approved at the current revision; the document review left no open decision.
A 400 response is returned without retry; 429 and server errors retain retry.
Owned files: `src/http/retry.js`, `test/http/retry.test.js`.
Acceptance: a 400 runs once; a 429 retries; existing server-error behavior remains.
Verification: `npm test`.
MD
commit_all "chore: opt into the unattended lifecycle policy"
git update-ref refs/remotes/origin/main HEAD
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
