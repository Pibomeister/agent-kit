'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTenant } = require('../../src/tenancy/resolve-tenant');

const orgs = { findById: async (id) => (id === 'o1' ? { id: 'o1', plan: 'pro' } : null) };

test('resolves the organisation on the session', async () => {
  assert.deepEqual(await resolveTenant({ session: { orgId: 'o1' } }, { orgs }), { orgId: 'o1', plan: 'pro' });
});

test('rejects a request with no organisation on the session', async () => {
  await assert.rejects(resolveTenant({ session: {} }, { orgs }), { status: 401 });
});

test('rejects an organisation that does not exist', async () => {
  await assert.rejects(resolveTenant({ session: { orgId: 'o9' } }, { orgs }), { status: 403 });
});
