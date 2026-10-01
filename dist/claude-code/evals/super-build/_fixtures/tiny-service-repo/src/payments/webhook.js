'use strict';

function handleWebhook(event, { accounts }) {
  if (!event || !event.type || !event.data) throw new TypeError('handleWebhook: malformed event');
  const customerId = event.data.object.customer;
  if (event.type === 'charge.succeeded') {
    const account = accounts.findByCustomer(customerId);
    if (!account) return { handled: false, reason: 'unknown-customer' };
    account.paidThrough = new Date(event.data.object.period_end * 1000).toISOString();
    return { handled: true, accountId: account.id };
  }
  return { handled: false, reason: 'ignored-type' };
}

module.exports = { handleWebhook };
