'use strict';

// Creates an isolated sandbox organisation linked to a paying account. Today
// only operations staff run this, through scripts/provision-sandbox.js.
function provisionSandbox(account, { orgs, now = Date.now }) {
  if (!account || !account.orgId) throw new TypeError('provisionSandbox: account with orgId is required');
  const existing = orgs.findSandboxFor(account.orgId);
  if (existing) return existing;
  return orgs.create({ parentOrgId: account.orgId, kind: 'sandbox', plan: account.plan, createdAt: now() });
}

module.exports = { provisionSandbox };
