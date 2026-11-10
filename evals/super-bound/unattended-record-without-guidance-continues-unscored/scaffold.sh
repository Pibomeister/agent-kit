#!/usr/bin/env bash
#
# The same unattended premise, with a committed project record that passes
# schemas/project.schema.json but carries no guidance.delegation block. The repository-local `ak`
# reports what `ak delegation` reports for this record (src/delegation.ts): the missing guidance.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../unattended-without-project-record-continues-unscored/scaffold.sh"

cat > project.json <<'JSON'
{
  "schema": "project",
  "schema_version": 1,
  "id": "tiny-service-project",
  "project": { "id": "tiny-service", "repo": "example/tiny-service" },
  "run_id": null,
  "created_by": { "role": "human" },
  "inputs": [],
  "source_revision": null,
  "created_at": "2026-09-30T12:00:00Z",
  "status": "active",
  "identity": {
    "id": "tiny-service",
    "name": "Tiny service",
    "repos": [{ "repo": "example/tiny-service", "role": "application", "default_branch": "main" }]
  },
  "kb": { "ownership": "central", "root": "example/kb", "project_path": "projects/tiny-service" },
  "standards": [],
  "limits": { "fix_cycles": 2, "consensus_rounds": 3, "scout_turns": 4 },
  "guidance": {
    "pr_size": { "target_changed_lines": 100, "enforcement": "advisory" },
    "test_pyramid": { "unit_percent": 80, "integration_percent": 15, "end_to_end_percent": 5, "enforcement": "advisory" },
    "exceptions": []
  },
  "tracker_policy": { "system_of_record": { "system": "knowledgebase" } }
}
JSON
cat > ak <<'STUB'
#!/usr/bin/env sh
if [ "$1" != delegation ] || [ "$3" != --project ] || [ "$#" -ne 4 ]; then
  echo 'ak delegation: needs exactly one ticket path and --project <path>' >&2
  exit 2
fi
echo 'ak delegation: project has no guidance.delegation block (weights and cut points)' >&2
exit 1
STUB
chmod +x ak
commit_all "chore: add the project record without delegation guidance"
git update-ref refs/remotes/origin/main HEAD
