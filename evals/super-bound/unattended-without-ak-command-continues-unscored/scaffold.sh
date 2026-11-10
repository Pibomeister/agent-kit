#!/usr/bin/env bash
#
# The unattended premise of a Factory sandbox: the policy is active from the default branch and the
# committed project record is valid and carries delegation guidance, but there is no `ak` CLI, only
# `node <bundle>/bin/ak-gate.mjs`. No repository-local `ak` is written, so `ak delegation` cannot run
# and the record's validity cannot be checked.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../unattended-record-without-guidance-continues-unscored/scaffold.sh"

rm -f ak
node - <<'NODE'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync("project.json", "utf8"));
record.guidance.delegation = {
  weights: { reversibility: 1, size: 1, complexity: 1, spec: 1, verification: 1 },
  cut_points: { yellow_agent: 4, yellow_owner: 7, red: 10 },
  enforcement: "advisory",
};
fs.writeFileSync("project.json", `${JSON.stringify(record, null, 2)}\n`);
NODE
commit_all "chore: add delegation guidance; this sandbox has no ak CLI"
git update-ref refs/remotes/origin/main HEAD
