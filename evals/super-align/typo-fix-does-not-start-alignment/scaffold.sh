#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

service_repo_baseline
grep -q '^module\.exports = { render };$' src/email/templates.js
sed -i.bak '/^module\.exports = { render };$/d' src/email/templates.js
rm src/email/templates.js.bak
cat >> src/email/templates.js <<'JS'
module.exports = {
  render,
  invoiceFooter: 'Payement due on reciept',
  receiptSubject: 'Your payment receipt',
};
JS
commit_all "copy: add invoice footer" "2026-09-22T09:00:00+00:00"
