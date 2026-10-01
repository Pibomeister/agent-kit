# Project standards

1. Public functions validate their inputs before use.
2. New behavior ships with a test that exercises it.
3. Errors carry an HTTP-style `status` when they cross a module boundary.
4. Every query is scoped to the caller's organisation; no code path reads
   across tenants.
5. No secrets or credentials are committed to the repository.
