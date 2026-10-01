'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runImport } = require('../../src/import/pipeline');

function tmp(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
  const file = path.join(dir, name);
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

function collect() {
  const records = [];
  return { records, write: (r) => records.push(r) };
}

test('imports every record and skips blank lines', () => {
  const sink = collect();
  const input = tmp('in.ndjson', '{"id":1,"email":"a@x"}\n\n{"id":2,"email":"b@x"}\n');
  assert.deepEqual(runImport(input, { sink }), { imported: 2 });
  assert.equal(sink.records.length, 2);
});

test('resumes from the recorded next line', () => {
  const input = tmp('in.ndjson', '{"id":1,"email":"a@x"}\n{"id":2,"email":"b@x"}\n');
  const statePath = tmp('state.json', JSON.stringify({ nextLine: 1 }));
  const sink = collect();
  assert.deepEqual(runImport(input, { sink, statePath }), { imported: 1 });
  assert.equal(sink.records[0].id, 2);
});
