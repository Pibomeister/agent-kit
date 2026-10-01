#!/usr/bin/env bash
# Scaffold for evals/super-scout/named-question-returns-dossier.
#
# The shared tiny-service-repo fixture committed on main, plus one later
# commit so the head is a named revision with history behind it. The
# rate-limit middleware is src/middleware/rate-limit.js and is covered twice:
# a unit suite (test/middleware/rate-limit.test.js) and an integration test
# through the gateway router (test/gateway/router.test.js). Lexical decoys --
# the 429 handling in src/http/retry.js, the rateLimit keys in config/ -- make
# an answer that was grepped and never read back distinguishable from one
# that was.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
sed -i.bak 's/"max": 300/"max": 600/' config/production.json && rm config/production.json.bak
commit_all "config: raise the production request limit" "2026-09-16T11:30:00+00:00"

echo "scaffold: tiny-service ready at $(git rev-parse --short HEAD) on $(git branch --show-current)"
