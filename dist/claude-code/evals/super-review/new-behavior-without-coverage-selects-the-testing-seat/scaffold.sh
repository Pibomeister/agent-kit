#!/usr/bin/env bash
# Scaffold for evals/super-review/new-behavior-without-coverage-selects-the-testing-seat.
#
# tiny-service-repo with ticket AK-512 on main, then branch
# AK-512-renewal-grace-period whose one commit adds the grace-period branch to
# isActive (src/billing/renewal.js) and the billing.gracePeriod key, off, to
# src/config/defaults.js and config/production.json. No test file changes:
# test/billing/renewal.test.js still passes and never reaches the new branch.
# Base main, head the branch tip; the requirement is tickets/AK-512.md and
# the declared standards are STANDARDS.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
tickets_copy AK-512
commit_all "tickets: export AK-512" "2026-09-19T10:00:00+00:00"
git checkout -q -b AK-512-renewal-grace-period

cat > src/billing/renewal.js <<'JS'
'use strict';

const defaults = require('../config/defaults');

const GRACE_PERIOD_HOURS = 72;

function isActive(account, now = new Date(), config = defaults) {
  if (!account) throw new TypeError('isActive: account is required');
  if (account.status === 'cancelled') return false;
  if (new Date(account.paidThrough) > now) return true;
  if (config.billing.gracePeriod && account.lastChargeFailedAt) {
    const graceEnds = new Date(account.lastChargeFailedAt).getTime() + GRACE_PERIOD_HOURS * 3600 * 1000;
    return now.getTime() < graceEnds;
  }
  return false;
}

module.exports = { isActive, GRACE_PERIOD_HOURS };
JS
sed -i.bak 's/  billing: {},/  billing: { gracePeriod: false },/' src/config/defaults.js && rm src/config/defaults.js.bak
cat > config/production.json <<'JSON'
{
  "session": { "timeoutSeconds": 3600 },
  "rateLimit": { "windowMs": 60000, "max": 300 },
  "billing": { "gracePeriod": false }
}
JSON
commit_all "AK-512: keep accounts active for 72h after a failed renewal charge" "2026-09-25T14:05:00+00:00"

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
