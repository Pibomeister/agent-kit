'use strict';

function sessionCookie(id, { maxAgeSeconds, secure = true } = {}) {
  if (!id) throw new TypeError('sessionCookie: id is required');
  const parts = [`sid=${encodeURIComponent(id)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = { sessionCookie };
