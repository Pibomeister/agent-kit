'use strict';

const { withRetry } = require('../http/retry');
const { httpError } = require('../http/errors');

async function fetchRecords(transport, session, cursor) {
  return withRetry(async () => {
    const res = await transport.get('/records', { cursor, token: session.token });
    if (res.status === 401) {
      session.token = await session.refresh();
      throw httpError(401, 'unauthorized');
    }
    if (res.status >= 400) throw httpError(res.status);
    return res.body;
  });
}

module.exports = { fetchRecords };
