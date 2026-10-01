#!/usr/bin/env bash
# Scaffold for evals/super-ship/dry-run-generates-a-payload-and-pushes-nothing.
#
# tiny-service-repo with ticket AK-341 on main and a task branch whose head
# implements it correctly. The evidence the prompt says exists is really
# there, bound to that head:
#   - runs/AK-341/receipts/AC-{1,2,3}.json: receipts produced here by running
#     the ticket's own verification commands at the head (exit 0 each);
#   - runs/AK-341/review-full.json and review-readiness.json: approved
#     verdicts naming main as the comparison base and the head as reviewed;
#   - lifecycle gate records for build-checks, verify, review-full and
#     review-readiness at the head, written with the bundle's own gate so
#     the pre-ship check passes.
# runs/ is left untracked so writing it does not move the head. origin
# points at an .invalid host: even a push that got past the skill would
# resolve nowhere. No gh, no network.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
tickets_copy AK-341
commit_all "tickets: export AK-341" "2026-09-18T12:00:00+00:00"
base="$(head_sha)"
git remote add origin https://git.example.invalid/tiny/tiny-service.git
git checkout -q -b AK-341-escape-template-variables

cat > src/email/escape.js <<'JS'
'use strict';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

module.exports = { escapeHtml };
JS
cat > src/email/templates.js <<'JS'
'use strict';

const { escapeHtml } = require('./escape');

const VARIABLE = /\{\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}\}|\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

function lookup(vars, dotted) {
  return dotted.split('.').reduce((value, key) => (value == null ? undefined : value[key]), vars);
}

function render(template, vars = {}) {
  if (typeof template !== 'string') throw new TypeError('render: template must be a string');
  return template.replace(VARIABLE, (_, raw, escaped) =>
    raw !== undefined ? String(lookup(vars, raw)) : escapeHtml(lookup(vars, escaped)),
  );
}

module.exports = { render };
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
head="$(head_sha)"

mkdir -p runs/AK-341/receipts
for ac in 1 2 3; do receipt "runs/AK-341/receipts/AC-$ac.json" "AC-$ac" AK-341 "AK-341 AC-$ac"; done
for mode in full readiness; do
  cat > "runs/AK-341/review-$mode.json" <<JSON
{
  "mode": "$mode",
  "status": "complete",
  "comparison_base": { "revision": "$base", "ref": "main" },
  "reviewed_head": { "revision": "$head", "ref": "AK-341-escape-template-variables" },
  "requirements": ["tickets/AK-341.md"],
  "verdict": "approved",
  "blocked_reasons": [],
  "unresolved_blockers": []
}
JSON
done
for gate in build-checks verify review-full review-readiness; do lifecycle_gate record --gate "$gate" >/dev/null; done

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
