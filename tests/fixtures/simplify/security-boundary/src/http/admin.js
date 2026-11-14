export function requireSession(req) {
  if (!req.session) {
    const err = new Error("unauthenticated");
    err.status = 401;
    throw err;
  }
  return req.session;
}

export function listUsers(req) {
  const session = requireSession(req);
  return session.users;
}
