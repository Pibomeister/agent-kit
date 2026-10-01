#!/usr/bin/env bash
# Scaffold for evals/super-review/delta-reaches-an-untouched-affected-caller.
#
# tiny-service-repo, then branch AK-230-retry-backoff:
#   1. "AK-230: exponential backoff in withRetry" -- the head round one
#      reviewed. Round one accepted a P1 finding that withRetry retries every
#      4xx, so a rejected request is re-sent.
#   2. "fix: stop retrying client errors" -- the retry-policy fix, touching
#      exactly src/http/retry.js and test/http/retry.test.js.
# The fix is correct for what the finding asked, and it breaks a caller the
# diff does not touch: src/sync/client.js refreshes the token on a 401 and
# throws so withRetry retries with the new token. After the fix a 401 is no
# longer retried, so every sync whose token has expired now fails outright.
# Nothing tests that path, so the suite stays green. The open review run
# from round one sits untracked under runs/AK-230/review/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
base="$(head_sha)"
git checkout -q -b AK-230-retry-backoff

sed -i.bak 's/      await sleep(delayMs \* attempt);/      await sleep(delayMs * 2 ** (attempt - 1));/' src/http/retry.js && rm src/http/retry.js.bak
cat >> test/http/retry.test.js <<'JS'

test('backs off exponentially between attempts', async () => {
  const waits = [];
  const f = failing(httpError(503), httpError(503));
  await withRetry(f.fn, { attempts: 3, delayMs: 100, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [100, 200]);
});
JS
commit_all "AK-230: exponential backoff in withRetry" "2026-09-22T10:00:00+00:00"
round1="$(head_sha)"
retry_hash="$(file_sha256 src/http/retry.js)"
test_hash="$(file_sha256 test/http/retry.test.js)"

sed -i.bak 's/^  return err.status >= 400;/  if (err.status === 429) return true;\n  return err.status >= 500;/' src/http/retry.js && rm src/http/retry.js.bak
cat >> test/http/retry.test.js <<'JS'

test('does not retry a client error other than 429', async () => {
  const f = failing(httpError(400));
  await assert.rejects(withRetry(f.fn), { status: 400 });
  assert.equal(f.calls(), 1);
});

test('still retries a 429', async () => {
  const f = failing(httpError(429));
  assert.equal(await withRetry(f.fn), 'ok');
});
JS
commit_all "fix: stop retrying client errors" "2026-09-25T15:30:00+00:00"

mkdir -p runs/AK-230/review
cat > runs/AK-230/review/run.json <<JSON
{
  "id": "rv-AK-230",
  "mode": "full",
  "status": "in-progress",
  "round": 1,
  "comparison_base": { "revision": "$base", "ref": "main" },
  "reviewed_head": { "revision": "$round1", "ref": "AK-230-retry-backoff" },
  "requirements": ["AK-230: withRetry backs off exponentially between attempts"],
  "input_hashes": {
    "src/http/retry.js": "sha256:$retry_hash",
    "test/http/retry.test.js": "sha256:$test_hash"
  },
  "lanes": [
    { "seat": "correctness", "state": "covered" },
    { "seat": "standards", "state": "covered" },
    { "seat": "testing", "state": "covered" },
    { "seat": "security", "state": "skipped", "reason": "no auth, tenancy or input-trust surface in the change" }
  ],
  "verdict": "changes-requested",
  "fix_cycles": 0,
  "findings": "findings.json"
}
JSON
cat > runs/AK-230/review/findings.json <<'JSON'
[
  {
    "id": "F-1",
    "title": "withRetry retries every 4xx, so a rejected request is re-sent",
    "lane": "correctness",
    "severity": "P1",
    "status": "accepted",
    "fingerprint": { "inputs": { "cause": "retries-client-errors", "symbol": "isRetryable", "path": "src/http/retry.js" } },
    "evidence": [
      { "location": "src/http/retry.js isRetryable", "observation": "return err.status >= 400; -- a 400 or 409 is sent up to three times, now with growing delays." }
    ],
    "suggested_fix": { "summary": "Retry only 5xx, 429 and failures with no status." },
    "disposition": "accepted",
    "verification": [{ "check": "A 400 is attempted once; a 429 is still retried." }]
  },
  {
    "id": "F-2",
    "title": "Backoff has no upper bound",
    "lane": "correctness",
    "severity": "P3",
    "status": "open",
    "fingerprint": { "inputs": { "cause": "unbounded-backoff", "symbol": "withRetry", "path": "src/http/retry.js" } },
    "evidence": [
      { "location": "src/http/retry.js withRetry", "observation": "delayMs * 2 ** (attempt - 1) grows without a cap if attempts is raised." }
    ],
    "disposition": "deferred",
    "disposition_note": "attempts defaults to 3; revisit if a caller raises it."
  }
]
JSON

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
