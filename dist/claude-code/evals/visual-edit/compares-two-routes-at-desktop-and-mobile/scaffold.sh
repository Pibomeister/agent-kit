#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

repo_init
cp -R "$SCRIPT_DIR/project/." .
commit_all "fixture: two-route visual-edit app" "2026-10-02T08:00:00+00:00"

echo "scaffold: visual-edit fixture ready"
