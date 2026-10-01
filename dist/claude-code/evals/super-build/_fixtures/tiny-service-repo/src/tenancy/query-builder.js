'use strict';

function scopedQuery(table, tenant, filters = {}) {
  if (!tenant || !tenant.orgId) throw new TypeError('scopedQuery: a resolved tenant is required');
  return { table, where: { ...filters, org_id: tenant.orgId } };
}

function toSql({ table, where }) {
  const keys = Object.keys(where).sort();
  const clause = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
  return { text: `SELECT * FROM ${table}${clause ? ` WHERE ${clause}` : ''}`, values: keys.map((k) => where[k]) };
}

module.exports = { scopedQuery, toSql };
