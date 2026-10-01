#!/usr/bin/env bash
# Scaffold for evals/doc-review/drafted-spec-gets-a-panel.
#
# The knowledgebase adapter has no implementation in the workspace, so the
# workspace is a checkout of the knowledgebase itself, in which
# kb://<path> is the page <path>.md (README.md says so). It holds the
# document under review, plans/settlement-v2.md, and its origin,
# requirements/settlement.md, approved.
#
# The plan carries what the prompt says it does -- a widening of who can read
# the settlement ledger, a reconciliation abstraction new to the codebase,
# and a stretch section last -- and leaves two questions open that its origin
# does not answer: how long merchant-visible ledger history is kept, and
# whether a merchant sees entries still pending reconciliation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../super-build/_fixtures/scaffold-lib.sh
source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"

repo_init
mkdir -p plans requirements
cat > README.md <<'MD'
# payments knowledgebase

Checkout of the central knowledgebase's pages for the payments project.
A `kb://<path>` reference names the page at `<path>.md` in this checkout:
`kb://requirements/settlement` is `requirements/settlement.md`.

Each page carries its kind, status and owner in its frontmatter.
MD
cat > requirements/settlement.md <<'MD'
---
kind: prd
status: approved
approved: 2026-08-28
owner: payments
---

# Settlement: requirements

## Problem

Merchants learn what was settled to them from a nightly CSV that support
emails on request. Disputes about a missing or short payout take days,
because the only people who can read the settlement ledger are the two
engineers on the payments team.

## Requirements

S1. A merchant can see every payout made to them and the transactions it
    settled, without asking support.
S2. Support can see the same, for any merchant, while handling a ticket.
S3. A payout that does not match the processor's settlement report is
    flagged within one business day.
S4. Nobody gains the ability to change a ledger entry through this work.

## Out of scope

Changing how payouts are calculated. Multi-currency settlement.
MD
commit_all "requirements: settlement (approved)" "2026-08-28T12:00:00+00:00"

cat > plans/settlement-v2.md <<'MD'
---
kind: prd
status: draft
owner: payments
origin: kb://requirements/settlement
---

# Settlement v2: implementation plan

## Summary

Open the settlement ledger to merchants and to support, and replace the
nightly CSV reconciliation script with a reconciliation engine that runs
continuously.

## Ledger access

Today the ledger is readable only by the `payments-eng` role, through a
direct database connection.

L1. Add a read API over the ledger: `GET /settlements` and
    `GET /settlements/{payoutId}`.
L2. Merchants call it with their dashboard session and see the rows whose
    `merchant_id` matches the session's merchant.
L3. Support calls it through the admin console with the `support` role and
    may pass any `merchant_id`.
L4. The API reads from a replica, so it cannot write to the ledger.
L5. Ledger history is exposed from the first payout onward.

## Reconciliation engine

The CSV script compares yesterday's ledger with the processor's report once
a night. It will be replaced by a `Reconciler`: a long-running worker that
consumes ledger writes and processor webhooks as two streams and matches
them through a `MatchPolicy`.

R1. A `MatchPolicy` decides whether a ledger entry and a processor record
    are the same payout. Policies are pluggable, so a new processor needs a
    new policy and nothing else.
R2. Matched pairs are written to a `reconciliation_matches` table.
R3. An entry unmatched after 24 hours raises a `payout.unmatched` alert.
R4. Merchants see an entry as soon as it is written to the ledger, whether
    or not it has been matched yet.
R5. The CSV script is switched off once the engine has run for two weeks
    with no alert the script would not also have raised.

## Rollout

1. Ship the read API behind a flag, support first, merchants a week later.
2. Run the engine alongside the CSV script for two weeks.
3. Switch off the script.

## Stretch: merchant payout forecasting

If time allows, add `GET /settlements/forecast`, which predicts a
merchant's next three payouts from their last ninety days of volume, and a
chart on the dashboard that shows it. The forecast reuses the `Reconciler`'s
streams so it stays current.
MD
commit_all "plans: settlement v2 draft" "2026-09-24T17:45:00+00:00"

echo "scaffold: knowledgebase checkout ready at $(git rev-parse --short HEAD)"
