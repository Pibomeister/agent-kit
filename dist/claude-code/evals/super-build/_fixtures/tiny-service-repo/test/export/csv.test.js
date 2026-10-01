'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { exportCsv } = require('../../src/export/csv');

function pager(rows) {
  return async (page, size) => rows.slice(page * size, page * size + size);
}

test('writes a header and one line per row across pages', async () => {
  const rows = [
    { id: 1, name: 'ada' },
    { id: 2, name: 'grace' },
    { id: 3, name: 'edsger' },
  ];
  const csv = await exportCsv(pager(rows), { columns: ['id', 'name'], pageSize: 2 });
  assert.equal(csv, 'id,name\n1,ada\n2,grace\n3,edsger');
});

test('quotes fields that contain a comma or a quote', async () => {
  const csv = await exportCsv(pager([{ id: 1, name: 'a, "b"' }]), { columns: ['id', 'name'], pageSize: 10 });
  assert.equal(csv, 'id,name\n1,"a, ""b"""');
});
