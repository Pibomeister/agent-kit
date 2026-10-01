'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimit } = require('../../src/middleware/rate-limit');
const { fakeResponse } = require('../helpers');

function run(mw, ip) {
  const res = fakeResponse();
  let passed = false;
  mw({ ip }, res, () => {
    passed = true;
  });
  return { res, passed };
}

test('lets requests through up to the limit', () => {
  const mw = rateLimit({ windowMs: 1000, max: 2, now: () => 0 });
  assert.equal(run(mw, 'a').passed, true);
  assert.equal(run(mw, 'a').passed, true);
});

test('rejects the request over the limit with 429 and Retry-After', () => {
  let t = 0;
  const mw = rateLimit({ windowMs: 10000, max: 1, now: () => t });
  run(mw, 'a');
  t = 4000;
  const { res, passed } = run(mw, 'a');
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '6');
});

test('counts each client separately and resets after the window', () => {
  let t = 0;
  const mw = rateLimit({ windowMs: 1000, max: 1, now: () => t });
  run(mw, 'a');
  assert.equal(run(mw, 'b').passed, true);
  t = 1000;
  assert.equal(run(mw, 'a').passed, true);
});
