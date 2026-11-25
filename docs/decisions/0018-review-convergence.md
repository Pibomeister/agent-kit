# ADR-0018 — Review convergence: a ledger, an evidence bar and a stop rule

**Status:** Accepted.
**Date:** 2026-11-19.
**Authority:** the owner's order of 2026-11-19, 11:13 CST, request `ed-1113-revconv`, in the words
"Yes and yes but don't trim", given on the review-convergence plan and relayed by Firstmate. The
plan and its research file are the Firstmate data record `review-convergence/plan.md` and
`research.md`. The order approves the plan and assigns this package the ledger and the verdict
tool.
**Prior art read:** ADR-0012, ADR-0013, ADR-0014, ADR-0015, ADR-0017, `policies/limits.yaml`
`fix_cycles` and `review_rounds`, `policies/review.yaml` blocks `delta`, `continuity` and
`baseline_reset`, `protocols/review-delta/PROTOCOL.md`, `schemas/finding.schema.json`, and
sections 2 to 7 of the plan.

## Context

A review of one pull request can fail to end. Each round reads the whole change again, a seat may
raise a new finding on code that did not change, and one seat's `BLOCK` outvotes every approval.
The plan measured this on one Firstmate pull request that took eight review rounds, and found
status changes with no code change and no new evidence between them.

`policies/limits.yaml` already caps a review run at three heads and two fix cycles. The cap binds
the lifecycle review. It did not bind a merge gate outside the lifecycle, and nothing computed the
result at the cap: the synthesizing model decided which findings still blocked.

## Decision

One append-only **convergence ledger** holds the findings of a pull request, and one pure function
reads the verdict from it. `ak review ledger add` and `ak review ledger show` write and read the
ledger. `ak review decide` prints the verdict for one exact head.

1. **The engine owns the verdict.** `decide(ledger, policy, context)` in `src/review/converge.ts`
   reads no file, no clock and no environment, and calls no model. The same lines and the same
   context give the same record. The verdict is `approved`, `blocked` or `incomplete`, with one
   next action. A seat's `BLOCK` word alone never makes the verdict `blocked`. Only ledger rows
   block. `approved` needs at least one seat whose latest verdict in the scope approves at the
   head or carries to it. The pipeline seat delivers no verdict. With no approving seat the verdict
   is `incomplete`.
2. **The ledger is a fold.** `schemas/review-ledger.schema.json` is the form of a line. A line is
   never edited. A status change is a new line for the same finding id, and the state is a fold
   over the lines. `seq` counts lines from 1 with no gap. A reader skips a line that is not JSON,
   which is what an interrupted write leaves, and refuses a file with a missing or foreign line.
3. **One finding, one row.** The fingerprint is the digest of the category, file, symbol and
   cause key. It holds no line number, so moved code keeps its row. A second seat that reports the
   same fingerprint is added to the row. The tool computes the symbol and the digest of its body
   from a snapshot. The rule is the one `git diff` uses for a hunk header and reads no grammar.
4. **Round 1 is the one open-ended pass.** A finding of round 1 blocks when it is P0 or P1 and
   introduced. Reading evidence is enough there.
5. **After round 1 the bar is evidence.** A new finding blocks only inside the delta scope and
   with a reproduction that is red at the head and green at the merge base. A reproduction line
   records both exit statuses. A run that is red at the head and records no merge-base result is
   not red: it neither keeps a row open nor reopens one. A finding outside the
   scope is an observation. P2, P3, pre-existing findings and a convention finding with no cited
   project rule never block. They are filed, and each filed row needs a follow-up reference
   before the verdict is `approved`.
6. **Always-block classes.** A security, destructive or data-loss finding blocks in any round with
   no reproduction, when the seat names the asset at risk and the action that harms it. Without
   that sentence the row is an ordinary one. Such a row leaves the blocking set on a green
   reproduction, when every seat of the round calls it addressed, or on the owner's order. It never
   goes to the council.
7. **Closure is by evidence first.** A reproduction that turns green closes its row with no vote.
   A red one keeps the row open with no vote. With no reproduction the holding seat's `ADDRESSED`
   closes the row, and `NOT-ADDRESSED` with no red reproduction defers it. The author answers
   `fixed` or `dispute` and never closes a row.
