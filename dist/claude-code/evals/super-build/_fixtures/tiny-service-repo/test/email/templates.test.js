'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../../src/email/templates');

test('substitutes top-level and nested variables', () => {
  assert.equal(render('Hi {{ name }}, plan {{account.plan}}', { name: 'Ada', account: { plan: 'pro' } }), 'Hi Ada, plan pro');
});

test('leaves text without variables untouched', () => {
  assert.equal(render('No variables here.'), 'No variables here.');
});
