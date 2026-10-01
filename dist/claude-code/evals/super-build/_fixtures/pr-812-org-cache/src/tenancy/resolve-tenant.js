'use strict';

const { httpError } = require('../http/errors');
const { shared } = require('./org-cache');

async function resolveTenant(req, { orgs, cache = shared }) {
  const orgId = req.session && req.session.orgId;
  if (!orgId) throw httpError(401, 'no organisation on session');
  let org = cache.get(orgId);
  if (org === undefined) {
    org = await orgs.findById(orgId);
    cache.set(orgId, org);
  }
  if (!org) throw httpError(403, 'unknown organisation');
  return { orgId: org.id, plan: org.plan };
}

module.exports = { resolveTenant };
