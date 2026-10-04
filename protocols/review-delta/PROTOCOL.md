# review-delta

A scoped second look at an accepted fix: the spec axis and the standards axis run independently
and in parallel against the same snapshot, bounded by affected behavior rather than by changed
lines, with novelty evidence required for anything new. At most two fix cycles.

The independence here is **parallel**: the two lanes run at once precisely so neither inherits
the other's dispatch context. That is the opposite mechanism from `consensus-plan-gate`, whose
architect and critic are strictly **sequential** so the second is not anchored on the first's
argument. Both are real independence; a reader who assumes one pattern gets the other wrong.

## When to use

`super-review` invokes this protocol through its `delta` entrypoint after `apply-findings` has
applied and verified a fix inside an already-open review run. `babysit-pr` invokes it after a CI
repair or a pushed correction. `autopilot` reaches it through the `review.delta` operation.

## Not for

- Not a second panel. It does not re-run pass 1's seats and does not restart discovery
  (`policies/review.yaml` `delta.is_not`).
- Not for the first look at a change. A run with no open review returns `needs-input` naming
  `super-review full`; this protocol never opens a review run.
- Not for applying anything. `apply-findings` applies and verifies; this protocol judges whether
  the result holds.
- Not for a plan. `consensus-plan-gate` judges a plan; this judges a change.

## Invoked by

`super-review` (entrypoint `delta`), `babysit-pr` and `autopilot`, through the `review.delta`
phase operation. A protocol holds no authority of its own and never widens the authority it was
called with (ruling `entrypoint-phase-operation-split`; protocol `phase-operations`).

## Inputs

The packet, assembled once and read by both lanes:

- Persisted from pass 1: the finding list, the input hashes, the dispositions and the evidence.
- Added for the delta: the latest fix diff, the touched dependencies, and the
  `schemas/verification.schema.json` receipts bound to the new head.
- The snapshot: `comparison_base`, `reviewed_head` and `last_head_verified`, recorded so the
  three are never conflated (ruling `delta-baseline-reset-not-third-loop`).
- For each finding, the prior-finding packet — `finding_id`, `fingerprint`, `severity`,
  `evidence`, `disposition`, `input_hashes`, `source_revision`. A continuing seat may retain its
  earlier context; a replacement receives this packet. Either way the seat sees the old finding
  and the new revision (ruling `reviewer-continuity-not-amnesia`).

Neither lane receives the implementer's narrative, rationale or self-assessment, nor the other
lane's findings (`policies/review.yaml` `pass_1.seat_context.never_receives`).

## Workflow

1. Fail fast before dispatch: confirm the comparison base resolves, the fix diff is non-empty and
   the receipts bind to `reviewed_head`. A bad base or an empty diff stops here, before either
   lane is seated.
2. Freeze the snapshot and record its hashes in the `schemas/review.schema.json` record.
3. Seat `reviewer-spec` and `reviewer-standards` in parallel on that snapshot, each with the
   packet and neither with the other's output.
4. Collect each lane's result as `complete`, `empty` or `unavailable`.
5. For each prior finding, record `ADDRESSED` or `NOT ADDRESSED` with a `file:line` reference in
   the fix diff. This is a closure check, not a re-litigation of whether the finding was valid.
6. Check the fix diff alone for new breakage it introduced. Do not re-review the whole file.
7. Admit a new finding only with novelty evidence: what changed, or what regressed, that makes
   this finding new. Unrelated low-priority discovery is ledgered as an out-of-scope
   observation, never looped into another round (ruling `delta-scope-affected-behavior`).
8. Route unresolved security, data or API findings back to that specialist seat alone. Do not
   trigger another full fan-out.
9. Synthesize the verdict: a required lane `unavailable` yields `blocked` (ruling
   `required-lane-failure-is-unavailable`); else a lane requesting changes yields
   `changes-requested`; `approved` requires every required lane `complete` or `empty` and every
   prior finding independently closed (ruling `closure-requires-independent-verification`).
10. If findings remain open, hand control back for the next fix cycle — at most twice — and
    record `fix_cycles`.

## Hard gates

Gate: the scope boundary is affected behavior, not changed lines. A serious newly discovered
issue in an untouched but affected caller stays reportable; scope discipline is not a reason to
suppress relevant evidence (ruling `delta-scope-affected-behavior`).

Gate: a lane that could not run, could not be given its required context, or failed returns
`unavailable`. That is a result, not an absence. A required `unavailable` lane blocks approval,
is never downgraded to `empty`, and is never backfilled by the author, the implementer, another
seat or the synthesis step (ruling `required-lane-failure-is-unavailable`).

