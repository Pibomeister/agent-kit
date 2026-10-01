'use strict';

const fs = require('node:fs');

const REQUIRED = ['id', 'email'];

function validate(record) {
  for (const field of REQUIRED) {
    if (record[field] === undefined) throw new Error(`record is missing ${field}`);
  }
}

// Imports newline-delimited JSON records into a sink. When statePath is given
// the run can be interrupted and resumed: the state file records the next
// line to read.
function runImport(inputPath, { sink, statePath }) {
  const lines = fs.readFileSync(inputPath, 'utf8').split('\n');
  let start = 0;
  if (statePath && fs.existsSync(statePath)) {
    start = JSON.parse(fs.readFileSync(statePath, 'utf8')).nextLine;
  }
  let imported = 0;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const record = JSON.parse(lines[i]);
    validate(record);
    sink.write(record);
    imported += 1;
    if (statePath) fs.writeFileSync(statePath, JSON.stringify({ nextLine: i + 1 }));
  }
  return { imported };
}

module.exports = { runImport };
