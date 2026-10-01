'use strict';

function isActive(account, now = new Date()) {
  if (!account) throw new TypeError('isActive: account is required');
  if (account.status === 'cancelled') return false;
  return new Date(account.paidThrough) > now;
}

module.exports = { isActive };
