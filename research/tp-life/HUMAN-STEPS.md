# How to run TP-LIFE on a host

The code in this tree supplies the fixture, the oracle, and HEAD-bound receipts.
`scripts/tp-life.sh evidence` always prints G4 as `not-run`. A human records G4.

`oracle_sub_verdict` is computed from unattested receipts. Their origin and the
head they ran on rest on the operator's word. Machine-checked covers only the
per-case comparison inside each receipt.

Do not copy or edit `research/tp-life/evidence.template.json`.

## 0. Candidate

Record `git rev-parse HEAD`, `git status --porcelain=v1`, bundle version, host,
OS, and whether `claude` or `codex` is signed in. Missing host login is a
blocker, not a pass. `receipt write` copies those fields from this checkout
into the receipt. It does not run the oracle and it does not talk to
`127.0.0.1`. Set `AK_TP_LIFE_HOST_LOGIN` to `claude`, `codex`, or `none`
before you write.

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

Keep the v1-state fixture from step 1. Run the oracle against
`http://127.0.0.1:4173` from this checkout. It must fail. Write a receipt from
the saved report. The receipt binds to this HEAD at write time.

```bash
scripts/tp-life.sh oracle --base-url http://127.0.0.1:4173 --out /tmp/tp-life-oracle-v1.json
scripts/tp-life.sh receipt write --oracle-json /tmp/tp-life-oracle-v1.json --out /tmp/tp-life-receipt-v1.json
```

The oracle must exit 1. The duplicate case fails. Keep
`/tmp/tp-life-receipt-v1.json`. Receipts written from a saved report are
marked unattested. The write command does not re-run the oracle.

The clean fixture stands in for the implemented service. Red-to-green is
restarting the fixture without `--broken`. Stop the v1 process, then:

```bash
scripts/tp-life.sh fixture --port 4173
scripts/tp-life.sh oracle --base-url http://127.0.0.1:4173 --out /tmp/tp-life-oracle.json
scripts/tp-life.sh receipt write --oracle-json /tmp/tp-life-oracle.json --out /tmp/tp-life-receipt.json
scripts/tp-life.sh receipt check /tmp/tp-life-receipt.json
```

The oracle must exit 0 with `6 pass, 0 fail`. Keep `/tmp/tp-life-receipt.json`
only if check exits 0 on the candidate HEAD.

## 5. Stale evidence

This receipt is not a lifecycle verify receipt. `ak lifecycle check --evidence`
does not accept it.

Show staleness with `scripts/tp-life.sh receipt check`. It exits 0 before you
edit a tracked file, and 2 after. Editing a tracked file stops the step-4
receipts from binding.

```bash
scripts/tp-life.sh receipt check /tmp/tp-life-receipt.json
```

Expect exit 0. Then edit a tracked file. Check again:

```bash
scripts/tp-life.sh receipt check /tmp/tp-life-receipt.json
```

Expect exit 2. Revert the tracked-file edit before step 7 so the receipts
still bind.

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

The printed G4 verdict stays `not-run`. A human records G4. `oracle_sub_verdict`
is computed from unattested receipts. It is `red-to-green` only when this head
has one bound failed receipt where only `duplicate` failed and one bound passed
receipt. Duplicate copies count once. Otherwise it is `incomplete`. Their origin
and the head they ran on rest on the operator's word. Machine-checked covers
only the per-case comparison inside each receipt. Steps 2, 3, 5 and 6 also rest
on the operator's word.
