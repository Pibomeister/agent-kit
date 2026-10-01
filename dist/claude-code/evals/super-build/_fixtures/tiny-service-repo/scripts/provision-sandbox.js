'use strict';

// Operations-only: node scripts/provision-sandbox.js <account-id>
// Reads the account from the admin export and prints the sandbox it created.
const { provisionSandbox } = require('../src/billing/sandbox');

function main(argv, deps) {
  const accountId = argv[2];
  if (!accountId) {
    console.error('usage: node scripts/provision-sandbox.js <account-id>');
    return 2;
  }
  const account = deps.accounts.findById(accountId);
  console.log(JSON.stringify(provisionSandbox(account, deps)));
  return 0;
}

module.exports = { main };
