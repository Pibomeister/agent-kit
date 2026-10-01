#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
head="$(head_sha)"
mkdir -p runs/order-ledger tickets
cat > runs/order-ledger/alignment.json <<JSON
{
  "kind": "alignment-result",
  "status": "approved",
  "direction": "Move order totals to the ledger-backed representation through an additive schema, flagged write path, API consumer migration, backfill and later removal of the old columns.",
  "non_goals": ["Changing pricing rules."],
  "source_revision": "$head",
  "approval": {"by": "human", "at": "2026-09-30T16:20:00Z"}
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
cat > tickets/order-ledger.input.json <<'JSON'
{
  "delegation": {
    "class": "green",
    "stage": "ticket",
    "floor": {"packs": ["pack-data"], "sensitive_actions": []},
    "factors": {
      "reversibility": {"score": 2, "evidence": ["The old columns stay in place until a later removal."]},
      "size": {"score": 3, "evidence": ["The estimate is nine hundred changed lines across schema, behavior, consumer and backfill."]},
      "complexity": {"score": 2, "evidence": ["The change coordinates dual writes, a consumer transition and data movement."]},
      "spec": {"score": 0, "evidence": ["The approved direction names every delivery phase."]},
      "verification": {"score": 1, "evidence": ["Acceptance checks exist for part of the change."]}
    },
    "lowered_by": null
  }
}
JSON
cat > ak <<'SH'
#!/usr/bin/env sh
set -eu
if [ "$#" -ne 4 ]; then
  echo 'ak delegation: needs exactly one ticket path and --project <path>' >&2
  exit 2
fi
if [ "$1" != delegation ]; then
  echo 'ak delegation: needs exactly one ticket path and --project <path>' >&2
  exit 2
fi
if [ "$3" != --project ]; then
  echo 'ak delegation: needs exactly one ticket path and --project <path>' >&2
  exit 2
fi
if [ ! -f "$2" ] || [ ! -f "$4" ]; then
  echo 'ak delegation: ticket or project record does not exist' >&2
  exit 1
fi
cat <<'JSON'
{
  "class": "yellow-owner",
  "stage": "ticket",
  "floor": {"packs": ["pack-data"], "sensitive_actions": []},
  "factors": {
    "reversibility": {"score": 2, "evidence": ["The old columns stay in place until a later removal."]},
    "size": {"score": 3, "evidence": ["The estimate is nine hundred changed lines across schema, behavior, consumer and backfill."]},
    "complexity": {"score": 2, "evidence": ["The change coordinates dual writes, a consumer transition and data movement."]},
    "spec": {"score": 0, "evidence": ["The approved direction names every delivery phase."]},
    "verification": {"score": 1, "evidence": ["Acceptance checks exist for part of the change."]}
  },
  "lowered_by": null
}
JSON
SH
chmod +x ak
