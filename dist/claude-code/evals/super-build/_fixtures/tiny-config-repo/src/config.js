'use strict';

const fs = require('node:fs');

function parseConfig(rawPath) {
  const contents = fs.readFileSync(rawPath, 'utf8');
  return JSON.parse(contents);
}

module.exports = { parseConfig };