8. **A terminal row reopens for a reason.** The reasons are a changed symbol body inside the delta
   scope, a new red reproduction, or an always-block class newly made concrete. Any other repeat
   is a counted `flip` and changes nothing.
9. **The cap is three rounds per scope:** one full and two closure. A scope may lower the cap to
   two. Nothing raises it. A human extension is one more closure round, once per scope. The
   numbers are those of `policies/limits.yaml`.
10. **Every row gets an outcome at the cap, by rule.** A row with a red reproduction, and an
    always-block row, escalate. A row whose theme reopened in two consecutive rounds escalates as
    a design decision. Every other open row is deferred.
11. **Escalation is bounded.** A pull request gets one council call, with one card per escalated
    row and the options `follow-up` and `fix`. A ruling of `fix` gives one bounded closure round
    that admits no new finding except an always-block one. A row still red after it is one hold
    for the owner. An always-block row skips the council.
12. **A new review scope restarts the round count and invalidates the approvals.** The rows stay.
    A pull request opens one new scope. A further one holds it for a split-or-replan decision.

`DEFAULT_POLICY` in `src/review/types.ts` holds the cap, the scope count, the always-block
categories and the blocking severities. The engine compares these values and interprets none.

## What does not change

- **The delivery pipeline's Review.** It runs the same way for every class and every round
  (ADR-0017, requirement 12). The ledger imports its findings as round 0 under the seat
  `pipeline`. That seat never rules, and an imported finding blocks only when a review seat
  reports it too.
- **Review depth.** ADR-0017 selects the seats of the first pass. This record does not select a
  seat. The caller tells `decide` how many seats the tier requires and which evidence is missing.
- `ak council run` and ADR-0015. The engine prints council cards. It does not call the council.
- The unattended policy (ADR-0014). A human merges every class.
- `policies/limits.yaml` values, the finding schema and the invocation law.

## Readings this record makes

The plan leaves these points open. Each is a choice of this record, held by a test in
`tests/review/`.

- **A hold is an action, not a verdict.** The verdict is `blocked` only while a row blocks. A hold
  with no blocking row is `incomplete` with the action `owner-hold` or `captain-hold`.
- **Approval coverage.** `approved` needs round 1 of the scope to have sat the seats the tier
  requires, at least one seat whose latest verdict approves, and the head to be the one the last
  closed round or carry covers. A head that moves
  after the cap is the owner's call.
- **A filed row is `deferred` at once**, with the disposition `note`, `unreproduced`, `split` or
  `cap`.
- **An always-block row stays blocking when its reproduction is also red at the merge base.**
- **The scope's cap is recorded on round 1 of the scope.**
- **Evidence does not promote an observation.** A review seat's report does.
- **An extension may follow the council call.** It is still one closure round.
- **The near-duplicate judgment is outside the engine.** The tool lists candidate rows with the
  same theme. A `duplicate` line records the judgment. An always-block row is never recorded as a
  duplicate of an ordinary one.

## Alternatives rejected

- **Keep same-head unanimity and add a round cap.** Rejected. A cap with no rule for the open rows
  moves the decision to whoever is present at the cap.
- **Let a model decide closure from the ledger.** Rejected. The plan's evidence is that two runs of
  a model give different answers on the same head. A pure function does not.
- **Edit a row in place.** Rejected. An interrupted write could then lose more than one line, and
  two readers could reach different states.

## Consequences and limits

- The ledger is single-writer evidence that a gate holds. The engine does not check who appended a
  line, and a record of any of the three commands grants no authority.
- The tool runs no reproduction. The caller runs it and records the exit status at the head and at
  the merge base.
- The symbol rule reads no grammar. A language with no column-one declarations anchors a finding
  to the file's first lines, and its fingerprint then changes only with the cause key.
- This record lands with the ledger and the engine. No skill, protocol or gate calls them yet, so
  no review changes. The policy block that carries these values as data, the scope triggers and
  the protocol wiring are later changes.
- The mutation check in `tests/review/mutation.test.ts` breaks each rule once and expects a red
  test. A rule added to the engine needs a mutant there.
