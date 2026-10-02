#!/usr/bin/env bash
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
