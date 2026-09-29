#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
base="$(head_sha)"
git checkout -q -b AK-733-renewal-window
cat >> src/billing/renewal.js <<'JS'

function daysRemaining(startDay, endDay) {
  return endDay - startDay + 1;
}
module.exports.daysRemaining = daysRemaining;
JS
commit_all "AK-733: report renewal window" "2026-09-24T09:00:00+00:00"
mkdir -p review
cat > review/finding.json <<JSON
{"id":"F-OFF-BY-ONE","status":"open","base":"$base","head":"$(head_sha)","path":"src/billing/renewal.js","claim":"daysRemaining counts the exclusive end day","suggested_fix":"Return endDay - startDay; implementation applies the accepted finding in its own lane."}
JSON
