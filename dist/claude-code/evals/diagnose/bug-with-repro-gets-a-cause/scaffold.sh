#!/usr/bin/env bash
# Scaffold for evals/diagnose/bug-with-repro-gets-a-cause.
#
# tiny-service-repo with one difference in the baseline commit: exportCsv
# holds back the last row of each page until it knows whether another page
# follows. A short final page flushes it; an empty final page -- which is
# what the pager returns when the row count is an exact multiple of the page
# size -- breaks out of the loop first, and the held row is never written.
# The existing export tests use three rows at page size 2 and one row at page
# size 10, so they pass. No staging data is supplied: the reproduction has to
# be built against the exporter.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

fixture_copy tiny-service-repo
cat > src/export/csv.js <<'JS'
'use strict';

function escapeField(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toLine(values) {
  return values.map(escapeField).join(',');
}

// fetchPage(page, pageSize) resolves to at most pageSize rows, each an object
// keyed by column name. Pages are zero-based.
//
// The last row of each page is held until the next page has been fetched,
// so the exporter knows which line is final before it writes it.
async function exportCsv(fetchPage, { columns, pageSize = 500 }) {
  if (!Array.isArray(columns) || columns.length === 0) throw new TypeError('exportCsv: columns are required');
  const lines = [toLine(columns)];
  let held = null;
  for (let page = 0; ; page++) {
    const rows = await fetchPage(page, pageSize);
    if (rows.length === 0) break;
    if (held) lines.push(toLine(columns.map((c) => held[c])));
    for (const row of rows.slice(0, -1)) lines.push(toLine(columns.map((c) => row[c])));
    held = rows[rows.length - 1];
    if (rows.length < pageSize) {
      lines.push(toLine(columns.map((c) => held[c])));
      break;
    }
  }
  return lines.join('\n');
}

module.exports = { exportCsv, escapeField };
JS
repo_init
commit_all "baseline: tiny-service"

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD)"
