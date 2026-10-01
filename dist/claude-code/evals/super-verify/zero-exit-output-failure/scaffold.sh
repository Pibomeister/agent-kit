#!/usr/bin/env bash
# Scaffold for evals/super-verify/zero-exit-output-failure.
#
# The project wrapper uses a POSIX pipeline whose status is tee's. The two
# behavioral failures are conclusive even though the wrapper itself exits 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

repo_init
cp -R "$SCRIPT_DIR/project" .
chmod +x project/check.sh
cat > README.md <<'MD'
# Zero-exit verification fixture

AC-1 requires `add`, `clamp`, and `mean` to satisfy the examples in
`project/math.test.ts`. Verify it with the project's own command:

```sh
cd project && sh ./check.sh
```
MD
commit_all "fixture: zero-exit wrapper reports behavioral failures" "2026-09-29T16:11:00+00:00"

echo "scaffold: zero-exit fixture ready at $(git rev-parse --short HEAD)"
