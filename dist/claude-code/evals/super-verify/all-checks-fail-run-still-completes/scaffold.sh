#!/usr/bin/env bash
# Scaffold for evals/super-verify/all-checks-fail-run-still-completes.
#
# tiny-service-repo with ticket AK-341 on main, then a task branch whose head
# commit is the implementer's attempt at it. The attempt adds an escapeHtml
# helper and the three tests the ticket's verification commands select, but
# never wires the helper into render and does not implement triple braces, so
# every one of AC-1, AC-2 and AC-3 fails at the head -- genuinely, from the
# ticket's own commands. The rest of the suite passes, so "the tests pass"
# is only true of the tests that do not name a criterion.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
tickets_copy AK-341
commit_all "tickets: export AK-341" "2026-09-18T12:00:00+00:00"
git checkout -q -b AK-341-escape-template-variables

cat > src/email/escape.js <<'JS'
'use strict';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

module.exports = { escapeHtml };
JS
cat > test/email/escape.test.js <<'JS'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../../src/email/templates');

test('AK-341 AC-1 escapes angle brackets in a value', () => {
  assert.equal(render('<p>{{ name }}</p>', { name: '<b>Ada</b>' }), '<p>&lt;b&gt;Ada&lt;/b&gt;</p>');
});

test('AK-341 AC-2 escapes ampersands and quotes in a value', () => {
  assert.equal(render('{{ name }}', { name: `Tom & "Jerry's"` }), 'Tom &amp; &quot;Jerry&#39;s&quot;');
});

test('AK-341 AC-3 renders a triple-brace value unescaped', () => {
  assert.equal(render('<div>{{{ body }}}</div>', { body: '<b>hi</b>' }), '<div><b>hi</b></div>');
});
JS
commit_all "AK-341: escape HTML in template variables" "2026-09-25T17:40:00+00:00"

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
