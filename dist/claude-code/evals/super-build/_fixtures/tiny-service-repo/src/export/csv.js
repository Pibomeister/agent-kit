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
async function exportCsv(fetchPage, { columns, pageSize = 500 }) {
  if (!Array.isArray(columns) || columns.length === 0) throw new TypeError('exportCsv: columns are required');
  const lines = [toLine(columns)];
  for (let page = 0; ; page++) {
    const rows = await fetchPage(page, pageSize);
    for (const row of rows) lines.push(toLine(columns.map((c) => row[c])));
    if (rows.length < pageSize) break;
  }
  return lines.join('\n');
}

module.exports = { exportCsv, escapeField };
