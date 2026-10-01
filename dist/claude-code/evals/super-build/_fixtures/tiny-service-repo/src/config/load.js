'use strict';

const fs = require('node:fs');
const path = require('node:path');
const defaults = require('./defaults');

function loadConfig(env = process.env.NODE_ENV || 'development') {
  const file = path.join(__dirname, '..', '..', 'config', `${env}.json`);
  if (!fs.existsSync(file)) return structuredClone(defaults);
  const overrides = JSON.parse(fs.readFileSync(file, 'utf8'));
  const merged = structuredClone(defaults);
  for (const [section, values] of Object.entries(overrides)) {
    merged[section] = { ...(merged[section] || {}), ...values };
  }
  return merged;
}

module.exports = { loadConfig };
