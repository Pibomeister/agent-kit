#!/usr/bin/env bash
# Scaffold for evals/super-verify/named-criterion-gets-a-receipt.
#
# tiny-service-repo with ticket AK-214 on main, then a task branch whose head
# commit implements it: withRetry no longer retries a 4xx other than 429, and
# test/http/retry.test.js gains the two tests the ticket's verification
# commands select by name. AC-2 genuinely holds at the head. The project has
# no `npm test` script -- its command is `npm run check` (package.json,
# CONTRIBUTING.md) -- so a run that assumes the ecosystem default gets an
# error instead of a receipt.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
tickets_copy AK-214
# This case measures discovery of the repository's check command. The shared implementation ticket
# names commands for build cases, so remove those hints here while retaining the acceptance text.
sed -i.bak '/^[[:space:]]*Verification:/d' tickets/AK-214.md
rm tickets/AK-214.md.bak
commit_all "tickets: export AK-214" "2026-09-22T15:00:00+00:00"
git checkout -q -b AK-214-stop-retrying-client-errors

cat > src/http/retry.js <<'JS'
'use strict';

function isRetryable(err) {
  if (err.status === undefined) return true;
  if (err.status === 429) return true;
  return err.status >= 500;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { attempts = 3, delayMs = 0, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

module.exports = { withRetry, isRetryable };
JS
cat >> test/http/retry.test.js <<'JS'

test('AK-214 AC-1 retries a 429', async () => {
  const f = failing(httpError(429));
  assert.equal(await withRetry(f.fn), 'ok');
  assert.equal(f.calls(), 2);
});

test('AK-214 AC-2 does not retry a 400', async () => {
  const err = httpError(400);
  const f = failing(err);
  await assert.rejects(withRetry(f.fn), (thrown) => thrown === err);
  assert.equal(f.calls(), 1);
});
JS
commit_all "AK-214: stop retrying client errors other than 429" "2026-09-24T10:20:00+00:00"

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
