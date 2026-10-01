#!/usr/bin/env bash
# Scaffold for evals/doc-review/changed-evidence-resurfaces-a-rejected-finding.
#
# A repository holding the three files the prompt names, at the paths it
# names, copied from the search-migration-round-two fixture (a copy of the
# package's skills/doc-review/tests/, which the bundle does not ship). History:
#   2026-09-10  round one: the search migration plan and round one's
#               dispositions, committed together;
#   2026-09-16  the constraint change, and nothing else.
# `git log` on the plan therefore shows one commit, before the constraint
# changed, which is what "not edited since round one" claims.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

src="$FIXTURES_DIR/search-migration-round-two"
for f in search-migration-plan.md round-1-dispositions.yaml constraint-change.md; do
  [[ -f "$src/$f" ]] || scaffold_die "round-two file $f not found under $src"
done

dst=skills/doc-review/tests
mkdir -p "$dst"
repo_init
cp "$src/search-migration-plan.md" "$src/round-1-dispositions.yaml" "$dst/"
commit_all "doc-review round 1: search migration plan and dispositions" "2026-09-10T16:00:00+00:00"
cp "$src/constraint-change.md" "$dst/"
commit_all "record the vendor contract renegotiation" "2026-09-16T11:30:00+00:00"

echo "scaffold: round-two workspace ready at $(git rev-parse --short HEAD)"
