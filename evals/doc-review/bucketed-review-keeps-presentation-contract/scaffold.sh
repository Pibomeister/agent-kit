#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

repo_init
mkdir -p adr
cat > README.md <<'MD'
# identity knowledgebase

A `kb://<path>` reference names the Markdown page at `<path>.md` in this checkout.
MD
cat > adr/session-expiry.md <<'MD'
---
kind: adr
status: draft
owner: identity
---

# Session expiry

## Decision

An authenticated session expires after 30 days of inactivity or 90 days from sign-in, whichever
comes first. The gateway checks both limits before refreshing a session.

## Rollout

The policy applies to newly issued sessions. Existing sessions never expire, so customers already
signed in are not interrupted by the rollout.

## Open question

The security owner has not decided whether existing sessions follow the new limits or remain valid
indefinitely.
MD
commit_all "adr: draft session expiry"

echo "scaffold: identity knowledgebase ready at $(git rev-parse --short HEAD)"
