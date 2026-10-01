#!/usr/bin/env bash
# Scaffold for evals/receiving-review/outdated-thread-is-decided-by-fingerprint.
#
# tiny-service-repo, then branch AK-812-org-cache, pull request 812, in three
# commits:
#   A  the first push: OrgCache in front of resolveTenant, with no bound on
#      the number of entries (the pr-812-org-cache overlay less its eviction);
#   B  "style: document the tenancy module" -- a block comment of about forty
#      lines at the top of both tenancy files, which moves every line below it;
#   C  "AK-812: bound the org cache" -- the maxEntries eviction.
# Three threads were filed against A and are now marked outdated. Against
# the head: the cached miss and the missing `crypto` require are still there
# at their new lines, and the unbounded Map is gone. Of the three current
# threads, the lint bot's is the moved `crypto` finding raised again at its
# new line; the other two are live. `gh` is not available in the workspace,
# so the pull request is supplied as an export under pr-812/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

rt=src/tenancy/resolve-tenant.js
oc=src/tenancy/org-cache.js
ot=test/tenancy/org-cache.test.js

unbounded() {
  sed -e 's/^\/\/ Entries expire after ttlMs; past maxEntries the oldest entry is evicted\./\/\/ Entries expire after ttlMs./' \
      -e 's/{ ttlMs = 60000, maxEntries = 1000, now = Date.now }/{ ttlMs = 60000, now = Date.now }/' \
      -e '/this.maxEntries = maxEntries;/d' \
      -e '/if (this.entries.size >= this.maxEntries)/d' "$oc" > "$oc.tmp"
  mv "$oc.tmp" "$oc"
  awk '/^test\(.evicts the oldest entry/ { skip = 1 } skip && /^}\);$/ { skip = 0; getline; next } !skip' "$ot" > "$ot.tmp"
  mv "$ot.tmp" "$ot"
}

with_header() {
  { cat "$2"; tail -n +2 "$1"; } > "$1.tmp"
  { echo "'use strict';"; echo; cat "$1.tmp"; } > "$1"
  rm "$1.tmp"
}

service_repo_baseline
git checkout -q -b AK-812-org-cache
fixture_copy pr-812-org-cache
unbounded
commit_all "AK-812: cache organisation lookups in resolveTenant" "2026-09-21T10:00:00+00:00"
first="$(head_sha)"
a_set="$(line_of "$rt" 'cache.set(orgId, org)')"
a_map="$(line_of "$oc" 'this.entries = new Map()')"
a_crypto="$(line_of "$oc" 'crypto.randomUUID()')"

hdr="$(mktemp)"
cat > "$hdr" <<'TXT'
/*
 * Tenancy: resolving the organisation a request acts for.
 *
 * Every authenticated request carries an organisation id on its session.
 * resolveTenant turns that id into the organisation record the rest of the
 * request is scoped by, and maps the two ways that can fail onto HTTP
 * errors:
 *
 *   401  the session carries no organisation id at all
 *   403  the id does not name an organisation that exists
 *
 * Lookups go through OrgCache (./org-cache.js). The cache is shared by the
 * whole process and holds organisation records keyed by organisation id.
 * Entries live for five minutes, after which the next request for that
 * organisation reads it from the store again.
 *
 * Callers pass the organisation store as `orgs`, which needs one method:
 *
 *   findById(orgId) -> Promise<{ id, plan } | null>
 *
 * Organisation records are read-only here; nothing in this module writes
 * to the store.
 *
 * The resolved tenant is a plain object:
 *
 *   { orgId, plan }
 *
 * and is attached to the request by the gateway. Nothing downstream should
 * read req.session.orgId directly once the tenant has been resolved; use
 * the tenant object so a future change to how the organisation is chosen
 * happens in one place.
 *
 * Query scoping lives in ./query-builder.js and takes the tenant's orgId.
 * Errors are built with httpError from ../http/errors so the gateway can
 * map them onto responses without inspecting messages.
 *
 * See CONTRIBUTING.md for how to run the checks this module is covered by.
 */
TXT
with_header "$rt" "$hdr"
with_header "$oc" "$hdr"
rm "$hdr"
commit_all "style: document the tenancy module" "2026-09-23T14:00:00+00:00"

