'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionStore } = require('../../src/session/store');

test('refresh extends the session and bumps its version', async () => {
  const store = new SessionStore({ now: () => 1000 });
  const { id } = store.create({ userId: 'u1', expiresAt: 0 });
  const updated = await store.refresh(id, 60, async () => 'tok');
  assert.equal(updated.version, 2);
  assert.equal(updated.expiresAt, 61000);
  assert.equal(updated.token, 'tok');
});

test('refreshing an unknown session returns null', async () => {
  assert.equal(await new SessionStore().refresh('nope', 60, async () => 'tok'), null);
});
