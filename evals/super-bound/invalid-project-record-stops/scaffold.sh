#!/usr/bin/env bash
#
# The same unattended premise, with a committed project record that fails
# schemas/project.schema.json: it lacks the required identity, kb, standards, limits and
# tracker_policy blocks, and its pr_size guidance claims an enforcement other than advisory.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../unattended-without-project-record-continues-unscored/scaffold.sh"

cat > project.json <<'JSON'
{
  "guidance": {
    "pr_size": { "target_changed_lines": 100, "enforcement": "blocking" }
  }
}
JSON
commit_all "chore: add the project record"
git update-ref refs/remotes/origin/main HEAD
