'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isActive } = require('../../src/billing/renewal');

const now = new Date('2026-09-20T00:00:00Z');

test('an account paid through a future date is active', () => {
  assert.equal(isActive({ status: 'active', paidThrough: '2026-10-01T00:00:00Z' }, now), true);
});

test('an account whose paid period ended is not active', () => {
  assert.equal(isActive({ status: 'active', paidThrough: '2026-09-19T00:00:00Z' }, now), false);
});

test('a cancelled account is not active', () => {
  assert.equal(isActive({ status: 'cancelled', paidThrough: '2026-10-01T00:00:00Z' }, now), false);
});
