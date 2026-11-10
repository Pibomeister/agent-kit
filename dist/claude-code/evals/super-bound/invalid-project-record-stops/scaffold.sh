#!/usr/bin/env bash
#
# The same unattended premise, with a committed project record that fails
# schemas/project.schema.json: it lacks the required envelope, identity, kb, standards, limits and
# tracker_policy blocks, and its pr_size guidance claims an enforcement other than advisory. The
# repository-local `ak` reports what the real `ak delegation` reports for this record on an unscored
# draft ticket; tests/delegation-coverage-limit.test.ts runs both on this scaffold and requires the
# same exit and stderr.
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
cat > ak <<'STUB'
#!/usr/bin/env sh
if [ "$1" != delegation ] || [ "$3" != --project ] || [ "$#" -ne 4 ]; then
  echo 'ak delegation: needs exactly one ticket path and --project <path>' >&2
  exit 2
fi
echo "ak delegation: project does not match its schema: (root) must have required property 'schema'; (root) must have required property 'schema_version'; (root) must have required property 'id'; (root) must have required property 'project'" >&2
exit 1
STUB
chmod +x ak
commit_all "chore: add the project record"
git update-ref refs/remotes/origin/main HEAD
