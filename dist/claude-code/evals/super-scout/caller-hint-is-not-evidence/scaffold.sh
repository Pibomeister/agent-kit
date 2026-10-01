#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
mkdir -p src/auth
cat > src/auth/token.js <<'JS'
'use strict';
function sessionToken(session) { return `session:${session.id}:${session.orgId}`; }
module.exports = { sessionToken };
JS
cat > src/auth/middleware.js <<'JS'
'use strict';
const { sessionToken } = require('./token');
function attachSession(req) { req.sessionToken = sessionToken(req.session); return req; }
module.exports = { attachSession };
JS
commit_all "auth: add session token construction" "2026-09-22T09:00:00+00:00"
