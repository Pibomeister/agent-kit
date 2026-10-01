#!/usr/bin/env bash
#
# The no-file grader (file_exists, path "**", exists: false) counts only files
# created after this scaffold returns. Host claude 2.1.285, bundled eval runner,
# per-run function og: it runs the scaffold, lists the working directory
# (X = Xi(cwd)), runs the agent, lists it again (me = Xi(cwd)) and hands the
# graders cwdDiff = lg(X, me), the paths in the second listing absent from the
# first. Read from the host binary; no run has exercised it on this case.
#
# Both listings walk every directory, .git included, and this case grants Bash
# in a repository. A git command that writes a new file under .git (a branch, a
# stash, a commit, a fetch) therefore counts as a created file and fails the
# no-file grader although no documentation path was written. The case is tagged
# needs-fixture and stays out of difference claims.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
mkdir -p evidence
cat > evidence/migration-ordering.md <<'MD'
# Migration ordering correction

The application deploy failed when code that reads `billing_state` shipped before the expanding
migration. The repair shipped the additive migration first, waited for every shard, then deployed
the reader. Tests and the deployment check are green. The lesson has not been drafted or published.
MD
commit_all "evidence: record migration ordering correction" "2026-09-25T09:00:00+00:00"
