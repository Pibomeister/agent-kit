#!/usr/bin/env bash
# Scaffold for evals/super-build/independent-tickets-still-parallel.
#
# tiny-service-repo on main with tickets AK-420 (src/email/, templating) and
# AK-421 (src/export/, CSV) exported to tickets/, plus a layer plan listing
# the two as the ready layer with no edge between them. The tickets really
# are independent: disjoint write ownership, no generated artifact, no
# migrations directory, no shared exported interface, and neither module
# imports the other -- so the surfaces the case asks about can be inspected
# and found clear, rather than taken on the prompt's word.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
tickets_copy AK-420 AK-421
cat > tickets/layers.md <<'MD'
# Build layers -- messaging and data polish

| Layer | Tickets | Blocked by |
|---|---|---|
| 1 | AK-420, AK-421 | none |

Both tickets are approved and typed implementation. No dependency edge is
declared between them.
MD
commit_all "tickets: export AK-420 and AK-421" "2026-09-23T16:00:00+00:00"

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
