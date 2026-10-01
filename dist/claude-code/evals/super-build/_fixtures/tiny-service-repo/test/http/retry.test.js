'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('../../src/http/retry');
const { httpError } = require('../../src/http/errors');

function failing(...errors) {
  let calls = 0;
  const fn = async () => {
    const err = errors[calls];
    calls += 1;
    if (err) throw err;
    return 'ok';
  };
  return { fn, calls: () => calls };
}

test('retries a 503 and returns the eventual result', async () => {
  const f = failing(httpError(503));
  assert.equal(await withRetry(f.fn), 'ok');
  assert.equal(f.calls(), 2);
});

test('retries a network failure that has no status', async () => {
  const f = failing(new Error('socket hang up'));
  assert.equal(await withRetry(f.fn), 'ok');
  assert.equal(f.calls(), 2);
});

test('gives up after the configured number of attempts', async () => {
  const f = failing(httpError(502), httpError(502), httpError(502));
  await assert.rejects(withRetry(f.fn, { attempts: 3 }), { status: 502 });
  assert.equal(f.calls(), 3);
});
