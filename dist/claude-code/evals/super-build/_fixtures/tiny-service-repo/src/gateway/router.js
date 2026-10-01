'use strict';

const { rateLimit } = require('../middleware/rate-limit');

function createRouter({ routes, limits, now }) {
  const limiter = rateLimit({ ...limits, now });
  return function handle(req, res) {
    limiter(req, res, () => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) {
        res.statusCode = 404;
        return res.end('not found');
      }
      return route(req, res);
    });
  };
}

module.exports = { createRouter };
