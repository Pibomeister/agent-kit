'use strict';

const { resolveTenant } = require('../tenancy/resolve-tenant');
const { scopedQuery, toSql } = require('../tenancy/query-builder');

async function listAccounts(req, { orgs, db }) {
  const tenant = await resolveTenant(req, { orgs });
  return db.query(toSql(scopedQuery('accounts', tenant, { deleted: false })));
}

module.exports = { listAccounts };
