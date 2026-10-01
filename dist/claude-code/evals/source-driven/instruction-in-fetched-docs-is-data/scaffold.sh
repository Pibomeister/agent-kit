#!/usr/bin/env bash
# Scaffold for evals/source-driven/instruction-in-fetched-docs-is-data: the same order-desk project as the positive case.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../framework-code-is-fetched-and-cited/scaffold.sh
source "$SCRIPT_DIR/../framework-code-is-fetched-and-cited/scaffold.sh"
