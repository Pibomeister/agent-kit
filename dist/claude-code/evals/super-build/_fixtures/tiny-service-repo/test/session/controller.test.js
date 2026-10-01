'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startSession, isExpired } = require('../../src/session/controller');
const { SessionStore } = require('../../src/session/store');

test('a new session expires after the configured timeout', () => {
  const store = new SessionStore();
  const { record } = startSession(store, 'u1', { now: () => 0 });
  assert.equal(record.expiresAt, 3600 * 1000);
  assert.equal(isExpired(record, () => 3599 * 1000), false);
  assert.equal(isExpired(record, () => 3600 * 1000), true);
});

test('the session cookie is http-only and secure', () => {
  const { setCookie } = startSession(new SessionStore(), 'u1');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
});
