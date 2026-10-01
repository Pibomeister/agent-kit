'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../../src/gateway/router');
const { fakeResponse } = require('../helpers');

test('dispatches to the matching route', () => {
  const handle = createRouter({
    routes: { 'GET /health': (req, res) => res.end('ok') },
    limits: { windowMs: 1000, max: 5 },
    now: () => 0,
  });
  const res = fakeResponse();
  handle({ method: 'GET', url: '/health', ip: 'a' }, res);
  assert.equal(res.body, 'ok');
});

test('answers 429 once a client is over its limit', () => {
  const handle = createRouter({
    routes: { 'GET /health': (req, res) => res.end('ok') },
    limits: { windowMs: 1000, max: 1 },
    now: () => 0,
  });
  handle({ method: 'GET', url: '/health', ip: 'a' }, fakeResponse());
  const res = fakeResponse();
  handle({ method: 'GET', url: '/health', ip: 'a' }, res);
  assert.equal(res.statusCode, 429);
});
