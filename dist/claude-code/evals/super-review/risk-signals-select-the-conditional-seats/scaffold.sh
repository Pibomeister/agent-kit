#!/usr/bin/env bash
# Scaffold for evals/super-review/risk-signals-select-the-conditional-seats.
#
# tiny-service-repo with ticket AK-702 on main, then branch
# AK-702-header-selected-org whose commit changes tenant scoping across four
# files: resolveTenant takes the organisation from an x-org-id header ahead
# of the session (with no membership check), scopedQuery gains a
# bypassTenantScope option that drops the org_id filter, the admin console
# sets it from a request header, and defaults gain admin.allowTenantBypass.
# The commit message asserts the bypass is internal-only; nothing in the tree
# enforces that. Base main, head the branch tip, requirement tickets/AK-702.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
tickets_copy AK-702
commit_all "tickets: export AK-702" "2026-09-17T10:00:00+00:00"
git checkout -q -b AK-702-header-selected-org

cat > src/tenancy/resolve-tenant.js <<'JS'
'use strict';

const { httpError } = require('../http/errors');

const ORG_HEADER = 'x-org-id';

// Users who belong to several organisations choose the one a request acts
// on with the x-org-id header. Without the header the session's
// organisation is used, as before.
function requestedOrgId(req) {
  const headers = req.headers || {};
  const fromHeader = headers[ORG_HEADER];
  if (typeof fromHeader === 'string' && fromHeader.trim() !== '') return fromHeader.trim();
  return req.session && req.session.orgId;
}

async function resolveTenant(req, { orgs }) {
  const orgId = requestedOrgId(req);
  if (!orgId) throw httpError(401, 'no organisation on request');
  const org = await orgs.findById(orgId);
  if (!org) throw httpError(403, 'unknown organisation');
  return { orgId: org.id, plan: org.plan };
}

module.exports = { resolveTenant, requestedOrgId, ORG_HEADER };
JS
cat > src/tenancy/query-builder.js <<'JS'
'use strict';

// Builds a query scoped to the tenant's organisation. bypassTenantScope is
// for the internal admin console only: it drops the organisation filter so
// operators can see accounts across every organisation.
function scopedQuery(table, tenant, filters = {}, { bypassTenantScope = false } = {}) {
  if (bypassTenantScope) {
    return { table, where: { ...filters }, unscoped: true };
  }
  if (!tenant || !tenant.orgId) throw new TypeError('scopedQuery: a resolved tenant is required');
  return { table, where: { ...filters, org_id: tenant.orgId } };
}

function toSql({ table, where }) {
  const keys = Object.keys(where).sort();
  const clause = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
  return { text: `SELECT * FROM ${table}${clause ? ` WHERE ${clause}` : ''}`, values: keys.map((k) => where[k]) };
}

function paged(query, { limit = 50, offset = 0 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('paged: limit must be 1..500');
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('paged: offset must be >= 0');
  return { ...query, limit, offset };
}

function toPagedSql(query) {
  const base = toSql(query);
  const n = base.values.length;
  return { text: `${base.text} LIMIT $${n + 1} OFFSET $${n + 2}`, values: [...base.values, query.limit, query.offset] };
}

module.exports = { scopedQuery, toSql, paged, toPagedSql };
JS
cat > src/admin/console.js <<'JS'
'use strict';

const { resolveTenant } = require('../tenancy/resolve-tenant');
const { scopedQuery, paged, toPagedSql } = require('../tenancy/query-builder');
const defaults = require('../config/defaults');

const CONSOLE_HEADER = 'x-admin-console';

function fromConsole(req) {
  const headers = req.headers || {};
  return headers[CONSOLE_HEADER] === 'true';
}

// Lists accounts. Requests from the internal admin console may list across
// every organisation when admin.allowTenantBypass is on.
async function listAccounts(req, { orgs, db, config = defaults }) {
  const page = { limit: Number(req.query && req.query.limit) || 50, offset: Number(req.query && req.query.offset) || 0 };
  const bypass = config.admin.allowTenantBypass && fromConsole(req);
  const tenant = bypass ? null : await resolveTenant(req, { orgs });
  const query = scopedQuery('accounts', tenant, { deleted: false }, { bypassTenantScope: bypass });
  const rows = await db.query(toPagedSql(paged(query, page)));
  return { rows, scope: bypass ? 'all-organisations' : tenant.orgId, page };
}

async function countAccounts(req, { orgs, db, config = defaults }) {
  const bypass = config.admin.allowTenantBypass && fromConsole(req);
  const tenant = bypass ? null : await resolveTenant(req, { orgs });
  const query = scopedQuery('accounts', tenant, { deleted: false }, { bypassTenantScope: bypass });
  const sql = toPagedSql(paged(query, { limit: 500, offset: 0 }));
  const rows = await db.query(sql);
  return { count: rows.length, scope: bypass ? 'all-organisations' : tenant.orgId };
}

async function getAccount(req, accountId, { orgs, db, config = defaults }) {
  if (!accountId) throw new TypeError('getAccount: accountId is required');
  const bypass = config.admin.allowTenantBypass && fromConsole(req);
  const tenant = bypass ? null : await resolveTenant(req, { orgs });
  const query = scopedQuery('accounts', tenant, { id: accountId }, { bypassTenantScope: bypass });
  const rows = await db.query(toPagedSql(paged(query, { limit: 1, offset: 0 })));
  return rows[0] || null;
}

async function suspendAccount(req, accountId, { orgs, db, config = defaults, now = Date.now }) {
  const account = await getAccount(req, accountId, { orgs, db, config });
  if (!account) return { suspended: false, reason: 'not-found' };
  await db.query({
    text: 'UPDATE accounts SET status = $1, suspended_at = $2 WHERE id = $3',
    values: ['suspended', new Date(now()).toISOString(), account.id],
  });
  return { suspended: true, accountId: account.id, orgId: account.org_id };
}

module.exports = { listAccounts, countAccounts, getAccount, suspendAccount, CONSOLE_HEADER };
JS
cat > src/config/defaults.js <<'JS'
'use strict';

module.exports = {
  session: { timeoutSeconds: 3600 },
  rateLimit: { windowMs: 60000, max: 100 },
  export: { pageSize: 500 },
  billing: {},
  // The admin console runs on the internal network. allowTenantBypass lets
  // it list accounts across organisations.
  admin: { allowTenantBypass: true },
};
JS
git add -A
GIT_AUTHOR_DATE="2026-09-25T09:30:00+00:00" GIT_COMMITTER_DATE="2026-09-25T09:30:00+00:00" git commit -q --no-verify \
  -m "AK-702: header-selected organisation and admin console listing" \
  -m "Requests may pick their organisation with x-org-id. The admin console can list across organisations via bypassTenantScope; the bypass flag is internal-only (the console is only reachable from the office network), so there is no tenant-isolation exposure."

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
