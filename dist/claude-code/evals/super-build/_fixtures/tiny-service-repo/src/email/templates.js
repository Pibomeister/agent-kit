'use strict';

const VARIABLE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

function lookup(vars, dotted) {
  return dotted.split('.').reduce((value, key) => (value == null ? undefined : value[key]), vars);
}

function render(template, vars = {}) {
  if (typeof template !== 'string') throw new TypeError('render: template must be a string');
  return template.replace(VARIABLE, (_, name) => String(lookup(vars, name)));
}

module.exports = { render };
