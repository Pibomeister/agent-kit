'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchRecords } = require('../../src/sync/client');

test('returns the body of a successful page', async () => {
  const transport = { get: async () => ({ status: 200, body: { items: [1, 2], next: null } }) };
  const session = { token: 't1', refresh: async () => 't2' };
  assert.deepEqual(await fetchRecords(transport, session, null), { items: [1, 2], next: null });
});
