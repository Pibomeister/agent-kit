'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseConfig } = require('./config.js');

test('parses a valid JSON config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-config-repo-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 4000 }));
  assert.deepEqual(parseConfig(file), { port: 4000 });
});