Gate: the two axes are reported under separate headings with one summary line each, even when
they agree. They are never merged into a single score. A change can pass one axis and fail the
other, and one number hides whichever axis lost.

Gate: a finding is closed only by independent verification evidence that binds to the revision
under review, plus a policy rule saying that evidence suffices. An author never closes their own
finding (ruling `closure-requires-independent-verification`).

Gate: clearing a security, data-loss, auth, injection or contract-class finding requires a cited
reason of one of four kinds — a quoted refuting line with file and line, version- or
configuration-specific documentation naming the version in force, short-hash provenance
establishing unrelated pre-existing code, or a discriminating test result naming the reviewed
revision, runtime, configuration, trigger, assertion and observed result. An uncited or
self-referential rejection is not a rejection; it becomes `unresolved`, which stays in the report
as a verification gate.

Gate: at most two fix cycles. The third stops with an explicit blocked-or-replan decision
(ruling `two-fix-cycles-then-stop`).

Gate: when architecture, requirements, the comparison base or the affected surface changes
materially, affected approvals are invalidated and a new baseline is deliberately established.
That is a new review scope with its own pass 1, not an unbounded third delta loop (ruling
`delta-baseline-reset-not-third-loop`).

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The issue is in a caller the fix never touched, so it is out of delta scope." | The boundary is affected behavior, not changed lines; a line-based boundary suppresses exactly the class of issue the delta exists to catch (ruling `delta-scope-affected-behavior`). | Report it, with the impact path from the fix to that caller as its evidence. |
| "The standards lane could not be given its context, but the spec lane approved and they usually agree." | An unavailable required lane is not a passing lane, and "we could not look" is a different claim from "we looked and found nothing" (ruling `required-lane-failure-is-unavailable`). | Record the lane `unavailable`, name why, block approval, and keep the run resumable. |
| "Both axes agree, so one combined verdict is clearer." | Merging hides the case the split exists for: code that is clean but does not do what was asked, or does what was asked while violating every convention. | Report a summary line per axis under its own heading, and let the verdict be derived, not blended. |
| "The implementer's note says this is already handled elsewhere." | A claim in the diff is the author's confidence. Clearing a protected finding needs one of the four cited evidence kinds. | Route it to `unresolved` and request the citation. |
| "Line numbers moved, so this looks like a new finding." | The fingerprint is rule-or-cause plus location-or-symbol plus evidence, deliberately not the line number, so moving a line neither duplicates nor suppresses a finding. | Match on fingerprint against the prior-finding packet and continue the existing finding. |
| "The architecture changed under us, but one more cycle would land it." | Continuing would review a snapshot nobody approved (ruling `delta-baseline-reset-not-third-loop`). | Invalidate the affected approvals and establish a new baseline with its own pass 1. |
| "Give the closing reviewer a clean context so it judges the fix on its merits." | Fresh means independent of the author, never ignorant of prior findings; amnesia is the forbidden reading (ruling `reviewer-continuity-not-amnesia`). | Hand it the prior-finding packet plus the new revision. |

## Outputs

One `schemas/review.schema.json` record with `mode: delta`, the snapshot, the lane results and
seats, the per-finding `ADDRESSED` / `NOT ADDRESSED` dispositions, `new_findings` with their
`novelty_evidence`, `fix_cycles`, `verdict`, and `baseline_reset` when one was triggered. Open
findings keep their evidence. Out-of-scope observations are ledgered on the record, not looped.
Anything published as project knowledge goes through the knowledgebase adapter (ruling
`central-kb-owns-project-artifacts`), whose publish command is in the
[knowledgebase-backend reference pack](../../references/knowledgebase-backend/REFERENCE.md).

## Side effects

`artifact-write`. Reviewers cannot edit source: no `workspace-write`, no commits, no pushes.

## Stop conditions

- `complete`: both required lanes returned a result, every prior finding has a disposition, and
  the verdict is recorded.
- `needs-input`: no review run is open, the comparison base does not resolve, the fix diff is
  empty, or a required lane's context could not be assembled.
- `cap-reached`: the second fix cycle ended with findings open. Returns the cap object, the open
  findings and the blocked-or-replan decision.
- `failed`: the snapshot could not be frozen, so no lane can be seated on a stable hash.
- `cancelled`: the runner cancelled the run.

## Limits

- Fix cycles: 2 (gate, `policies/limits.yaml` `fix_cycles`).
- Heads reviewed per run: 3 (gate, `policies/limits.yaml` `review_rounds`) — the first snapshot
  plus the head from each permitted fix cycle.
- Lanes: 2, both required (gate). A third lane is a new scope, not a tiebreak.
- Per-lane output length is capped by the invoking skill so aggregation stays comparable; that
  number is a configurable starting point (guidance).
