export function requireSession(req) {
  if (!req.session) {
    const err = new Error("unauthenticated");
    err.status = 401;
    throw err;
  }
  return req.session;
}

export function charge(req, amount) {
  const session = requireSession(req);
  return { account: session.id, amount };
}
