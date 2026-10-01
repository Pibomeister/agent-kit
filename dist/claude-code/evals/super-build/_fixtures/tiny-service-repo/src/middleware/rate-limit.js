'use strict';

function rateLimit({ windowMs, max, now = Date.now }) {
  if (!(windowMs > 0) || !(max > 0)) throw new TypeError('rateLimit: windowMs and max must be positive');
  const hits = new Map();
  return function rateLimitMiddleware(req, res, next) {
    const key = req.ip;
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.statusCode = 429;
      res.setHeader('Retry-After', String(Math.ceil((entry.start + windowMs - t) / 1000)));
      return res.end('too many requests');
    }
    return next();
  };
}

module.exports = { rateLimit };
