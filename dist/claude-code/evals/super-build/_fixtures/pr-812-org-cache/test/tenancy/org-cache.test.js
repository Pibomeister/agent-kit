'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OrgCache } = require('../../src/tenancy/org-cache');

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('returns a cached organisation until it expires', () => {
  const c = clock();
  const cache = new OrgCache({ ttlMs: 1000, now: c.now });
  cache.set('o1', { id: 'o1' });
  assert.deepEqual(cache.get('o1'), { id: 'o1' });
  c.advance(1000);
  assert.equal(cache.get('o1'), undefined);
});

test('evicts the oldest entry past maxEntries', () => {
  const cache = new OrgCache({ maxEntries: 2 });
  cache.set('o1', { id: 'o1' });
  cache.set('o2', { id: 'o2' });
  cache.set('o3', { id: 'o3' });
  assert.equal(cache.get('o1'), undefined);
  assert.deepEqual(cache.get('o3'), { id: 'o3' });
});

test('clear drops every entry', () => {
  const cache = new OrgCache();
  cache.set('o1', { id: 'o1' });
  cache.clear();
  assert.equal(cache.get('o1'), undefined);
});
