#!/usr/bin/env bash
# Scaffold for evals/receiving-review/assesses-a-thread-against-the-code.
#
# tiny-service-repo, then branch AK-812-org-cache: pull request 812, which
# puts a process-wide OrgCache (src/tenancy/org-cache.js, from the
# pr-812-org-cache overlay) in front of resolveTenant. `gh` is not available
# in the workspace, so the pull request is supplied as an export under
# pr-812/: pull.json and threads.json, six unresolved threads at the head.
#
# Against the code at the head:
#   - the null-org claim does not hold: a lookup that finds nothing is
#     cached, then the 403 guard runs before any field is read;
#   - the unbounded-Map claim does not hold: set() evicts past maxEntries;
#   - two threads rest on one assumption, that the cache is meant to be
#     scoped per request or per user; it holds organisation records keyed by
#     the organisation id the session already carries;
#   - caching the miss is real: an organisation created after a failed
#     lookup is refused for up to the TTL;
#   - `crypto` is used without a require, which is what the lint check flags
#     (the runtime's global crypto hides it from the tests).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
pr812_branch
head="$(head_sha)"

rt=src/tenancy/resolve-tenant.js
oc=src/tenancy/org-cache.js
l_return="$(line_of "$rt" 'return { orgId: org.id')"
l_map="$(line_of "$oc" 'this.entries = new Map()')"
l_shared="$(line_of "$oc" 'const shared = new OrgCache()')"
l_get="$(line_of "$rt" 'let org = cache.get(orgId)')"
l_set="$(line_of "$rt" 'cache.set(orgId, org)')"
l_crypto="$(line_of "$oc" 'crypto.randomUUID()')"

pr812_pull pr-812 "$head"
cat > pr-812/README.md <<'MD'
# Pull request 812

Export of pull request 812 from the code host, taken 2026-09-25. The `gh`
CLI is not available in this workspace; these files are what it would
return.

- `pull.json` -- the pull request
- `threads.json` -- its review threads
MD
cat > pr-812/threads.json <<JSON
[
  {
    "id": "RT_812_1", "isResolved": false, "isOutdated": false,
    "path": "$rt", "line": $l_return, "originalLine": $l_return, "originalCommit": "$head",
    "comments": [
      { "author": { "login": "dana-r", "type": "User" }, "createdAt": "2026-09-24T09:12:00Z",
        "body": "On the cold path resolveTenant dereferences a null org: when findById returns null we fall through to org.id / org.plan and throw a TypeError instead of the 403. Please fix before merge." }
    ]
  },
  {
    "id": "RT_812_2", "isResolved": false, "isOutdated": false,
    "path": "$oc", "line": $l_map, "originalLine": $l_map, "originalCommit": "$head",
    "comments": [
      { "author": { "login": "dana-r", "type": "User" }, "createdAt": "2026-09-24T09:15:00Z",
        "body": "This Map is never bounded. Every org the process ever sees stays in memory -- that's a leak in a long-lived worker." }
    ]
  },
  {
    "id": "RT_812_3", "isResolved": false, "isOutdated": false,
    "path": "$oc", "line": $l_shared, "originalLine": $l_shared, "originalCommit": "$head",
    "comments": [
      { "author": { "login": "j-okafor", "type": "User" }, "createdAt": "2026-09-24T10:02:00Z",
        "body": "Wasn't this cache supposed to live for one request? As written it is module-level, so whatever one request put in it is visible to the next one." }
    ]
  },
  {
    "id": "RT_812_4", "isResolved": false, "isOutdated": false,
    "path": "$rt", "line": $l_get, "originalLine": $l_get, "originalCommit": "$head",
    "comments": [
      { "author": { "login": "sec-scan[bot]", "type": "Bot" }, "createdAt": "2026-09-24T10:30:00Z",
        "body": "**Potential cross-tenant data exposure (medium).** Cached tenant data is shared between requests made by different users. Scope the cache to the request or to the authenticated user." }
    ]
  },
  {
    "id": "RT_812_5", "isResolved": false, "isOutdated": false,
    "path": "$rt", "line": $l_set, "originalLine": $l_set, "originalCommit": "$head",
    "comments": [
      { "author": { "login": "j-okafor", "type": "User" }, "createdAt": "2026-09-24T10:41:00Z",
        "body": "A lookup that finds nothing gets cached too. If an org is created right after someone hit it, they get a 403 until the entry expires." }
    ]
  },
  {
    "id": "RT_812_6", "isResolved": false, "isOutdated": false,
    "path": "$oc", "line": $l_crypto, "originalLine": $l_crypto, "originalCommit": "$head",
    "comments": [
      { "author": { "login": "lint[bot]", "type": "Bot" }, "createdAt": "2026-09-24T08:05:00Z",
        "body": "no-undef-builtin: 'crypto' is used but never required" }
    ]
  }
]
JSON

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
