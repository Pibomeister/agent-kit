# How to run TP-LIFE on a host

The code in this tree supplies the fixture, the oracle, and HEAD-bound receipts.
G4 stays `not-run` until you record live receipts under `research/tp-life/receipts/`
that `scripts/tp-life.sh receipt check` accepts for the candidate HEAD.

Do not copy a local fixture report into that directory and call G4 passed. G4
needs the operator run below on a named host tuple.

`scripts/tp-life.sh evidence` computes the verdict from those bound receipts.
Do not copy or edit `research/tp-life/evidence.template.json`.

## 0. Candidate

Record `git rev-parse HEAD`, `git status --porcelain=v1`, bundle version, host,
OS, and whether `claude` or `codex` is signed in. Missing host login is a
blocker, not a pass.

## 1. Fixture

Start from the v1-state fixture. Duplicate submission is unspecified, so the
service creates a new job for a repeated `idempotency_key`.

From the repository root:

```bash
scripts/tp-life.sh fixture --port 4173 --broken duplicate
```

Leave it running. Open `http://127.0.0.1:4173/` and submit one succeed job.
The status line must move to `success`.

## 2. Ambiguity in spec v1

Give the host `research/tp-life/spec-v1.md` as the governing specification.
Require a finding that duplicate submission is unspecified, and a recorded
disposition, before any implementation ticket is eligible.

## 3. Authorized revision

Apply `research/tp-life/spec-v2.md`. Finish review. Bind tickets to that
document's hash.

## 4. Implement and oracle

Keep the v1-state fixture from step 1. From a second environment that does not
import the fixture sources, run the oracle against it. It must fail. Write that
receipt and keep it.

```bash
scripts/tp-life.sh oracle --base-url http://127.0.0.1:4173 --out /tmp/tp-life-oracle-v1.json
scripts/tp-life.sh receipt write --oracle-json /tmp/tp-life-oracle-v1.json --out /tmp/tp-life-receipt-v1.json
```

The oracle must exit 1. The duplicate case fails. Keep
`/tmp/tp-life-receipt-v1.json`.

A separate implementer then executes the tickets against the fixture contract.
Restart the fixture without `--broken`:

```bash
scripts/tp-life.sh fixture --port 4173
scripts/tp-life.sh oracle --base-url http://127.0.0.1:4173 --out /tmp/tp-life-oracle.json
scripts/tp-life.sh receipt write --oracle-json /tmp/tp-life-oracle.json --out /tmp/tp-life-receipt.json
scripts/tp-life.sh receipt check /tmp/tp-life-receipt.json
```

The oracle must exit 0 with `6 pass, 0 fail`. Keep `/tmp/tp-life-receipt.json`
only if check exits 0 on the candidate HEAD.

## 5. Stale evidence

Change the specification or the fixture after that receipt. Run
`ak lifecycle check --evidence`. It must refuse the old receipt. Confirm with:

```bash
scripts/tp-life.sh receipt check /tmp/tp-life-receipt.json
```

Expect exit 2 once HEAD or the working tree no longer matches.

## 6. Negative paths

On the same tuple, each of these must be rejected:

1. Offer only `research/tp-life/spec-v2.md` as verification and try to ship.
2. Council bypass. Advance with no council: `ak lifecycle check --gates ship-preflight` without `ak council run`. It must refuse.
3. Extra. Approve a council card without a recorded veto where the charter requires one.
4. Label an unattended advance as human approval.

A system that blocks every action, including the legitimate flow in steps 1-4,
is not a pass.

## 7. Record G4

Copy both receipts into `research/tp-life/receipts/` as `.json` files. Untracked
files in that directory do not change the tree snapshot hash. Committing one
changes HEAD and the receipt no longer binds.

Then run:

```bash
scripts/tp-life.sh evidence
```

The printed verdict is computed from receipts that bind to HEAD, pass
`schemas/verification.schema.json`, carry the TP-LIFE oracle id and kind,
status `passed`, exit 0, and a `diff_hash`. The failed v1 receipt does not
count. G4 stays `not-run` when no such receipt is bound. Editing the template
verdict does not pass G4.
