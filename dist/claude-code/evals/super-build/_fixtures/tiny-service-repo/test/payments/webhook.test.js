'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleWebhook } = require('../../src/payments/webhook');

function accountsWith(...list) {
  return { findByCustomer: (id) => list.find((a) => a.customer === id) || null };
}

test('a successful charge extends the paid period', () => {
  const account = { id: 'a1', customer: 'cus_1' };
  const event = { type: 'charge.succeeded', data: { object: { customer: 'cus_1', period_end: 1790000000 } } };
  assert.deepEqual(handleWebhook(event, { accounts: accountsWith(account) }), { handled: true, accountId: 'a1' });
  assert.equal(account.paidThrough, new Date(1790000000 * 1000).toISOString());
});

test('a successful charge for an unknown customer is not handled', () => {
  const event = { type: 'charge.succeeded', data: { object: { customer: 'cus_x', period_end: 1 } } };
  assert.equal(handleWebhook(event, { accounts: accountsWith() }).handled, false);
});
