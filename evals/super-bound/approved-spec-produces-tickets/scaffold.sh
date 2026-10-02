#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../approved-direction-stops-at-open-decisions/scaffold.sh"

spec=runs/sandbox-self-serve/specification.md
cat > "$spec" <<'MD'
# Self-serve sandbox provisioning

## Problem

Paying-account administrators wait for support to provision a sandbox.

## Solution

Expose the existing sandbox provisioner through an audited billing-service endpoint. Authenticate
the paying-organisation administrator, keep the existing tenant model and retain the support path.

## Non-goals

Deleting or resetting sandboxes, copying production data, or changing tenant relationships.

## Acceptance criteria

- An administrator can create the paying organisation's single sandbox.
- A repeated request returns the existing sandbox.
- A non-administrator or another organisation is refused.
- The audit event identifies the administrator and parent organisation.
- The support provisioning path continues to work.

## Test seams

Verify at the billing endpoint with the existing provisioner and tenant-policy fixtures; this is the
highest seam that covers authorization, idempotency, audit and the unchanged tenant relationship.

## Verification

Run the endpoint integration tests, the existing sandbox unit tests, the full test command and lint.

## Out of scope

Sandbox deletion, resets, production-data copies and a new service.
MD

spec_hash="sha256:$(shasum -a 256 "$spec" | cut -d' ' -f1)"
cat > runs/sandbox-self-serve/review.json <<JSON
{
  "status": "approved",
  "specification_hash": "$spec_hash",
  "decisions": [
    {"id": "D1", "question": "Which service owns the endpoint?", "answer": "billing"},
    {"id": "D2", "question": "Does the tenant model change?", "answer": "no"},
    {"id": "D3", "question": "Does support provisioning remain?", "answer": "yes"}
  ],
  "open_decisions": []
}
JSON
cat > runs/sandbox-self-serve/approval.json <<JSON
{
  "by": "human",
  "at": "2026-09-25T18:00:00Z",
  "specification_hash": "$spec_hash"
}
JSON

echo "scaffold: reviewed specification approved at $spec_hash"
