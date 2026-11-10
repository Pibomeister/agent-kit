# How to run TP-LIFE on a host

The code in this tree supplies the fixture, the oracle, and HEAD-bound receipts.
G4 stays `not-run` until you record live receipts under `research/tp-life/receipts/`
that `scripts/tp-life.sh receipt check` accepts for the candidate HEAD.

Do not copy a local fixture report into that directory and call G4 passed. G4
needs the operator run below on a named host tuple.

## 0. Candidate

Record `git rev-parse HEAD`, `git status --porcelain=v1`, bundle version, host,
OS, and whether `claude` or `codex` is signed in. Missing host login is a
blocker, not a pass.

## 1. Fixture

From the repository root:

```bash
scripts/tp-life.sh fixture --port 4173
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

A separate implementer executes the tickets against the fixture contract.
Then, from a second environment that does not import the fixture sources:

```bash
scripts/tp-life.sh oracle --base-url http://127.0.0.1:4173 --out /tmp/tp-life-oracle.json
scripts/tp-life.sh receipt write --oracle-json /tmp/tp-life-oracle.json --out /tmp/tp-life-receipt.json
scripts/tp-life.sh receipt check /tmp/tp-life-receipt.json
```

The oracle must exit 0 with `5 pass, 0 fail`. Keep the receipt only if check
exits 0 on the candidate HEAD.

## 5. Stale evidence

Change the specification or the fixture after that receipt. Run the next gated
operation (`ak lifecycle check` or the host's ship/verify step). It must refuse
the old receipt. Confirm with:

```bash
scripts/tp-life.sh receipt check /tmp/tp-life-receipt.json
```

Expect exit 2 once HEAD or the working tree no longer matches.

## 6. Negative paths

On the same tuple, each of these must be rejected:

1. Offer only `research/tp-life/spec-v2.md` as verification and try to ship.
2. Approve a council card without a recorded veto where the charter requires one.
3. Label an unattended advance as human approval.

A system that blocks every action, including the legitimate flow in steps 1-4,
is not a pass.

## 7. Record G4

Copy the bound receipts into `research/tp-life/receipts/`. Fill a dated copy of
`research/tp-life/evidence.template.json` with those paths, the host tuple, and
the honest verdict. Then:

```bash
scripts/tp-life.sh evidence
```

G4 may leave `not-run` only when that directory still has no receipt bound to
HEAD. Do not edit the template's verdict to `passed` without those files.
