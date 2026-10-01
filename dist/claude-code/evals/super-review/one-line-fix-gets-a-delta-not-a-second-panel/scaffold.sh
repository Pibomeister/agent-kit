#!/usr/bin/env bash
# Scaffold for evals/super-review/one-line-fix-gets-a-delta-not-a-second-panel.
#
# tiny-service-repo, then branch AK-488-record-failed-charges:
#   1. "AK-488: record failed charges" -- handleWebhook gains a charge.failed
#      branch that dereferences the account without a null check. This is the
#      head round one reviewed.
#   2. "fix: guard unknown customer on charge.failed" -- the one-line guard
#      plus a test. This is the fix under re-review.
# The open review run from round one sits untracked under runs/AK-488/review/:
# run.json (mode full, in progress, base and reviewed head, input hashes,
# lane table) and findings.json (fingerprints and dispositions: the accepted
# null-check finding, an accepted missing-test finding, and a deferred P3
# maintainability nit unrelated to the fix).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
base="$(head_sha)"
git checkout -q -b AK-488-record-failed-charges

cat > src/payments/webhook.js <<'JS'
'use strict';

function handleWebhook(event, { accounts }) {
  if (!event || !event.type || !event.data) throw new TypeError('handleWebhook: malformed event');
  const customerId = event.data.object.customer;
  if (event.type === 'charge.succeeded') {
    const account = accounts.findByCustomer(customerId);
    if (!account) return { handled: false, reason: 'unknown-customer' };
    account.paidThrough = new Date(event.data.object.period_end * 1000).toISOString();
    return { handled: true, accountId: account.id };
  }
  if (event.type === 'charge.failed') {
    const account = accounts.findByCustomer(customerId);
    account.lastChargeFailedAt = new Date(event.created * 1000).toISOString();
    return { handled: true, accountId: account.id };
  }
  return { handled: false, reason: 'ignored-type' };
}

module.exports = { handleWebhook };
JS
cat >> test/payments/webhook.test.js <<'JS'

test('a failed charge records when it failed', () => {
  const account = { id: 'a1', customer: 'cus_1' };
  const event = { type: 'charge.failed', created: 1790000000, data: { object: { customer: 'cus_1' } } };
  assert.deepEqual(handleWebhook(event, { accounts: accountsWith(account) }), { handled: true, accountId: 'a1' });
  assert.equal(account.lastChargeFailedAt, new Date(1790000000 * 1000).toISOString());
});
JS
commit_all "AK-488: record failed charges" "2026-09-23T11:00:00+00:00"
round1="$(head_sha)"
webhook_hash="$(file_sha256 src/payments/webhook.js)"
test_hash="$(file_sha256 test/payments/webhook.test.js)"

sed -i.bak 's/^    account.lastChargeFailedAt = /    if (!account) return { handled: false, reason: '"'"'unknown-customer'"'"' };\n&/' src/payments/webhook.js
rm src/payments/webhook.js.bak
cat >> test/payments/webhook.test.js <<'JS'

test('a failed charge for an unknown customer is not handled', () => {
  const event = { type: 'charge.failed', created: 1790000000, data: { object: { customer: 'cus_x' } } };
  assert.deepEqual(handleWebhook(event, { accounts: accountsWith() }), { handled: false, reason: 'unknown-customer' });
});
JS
commit_all "fix: guard unknown customer on charge.failed" "2026-09-25T16:10:00+00:00"

mkdir -p runs/AK-488/review
cat > runs/AK-488/review/run.json <<JSON
{
  "id": "rv-AK-488",
  "mode": "full",
  "status": "in-progress",
  "round": 1,
  "comparison_base": { "revision": "$base", "ref": "main" },
  "reviewed_head": { "revision": "$round1", "ref": "AK-488-record-failed-charges" },
  "requirements": ["AK-488: record the time of a failed charge on the account; unknown customers are ignored, as for charge.succeeded"],
  "input_hashes": {
    "src/payments/webhook.js": "sha256:$webhook_hash",
    "test/payments/webhook.test.js": "sha256:$test_hash"
  },
  "lanes": [
    { "seat": "correctness", "state": "covered" },
    { "seat": "standards", "state": "covered" },
    { "seat": "testing", "state": "covered" },
    { "seat": "maintainability", "state": "covered" },
    { "seat": "security", "state": "skipped", "reason": "no auth, tenancy or input-trust surface in the change" }
  ],
  "verdict": "changes-requested",
  "fix_cycles": 0,
  "findings": "findings.json"
}
JSON
cat > runs/AK-488/review/findings.json <<'JSON'
[
  {
    "id": "F-1",
    "title": "charge.failed dereferences the account without a null check",
    "lane": "correctness",
    "severity": "P1",
    "status": "accepted",
    "fingerprint": { "inputs": { "cause": "null-dereference", "symbol": "handleWebhook charge.failed", "path": "src/payments/webhook.js" } },
    "evidence": [
      { "location": "src/payments/webhook.js handleWebhook", "observation": "account.lastChargeFailedAt = ... runs when findByCustomer returned null; charge.succeeded guards the same case." }
    ],
    "suggested_fix": { "summary": "Return { handled: false, reason: 'unknown-customer' } when no account matches, as the charge.succeeded branch does." },
    "disposition": "accepted",
    "verification": [{ "check": "A charge.failed event for an unknown customer is not handled and does not throw." }]
  },
  {
    "id": "F-2",
    "title": "No test covers charge.failed for an unknown customer",
    "lane": "testing",
    "severity": "P2",
    "status": "accepted",
    "fingerprint": { "inputs": { "cause": "untested-branch", "symbol": "handleWebhook charge.failed", "path": "test/payments/webhook.test.js" } },
    "evidence": [
      { "location": "test/payments/webhook.test.js", "observation": "Only the known-customer path of charge.failed is exercised." }
    ],
    "disposition": "accepted",
    "verification": [{ "check": "A test sends charge.failed for an unknown customer." }]
  },
  {
    "id": "F-3",
    "title": "Seconds-to-ISO conversion is repeated inline",
    "lane": "maintainability",
    "severity": "P3",
    "status": "open",
    "fingerprint": { "inputs": { "cause": "duplicated-conversion", "symbol": "handleWebhook", "path": "src/payments/webhook.js" } },
    "evidence": [
      { "location": "src/payments/webhook.js handleWebhook", "observation": "new Date(x * 1000).toISOString() appears in both branches." }
    ],
    "disposition": "deferred",
    "disposition_note": "Not blocking; candidate for a later cleanup ticket."
  }
]
JSON

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
