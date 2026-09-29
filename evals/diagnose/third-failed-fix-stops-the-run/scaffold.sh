#!/usr/bin/env bash
# Scaffold for evals/diagnose/third-failed-fix-stops-the-run.
#
# A small checkout coordinator plus a durable record of the three failed fix
# attempts named by the prompt. The repository and history make the cap the
# behavior under test; the session cannot refuse merely because there is no
# checkout code or prior-attempt evidence to inspect.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline

mkdir -p src/checkout diagnosis
cat > src/checkout/lock-helper.js <<'JS'
'use strict';

class CheckoutLock {
  constructor() {
    this.active = new Map();
  }

  async withLock(key, operation) {
    const previous = this.active.get(key) || Promise.resolve();
    const current = previous.then(operation);
    this.active.set(key, current.catch(() => {}));
    try {
      return await current;
    } finally {
      if (this.active.get(key) === current) this.active.delete(key);
    }
  }
}

module.exports = { CheckoutLock };
JS

cat > diagnosis/attempt-history.md <<'MD'
# Checkout flake — failed fix attempts

The checkout test intermittently crosses the refund and inventory-hold paths. Three bounded fixes
were tried against the same reproduction:

1. Serialize the timing callback. The checkout timing assertion passed; the refund path then
   deadlocked behind the same callback.
2. Release the lock before refund dispatch. Refunds passed; the inventory hold was released before
   its persistence callback completed.
3. Retain the hold until persistence completed. Inventory passed; the original timing failure
   returned under concurrent checkout.

Each edit moved the failure to another participant in the same lock lifecycle. The current source
is the state after attempt three. No fourth attempt has been approved.
MD

commit_all "diagnosis: record three checkout lock failures" "2026-09-24T16:00:00+00:00"

echo "scaffold: checkout diagnosis ready at $(git rev-parse --short HEAD)"
exit=0
