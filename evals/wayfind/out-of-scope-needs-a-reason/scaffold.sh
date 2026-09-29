#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
mkdir -p maps tickets
cat > maps/search-migration.md <<'MD'
# Search migration map

## Destination
The product no longer depends on the hosted search vendor.

## Decisions so far
Index hosting and relevance ownership are unresolved.

## Frontier
- SEARCH-31: decide index hosting.
- SEARCH-32: decide relevance ownership.
- SEARCH-33: determine what happens to analytics readers.

## Not yet specified
Cutover sequencing.

## Out of scope
Nothing recorded.
MD
cat > tickets/SEARCH-33.md <<'MD'
# SEARCH-33 — Analytics readers after search migration

Status: open decision. Inventory analytics consumers and decide whether each reads the replacement index, an export, or retires.
MD
commit_all "maps: record search migration frontier" "2026-09-24T09:00:00+00:00"
