#!/usr/bin/env bash
# TP-LIFE fixture, independent oracle, HEAD-bound receipts, G4 evidence record.
#
#   scripts/tp-life.sh fixture [--port PORT] [--broken pending|success|failure|disconnect|duplicate|unknown]
#   scripts/tp-life.sh oracle --base-url http://127.0.0.1:PORT [--out report.json]
#   scripts/tp-life.sh receipt write --oracle-json report.json --out receipt.json
#   scripts/tp-life.sh receipt check receipt.json
#   scripts/tp-life.sh evidence
#
# The fixture and the oracle are separate programs. The oracle speaks HTTP only.
# evidence prints G4. The verdict is computed from receipts under
# research/tp-life/receipts/ that bind to HEAD. The template verdict is ignored.
# Local fixture runs do not write that directory.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cmd="${1:-}"
if [ "$#" -gt 0 ]; then
  shift
fi
case "$cmd" in
  fixture)
    exec bun "$root/tests/fixtures/tp-life/service/server.mjs" "$@"
    ;;
  oracle)
    exec bun "$root/tests/fixtures/tp-life/oracle/oracle.mjs" "$@"
    ;;
  receipt | evidence)
    exec bun "$root/src/tp-life/cli.ts" "$cmd" "$@"
    ;;
  *)
    echo "usage: scripts/tp-life.sh fixture|oracle|receipt|evidence" >&2
    exit 2
    ;;
esac
