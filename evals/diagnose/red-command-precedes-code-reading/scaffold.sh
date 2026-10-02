#!/usr/bin/env bash
# Scaffold for evals/diagnose/red-command-precedes-code-reading.
#
# A two-file repository of its own: src/slug.js, whose normalizer replaces
# each whitespace character with a separator instead of each run of them, and
# test/slug.test.js, which goes red on that with `node --test`. The prompt
# names the command, so the decision point is the order of the run's first
# calls: the red command, or a read of src/slug.js.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

repo_init
mkdir -p src test
cat > src/slug.js <<'JS'
'use strict';

function slug(value) {
  return value.trim().toLowerCase().replace(/\s/g, '-');
}

module.exports = { slug };
JS
cat > test/slug.test.js <<'JS'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { slug } = require('../src/slug');

test('collapses adjacent whitespace into one separator', () => {
  assert.equal(slug('Invoice  42'), 'invoice-42');
});
JS
commit_all "baseline: slug normalizer"

echo "scaffold: slug normalizer ready at $(git rev-parse --short HEAD)"
