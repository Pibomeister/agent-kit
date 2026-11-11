Live TP-LIFE receipts bound to a candidate HEAD go in this directory as `.json`
files. `scripts/tp-life.sh evidence` reads them. G4 stays `not-run` in that
output. `oracle_sub_verdict` is computed from unattested receipts. Their origin
and the head they ran on rest on the operator's word. Machine-checked covers
only the per-case comparison inside each receipt.

Untracked files here are omitted from the tree snapshot hash, so a genuine
receipt copied in still binds. Committing a receipt changes HEAD and refuses it.

Do not put local fixture reports here. Follow `research/tp-life/HUMAN-STEPS.md`.
