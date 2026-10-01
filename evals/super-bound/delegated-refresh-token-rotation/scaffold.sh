#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
node <<'NODE'
const fs = require('node:fs');
const path = 'src/session/store.js';
const text = fs.readFileSync(path, 'utf8');
fs.writeFileSync(path, text.replace(
  '  get(id) {',
  `  logout(id) {
    const current = this.get(id);
    this.records.delete(id);
    return current;
  }

  get(id) {`,
));
NODE
commit_all "fixture: add the approved logout path" "2026-09-30T15:55:00+00:00"
head="$(head_sha)"
mkdir -p tickets runs/refresh-rotation
cat > runs/refresh-rotation/alignment.json <<JSON
{
  "kind": "alignment-result",
  "status": "approved",
  "direction": "A logout removes the active session, and a later refresh attempt must not rotate or recreate its token.",
  "source_revision": "$head",
  "approval": {"by": "Maya Chen", "at": "2026-09-30T15:58:00Z"}
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
cat > tickets/refresh-rotation.input.json <<'JSON'
{
  "delegation": {
    "class": "green",
    "stage": "ticket",
    "floor": {"packs": ["pack-secure"], "sensitive_actions": ["trust-boundary-change"]},
    "factors": {
      "reversibility": {"score": 1, "evidence": ["The patch can be reverted."]},
      "size": {"score": 0, "evidence": ["The estimate is twelve changed lines in one module."]},
      "complexity": {"score": 1, "evidence": ["The existing rotation path is reused."]},
      "spec": {"score": 0, "evidence": ["The logout reproduction and expected rotation are explicit."]},
      "verification": {"score": 2, "evidence": ["A regression test reproduces logout before the fix."]}
    },
    "lowered_by": null
  }
}
JSON
cat > scorer-output.json <<'JSON'
{
  "class": "red",
  "stage": "ticket",
  "floor": {"packs": ["pack-secure"], "sensitive_actions": ["trust-boundary-change"]},
  "factors": {
    "reversibility": {"score": 1, "evidence": ["The patch can be reverted."]},
    "size": {"score": 0, "evidence": ["The estimate is twelve changed lines in one module."]},
    "complexity": {"score": 1, "evidence": ["The existing rotation path is reused."]},
    "spec": {"score": 0, "evidence": ["The logout reproduction and expected rotation are explicit."]},
    "verification": {"score": 2, "evidence": ["A regression test reproduces logout before the fix."]}
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
cat > advisor <<'SH'
#!/usr/bin/env sh
set -eu
printf '%s\n' 'Judgment: token rotation is authentication-sensitive. Keep human authorship; agent assistance may cover regression tests. Consultation grants no authority.'
SH
chmod +x ak advisor
