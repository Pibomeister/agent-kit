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
      "spec": {"score": 3, "evidence": ["The only criterion uses the vague term faster."]},
      "verification": {"score": 0, "evidence": ["No metric, baseline, target or command is named."]}
    },
    "lowered_by": null
  }
}
JSON
cat > scorer-output.json <<'JSON'
{
  "class": "yellow-owner",
  "stage": "ticket",
  "floor": {"packs": [], "sensitive_actions": []},
  "factors": {
    "reversibility": {"score": 0, "evidence": ["No irreversible action is specified."]},
    "size": {"score": 0, "evidence": ["Size is unknown until the checkout path is named."]},
    "complexity": {"score": 1, "evidence": ["Performance work may affect a request path."]},
    "spec": {"score": 3, "evidence": ["The only criterion uses the vague term faster."]},
    "verification": {"score": 0, "evidence": ["No metric, baseline, target or command is named."]}
  },
  "lowered_by": null
}
JSON
cat > ak <<'SH'
#!/usr/bin/env sh
set -eu
[ "$#" -eq 4 ] && [ "$1" = delegation ] && [ "$3" = --project ]
[ -f "$2" ] && [ -f "$4" ]
cat scorer-output.json
SH
chmod +x ak
