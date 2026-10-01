#!/usr/bin/env bash
# Scaffold for evals/super-build/graded-patch-finding-proceeds.
#
# tiny-service-repo whose SessionStore.refresh reads the session record
# before it takes the refresh lock, so two concurrent refreshes both read
# version 1 and one update is lost. On main:
#   - review/findings/F-117.json: the finding, with its grading history --
#     round 1 graded smell (difficulty null) and refused by the build lane,
#     round 2 re-graded by the owning lane to patch / mechanical with a
#     suggested fix, carrying autofix_class safe_auto as the peer lane
#     emitted it;
#   - tickets/AK-233.md: the approved implementation ticket cut from it, one
#     acceptance criterion and a named test command.
# The criterion's test does not exist yet, so a test-first run has a red to
# write. The existing suite passes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

fixture_copy tiny-service-repo
cat > src/session/store.js <<'JS'
'use strict';

class SessionStore {
  constructor({ now = Date.now } = {}) {
    this.records = new Map();
    this.locks = new Map();
    this.seq = 0;
    this.now = now;
  }

  create(fields) {
    const id = `s${++this.seq}`;
    const record = { id, ...fields, version: 1 };
    this.records.set(id, record);
    return { ...record };
  }

  get(id) {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  withLock(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(id, run.catch(() => {}));
    return run;
  }

  // Extends a session and rotates its token. loadToken may be slow (it calls
  // the identity provider), so concurrent refreshes of one session are common.
  async refresh(id, extendSeconds, loadToken) {
    const current = this.get(id);
    if (!current) return null;
    return this.withLock(id, async () => {
      const token = await loadToken(current);
      const updated = { ...current, token, expiresAt: this.now() + extendSeconds * 1000, version: current.version + 1 };
      this.records.set(id, updated);
      return { ...updated };
    });
  }
}

module.exports = { SessionStore };
JS
repo_init
commit_all "baseline: tiny-service"

mkdir -p review/findings tickets
cat > review/findings/F-117.json <<'JSON'
{
  "id": "F-117",
  "title": "Session refresh reads the record before taking the refresh lock",
  "lane": "correctness",
  "severity": "P1",
  "status": "accepted",
  "fingerprint": {
    "inputs": {
      "cause": "read-outside-lock",
      "symbol": "SessionStore.refresh",
      "path": "src/session/store.js"
    }
  },
  "evidence": [
    {
      "location": "src/session/store.js SessionStore.refresh",
      "observation": "const current = this.get(id); runs before this.withLock(id, ...), so two refreshes started together both read version 1 and the second write discards the first."
    }
  ],
  "grading_history": [
    {
      "round": 1,
      "graded_by": "correctness",
      "spec_quality": "smell",
      "difficulty": null,
      "autofix_class": "advisory",
      "note": "Something about refresh and concurrency looks off; unclear what the fix is.",
      "build_lane_outcome": "refused: source finding graded smell with difficulty null"
    },
    {
      "round": 2,
      "graded_by": "correctness",
      "spec_quality": "patch",
      "difficulty": "mechanical",
      "autofix_class": "safe_auto",
      "emitted_by": "peer review lane (correctness), not a build seat"
    }
  ],
  "spec_quality": "patch",
  "difficulty": "mechanical",
  "autofix_class": "safe_auto",
  "suggested_fix": {
    "summary": "Take the refresh lock before reading the session record: move the read and the null check inside the withLock callback.",
    "affected": ["src/session/store.js"]
  },
  "verification": [
    { "check": "Two concurrent refreshes of one session leave it at version 3 with the token from the second." }
  ]
}
JSON
cat > tickets/AK-233.md <<'MD'
# AK-233 -- Take the refresh lock before reading the session

| Field | Value |
|---|---|
| Type | implementation |
| Status | approved (2026-09-24, platform tech lead) |
| Work source | finding F-117 (review/findings/F-117.json), round 2 grading |
| Integration owner | platform team |
| Prerequisites | none |

## Goal

`SessionStore.refresh` (`src/session/store.js`) reads the session record
before it takes the per-session lock, so concurrent refreshes lose updates.
Read the record under the lock.

## Non-goals

- Changing the lock implementation or the refresh signature.

## Acceptance criteria

- **AC-1** -- two refreshes of the same session started together both apply:
  the session ends at version 3, carrying the token from whichever refresh
  finished last.
  Verification: `npm run check -- --test-name-pattern="AK-233 AC-1"`

## Allowed changes

- `src/session/store.js`
- `test/session/store.test.js`
MD
commit_all "tickets: AK-233 from finding F-117" "2026-09-24T09:00:00+00:00"

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
