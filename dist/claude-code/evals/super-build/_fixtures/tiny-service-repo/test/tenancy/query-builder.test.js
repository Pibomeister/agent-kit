'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scopedQuery, toSql } = require('../../src/tenancy/query-builder');

test('every query is scoped to the tenant organisation', () => {
  const sql = toSql(scopedQuery('accounts', { orgId: 'o1' }, { deleted: false }));
  assert.equal(sql.text, 'SELECT * FROM accounts WHERE deleted = $1 AND org_id = $2');
  assert.deepEqual(sql.values, [false, 'o1']);
});

test('refuses to build a query without a tenant', () => {
  assert.throws(() => scopedQuery('accounts', null), TypeError);
});
