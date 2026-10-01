#!/usr/bin/env node
'use strict';

// node bin/import.js <input.ndjson> <output.ndjson> [--state <state.json>]
const fs = require('node:fs');
const { runImport } = require('../src/import/pipeline');

const [input, output, flag, statePath] = process.argv.slice(2);
if (!input || !output || (flag !== undefined && flag !== '--state')) {
  console.error('usage: node bin/import.js <input.ndjson> <output.ndjson> [--state <state.json>]');
  process.exit(2);
}
const sink = { write: (record) => fs.appendFileSync(output, `${JSON.stringify(record)}\n`) };
const { imported } = runImport(input, { sink, statePath });
console.log(`imported ${imported} records`);
