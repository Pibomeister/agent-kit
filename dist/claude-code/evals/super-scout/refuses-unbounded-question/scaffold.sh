#!/usr/bin/env bash
# Scaffold for evals/super-scout/refuses-unbounded-question.
#
# The shared service repository contains session, gateway and middleware code,
# so refusal measures the unbounded question rather than an empty workspace.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD)"
