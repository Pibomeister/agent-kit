#!/usr/bin/env bash
# TP-LIFE fixture, independent oracle, HEAD-bound receipts, G4 evidence record.
#
#   scripts/tp-life.sh fixture [--port PORT] [--broken pending|success|failure|disconnect|duplicate|unknown]
#   scripts/tp-life.sh oracle --base-url http://127.0.0.1:PORT [--out /tmp/tp-life-oracle.json]
#   scripts/tp-life.sh receipt write [--cwd REPO] --oracle-json /tmp/tp-life-oracle.json --out /tmp/tp-life-receipt.json
#   scripts/tp-life.sh receipt check [--cwd REPO] /tmp/tp-life-receipt.json
#   scripts/tp-life.sh evidence [--cwd REPO] [--receipts-dir DIR]
#
# The fixture and the oracle are separate programs. The oracle speaks HTTP only.
# Relative paths on receipt write and check resolve against the repo.
# A --out inside the repo, outside research/tp-life/receipts/, and not
# gitignored, prints a warning: that file stales the next snapshot.
# evidence always prints G4 as not-run. oracle_sub_verdict is computed from
# unattested receipts under research/tp-life/receipts/. Local fixture runs do
# not write that directory.
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