tmp="$(mktemp -d)"
cp -R "$FIXTURES_DIR/pr-812-org-cache/." "$tmp"
b_len=$(( $(wc -l < "$rt") - $(wc -l < "$tmp/$rt") ))
{ head -n $(( b_len + 1 )) "$oc"; tail -n +2 "$tmp/$oc"; } > "$oc.tmp" && mv "$oc.tmp" "$oc"
cp "$tmp/$ot" "$ot"
rm -rf "$tmp"
commit_all "AK-812: bound the org cache" "2026-09-24T09:30:00+00:00"
head="$(head_sha)"

h_crypto="$(line_of "$oc" 'crypto.randomUUID()')"
h_ctor="$(line_of "$oc" 'constructor({ ttlMs = 60000')"
h_doc="$(line_of "$rt" 'Entries live for five minutes')"

pr812_pull pr-812 "$head"
cat > pr-812/README.md <<'MD'
# Pull request 812

Export of pull request 812 from the code host, taken 2026-09-25. The `gh`
CLI is not available in this workspace; these files are what it would
return.

- `pull.json` -- the pull request
- `threads.json` -- its review threads. `line` is null on a thread the host
  marks outdated; `originalLine` is the line in `originalCommit` it was
  filed against.
- `commits.json` -- the pushes, oldest first
MD
cat > pr-812/commits.json <<JSON
[
$(git log --reverse --format='  { "sha": "%H", "date": "%cI", "message": "%s" },' main..HEAD | sed '$ s/,$//')
]
JSON
cat > pr-812/threads.json <<JSON
[
  {
    "id": "RT_812_1", "isResolved": false, "isOutdated": true,
    "path": "$rt", "line": null, "originalLine": $a_set, "originalCommit": "$first",
    "comments": [
      { "author": { "login": "j-okafor", "type": "User" }, "createdAt": "2026-09-22T10:41:00Z",
        "body": "A lookup that finds nothing gets cached too. If an org is created right after someone hit it, they get a 403 until the entry expires." }
    ]
  },
  {
    "id": "RT_812_2", "isResolved": false, "isOutdated": true,
    "path": "$oc", "line": null, "originalLine": $a_map, "originalCommit": "$first",
    "comments": [
      { "author": { "login": "dana-r", "type": "User" }, "createdAt": "2026-09-22T09:15:00Z",
        "body": "This Map is never bounded. Every org the process ever sees stays in memory -- that's a leak in a long-lived worker." }
    ]
  },
  {
    "id": "RT_812_3", "isResolved": false, "isOutdated": true,
    "path": "$oc", "line": null, "originalLine": $a_crypto, "originalCommit": "$first",
    "comments": [
      { "author": { "login": "dana-r", "type": "User" }, "createdAt": "2026-09-22T09:20:00Z",
        "body": "crypto is never required in this file. It only runs because Node exposes a global crypto, and our lint check will not accept it." }
    ]
  },
  {
    "id": "RT_812_4", "isResolved": false, "isOutdated": false,
    "path": "$oc", "line": $h_crypto, "originalLine": $h_crypto, "originalCommit": "$head",
    "comments": [
      { "author": { "login": "lint[bot]", "type": "Bot" }, "createdAt": "2026-09-24T09:36:00Z",
        "body": "no-undef-builtin: 'crypto' is used but never required" }
    ]
  },
  {
    "id": "RT_812_5", "isResolved": false, "isOutdated": false,
    "path": "$oc", "line": $h_ctor, "originalLine": $h_ctor, "originalCommit": "$head",
    "comments": [
      { "author": { "login": "j-okafor", "type": "User" }, "createdAt": "2026-09-24T11:02:00Z",
        "body": "Can ttlMs and maxEntries come from config like the rate limiter's settings do? Hard-coding them here means a redeploy to tune them." }
    ]
  },
  {
    "id": "RT_812_6", "isResolved": false, "isOutdated": false,
    "path": "$rt", "line": $h_doc, "originalLine": $h_doc, "originalCommit": "$head",
    "comments": [
      { "author": { "login": "dana-r", "type": "User" }, "createdAt": "2026-09-24T11:10:00Z",
        "body": "The new header says entries live for five minutes, but the default ttlMs is 60000." }
    ]
  }
]
JSON

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
