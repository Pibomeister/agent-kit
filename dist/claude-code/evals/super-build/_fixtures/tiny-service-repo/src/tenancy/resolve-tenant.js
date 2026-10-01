'use strict';

const { httpError } = require('../http/errors');

async function resolveTenant(req, { orgs }) {
  const orgId = req.session && req.session.orgId;
  if (!orgId) throw httpError(401, 'no organisation on session');
  const org = await orgs.findById(orgId);
  if (!org) throw httpError(403, 'unknown organisation');
  return { orgId: org.id, plan: org.plan };
}

module.exports = { resolveTenant };
