'use strict';

module.exports = {
  session: { timeoutSeconds: 3600 },
  rateLimit: { windowMs: 60000, max: 100 },
  export: { pageSize: 500 },
  billing: {},
};
