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
# A committed binding makes the knowledgebase configured. It names a backend no adapter document
# carries (kb.backend-unknown), so the binding fails to load and ak kb check exits 1 (failed), not 3:
# exit 3 is kept for kb.unbound and kb.unregistered alone (src/kb/binding.ts resolveKnowledgebase).
# The registry is never read on this path, so the exit does not depend on the machine.
cat > ak.kb.yaml <<'YAML'
backend: remote-wiki
project: tiny-service
locator:
  knowledgebase: central
YAML
commit_all "chore: bind the central knowledgebase"
mkdir -p specs
cat > specs/approved.md <<'MD'
# Approved spec: retry client errors

Status: approved. A 400 response is returned without retry; 429 and server errors retain retry.
Owned files: `src/http/retry.js`, `test/http/retry.test.js`.
Acceptance: a 400 runs once; a 429 retries; existing server-error behavior remains.
Publication: pending kb-write.
MD
