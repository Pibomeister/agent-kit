#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
head="$(head_sha)"
mkdir -p runs/checkout-performance tickets
cat > runs/checkout-performance/alignment.json <<JSON
{
  "kind": "alignment-result",
  "status": "approved",
  "direction": "make checkout faster",
  "acceptance_criteria": ["make checkout faster"],
  "source_revision": "$head",
  "approval": {"by": "human", "at": "2026-09-30T16:10:00Z"}
}
JSON
cat > project.json <<'JSON'
{
  "guidance": {
    "delegation": {
      "weights": {"reversibility": 1, "size": 1, "complexity": 1, "spec": 1, "verification": 1},
      "cut_points": {"yellow_agent": 4, "yellow_owner": 7, "red": 10},
      "enforcement": "advisory"
    }
  }
}
JSON
cat > tickets/checkout-performance.input.json <<'JSON'
{
  "delegation": {
    "class": "green",
    "stage": "ticket",
    "floor": {"packs": [], "sensitive_actions": []},
    "factors": {
      "reversibility": {"score": 0, "evidence": ["No irreversible action is specified."]},
      "size": {"score": 0, "evidence": ["Size is unknown until the checkout path is named."]},
      "complexity": {"score": 1, "evidence": ["Performance work may affect a request path."]},
      "spec": {"score": 3, "evidence": ["The approved direction carries a single acceptance criterion."]},
      "verification": {"score": 0, "evidence": ["The alignment result is the only verification evidence supplied."]}
    },
    "lowered_by": null
  }
}
JSON
scorer_dir="$(mktemp -d "${TMPDIR:-/tmp}/ak-scorer.XXXXXX")"
cat > "$scorer_dir/scorer-output.json" <<'JSON'
{
  "class": "yellow-owner",
  "stage": "ticket",
  "floor": {"packs": [], "sensitive_actions": []},
  "factors": {
    "reversibility": {"score": 0, "evidence": ["No irreversible action is specified."]},
    "size": {"score": 0, "evidence": ["Size is unknown until the checkout path is named."]},
    "complexity": {"score": 1, "evidence": ["Performance work may affect a request path."]},
    "spec": {"score": 3, "evidence": ["The approved direction carries a single acceptance criterion."]},
    "verification": {"score": 0, "evidence": ["The alignment result is the only verification evidence supplied."]}
  },
  "lowered_by": null
}
JSON
cat > ak <<'SH'
#!/usr/bin/env sh
set -eu
if ! { [ "$#" -eq 4 ] && [ "$1" = delegation ] && [ "$3" = --project ]; }; then
  echo 'ak delegation: needs exactly one ticket path and --project <path>' >&2
  exit 2
fi
if ! { [ -f "$2" ] && [ -f "$4" ]; }; then
  echo 'ak delegation: ticket or project record does not exist' >&2
  exit 1
fi
SH
printf 'cat %q\n' "$scorer_dir/scorer-output.json" >> ak
chmod +x ak
