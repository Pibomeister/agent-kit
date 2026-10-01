'use strict';

const { sessionCookie } = require('./cookie');
const defaults = require('../config/defaults');

function startSession(store, userId, { config = defaults, now = Date.now } = {}) {
  if (!userId) throw new TypeError('startSession: userId is required');
  const timeout = config.session.timeoutSeconds;
  const record = store.create({ userId, expiresAt: now() + timeout * 1000 });
  return { record, setCookie: sessionCookie(record.id, { maxAgeSeconds: timeout }) };
}

function isExpired(record, now = Date.now) {
  return now() >= record.expiresAt;
}

module.exports = { startSession, isExpired };
