#!/usr/bin/env bash
# Scaffold for evals/super-bound/approved-direction-produces-spec-and-tickets.
#
# tiny-service-repo, whose sandbox provisioning is operations-only today
# (src/billing/sandbox.js, driven by scripts/provision-sandbox.js).
#
# The approved alignment result is a run artifact at
# runs/sandbox-self-serve/alignment.json, untracked, bound to the head: the
# direction the prompt restates, approved by a human on 2026-09-25.
#
# The knowledgebase adapter has no implementation in the workspace, so the
# project's recorded context is supplied as a read-only checkout under
# knowledge-base/, untracked and outside the application's history: the prd
# in scope, the accepted adr on the tenant model, and the glossary. That
# checkout answers reads only; the skill's publish step needs the adapter to
# write, which the host cannot supply, so the case stays tagged needs-fixture
# and out of difference claims until the adapter is available in the sandbox.
#
# The project record is project.json, untracked, carrying the delegation
# guidance the scorer consumes. The host's scorer is the repository-local `ak`
# stand-in: it accepts only `ak delegation <ticket> --project <record>` on
# files that exist, and returns the ticket's own delegation block at the class
# the endpoint's authentication surface sets, yellow-owner.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
head="$(head_sha)"

mkdir -p runs/sandbox-self-serve
cat > runs/sandbox-self-serve/alignment.json <<JSON
{
  "kind": "alignment-result",
  "scope": "tiny-service/billing",
  "topic": "sandbox-self-serve",
  "status": "approved",
  "direction": "Self-serve sandbox provisioning moves behind an audited endpoint owned by the billing service. A paying-organisation admin may create that organisation's sandbox. The tenant model is unchanged: the sandbox stays a child organisation of the paying account's organisation, created by provisionSandbox.",
  "decisions": [
    "The endpoint lives in the billing service; no new service is introduced.",
    "The endpoint authenticates a paying-organisation admin and records the parent organisation in its audit event.",
    "The tenant model is unchanged: parentOrgId and kind 'sandbox' as today.",
    "The operations script stays for support use."
  ],
  "open_questions": [],
  "context": ["kb://prd/sandbox-self-serve", "kb://adr/0004-tenant-model", "kb://concept/glossary"],
  "source_revision": { "revision": "$head", "ref": "main" },
  "approval": { "by": "human", "at": "2026-09-25T17:20:00Z" }
}
JSON

kb=knowledge-base
mkdir -p "$kb/prd" "$kb/adr" "$kb/concept"
cat > "$kb/README.md" <<'MD'
# tiny-service knowledgebase

Read-only checkout of the central knowledgebase's pages for the
tiny-service project, taken 2026-09-25. It is not part of the application
repository and nothing here is committed with it. A `kb://<path>` reference
names the page at `<path>.md` in this checkout.
MD
cat > "$kb/prd/sandbox-self-serve.md" <<'MD'
---
kind: prd
scope: tiny-service/billing
status: approved
approved: 2026-09-12
---

# Self-serve sandboxes

## Problem

A paying customer who wants a sandbox files a support ticket, and an
operator runs `scripts/provision-sandbox.js` for them. The median wait is
two working days, and it is the most common reason customers give for
testing against production.

## Requirements

P1. An admin of a paying account can create that account's sandbox without
    contacting support.
P2. An account has at most one sandbox. Asking again returns the one that
    exists.
P3. Only an admin of the paying account's organisation can create its
    sandbox. Anyone else is refused.
P4. A sandbox is on the same plan as its parent account.
P5. Support can still create a sandbox for a customer.

## Out of scope

Deleting or resetting a sandbox. Copying production data into it.
MD
cat > "$kb/adr/0004-tenant-model.md" <<'MD'
---
kind: adr
scope: tiny-service
status: accepted
accepted: 2026-04-30
---

# 0004: Tenant model

Every account belongs to exactly one organisation, and every query is
scoped to the organisation resolved from the session (`resolveTenant`,
`scopedQuery`). A sandbox is an organisation of kind `sandbox` whose
`parentOrgId` is the paying organisation. Sandboxes never hold a
reference back from the parent; the parent finds its sandbox by
`findSandboxFor(parentOrgId)`.

Consequence: nothing may read or write across organisations except through an
explicit, audited path. Operations staff may use the operations path. Self-serve
sandbox provisioning may use the billing endpoint when it authenticates a
paying-organisation admin and creates only that organisation's sandbox.
MD
cat > "$kb/concept/glossary.md" <<'MD'
---
kind: concept
scope: tiny-service
status: active
---

# Glossary

- **Account** -- a paying customer's billing record. Belongs to one
  organisation.
- **Organisation** -- the tenant boundary. Sessions carry an organisation
  id; queries are scoped to it.
- **Sandbox** -- an organisation of kind `sandbox`, child of a paying
  organisation, on the same plan. Not billed.
- **Admin** -- a user with the `admin` role in an organisation.
- **Operations path** -- a script under `scripts/` run by staff, outside
  tenant scoping.
MD

cat > project.json <<'JSON'
{
  "guidance": {
    "delegation": {
      "weights": {"reversibility": 1, "size": 1, "complexity": 1, "spec": 1, "verification": 1},
      "cut_points": {"yellow_agent": 4, "yellow_owner": 7, "red": 10},
      "enforcement": "advisory"
    }
  }
}
JSON
cat > ak <<'SH'
#!/usr/bin/env sh
set -eu
if ! { [ "$#" -eq 4 ] && [ "$1" = delegation ] && [ "$3" = --project ]; }; then
  echo 'ak delegation: needs exactly one ticket path and --project <path>' >&2
  exit 2
fi
if ! { [ -f "$2" ] && [ -f "$4" ]; }; then
  echo 'ak delegation: ticket or project record does not exist' >&2
  exit 1
fi
exec node -e '
const { delegation } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (delegation === undefined) {
  console.error("ak delegation: ticket has no delegation block to score");
  process.exit(1);
}
console.log(JSON.stringify({ ...delegation, class: "yellow-owner" }, null, 2));
' "$2"
SH
chmod +x ak

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD)"
