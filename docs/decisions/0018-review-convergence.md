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
ledger. `ak review decide` prints the verdict for one exact head. `ak review scope` prints what the
next review covers.

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
13. **Six triggers open a new scope, and nothing else does.** `ak review scope` compares the pull
    request at a head with the pull request at the last reviewed head, which the ledger names.
    - `large-rebase`: the patch changed and the rewritten commits changed lines amounting to more
      than 30% of the pull request's changed lines, or a merge resolved a conflict in a path of
      the pull request, or a merge has more than two parents. A two-parent merge that git
      resolved with `-X ours` is still a conflicted merge.
    - `path-identity`: a path changed as a gitlink (mode 160000), or a same-blob add and delete
      pair appears, which is a rename when rename detection is off.
    - `risk-tier-rise`: the merge-stage class is above the class of the last reviewed round.
    - `surface-changed`: `review_surface_changed` is true in the merge-stage record.
      `ak delegation --stage merge --previous <record>` prints that field.
    - `scope-growth`: the delta adds more than 50% to the pull request's changed lines, or more
      than 400 lines, or the intent file changed.
    - `requirement-change`: the digest of the ticket's acceptance criteria changed.

    A fix commit, a reached cap and a rebase that leaves the blobs unchanged open nothing.
14. **An unchanged tree calls no seat only when ancestry is also reviewed work.** When every path
    of the pull request has the same mode and blob it had at the last reviewed head, and every
    non-merge commit in `previous..head` excluding `base` is empty or has the patch of a reviewed
    own commit or of the reviewed pull request, the outcome is `carry` and the earlier verdict
    covers the new head. A novel own commit is `closure` or a new scope. The changed-line patch
    id is only for rewritten-commit matching. Content that arrives only through the base branch is
    trusted base movement. The base branch, like the ledger, must sit outside author write.

`DEFAULT_POLICY` in `src/review/types.ts` holds the cap, the scope count, the always-block
categories, the blocking severities and the trigger thresholds. The tools compare these values and
interpret none. `policies/review.yaml` `convergence` records the same values as data, and
`tests/review/policy.test.ts` holds the two equal.

## What does not change

- **The delivery pipeline's Review.** It runs the same way for every class and every round
  (ADR-0017, requirement 12). The ledger imports its findings as round 0 under the seat
  `pipeline`. That seat never rules, and an imported finding blocks only when a review seat
  reports it too.
- **Review depth.** ADR-0017 selects the seats of the first pass. This record does not select a
  seat. The caller tells `decide` how many seats the tier requires and which evidence is missing.
  `policies/review.yaml` `convergence.evidence_by_class` records the evidence and the seat count
  of each class as data. No skill or protocol reads that map yet.
- **The delegation class.** `scoreMergeStage` scores as before. `review_surface_changed` compares
  two printed records and changes no class, and the ticket's delegation block never holds it.
- `ak council run` and ADR-0015. The engine prints council cards. It does not call the council.
- The unattended policy (ADR-0014). A human merges every class.
- `policies/limits.yaml` values, the finding schema and the invocation law. The two review caps
  now also name `review.merge-gate`: a project's merge gate that reads the cap through
  `ak review decide`. It is a label in that file and not a phase operation.

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

The scope command makes these readings, held by `tests/review/scope.test.ts` and
`tests/review/scope-git.test.ts`.

- **The patch id is this package's own.** It is the digest of the changed lines of a diff with no
  context lines, in order, with the file headers and without the hunk headers. Whitespace counts,
  so an indentation change is a change. `git patch-id` ignores whitespace and reads context lines,
  so a change beside the pull request's lines on the base branch would change it. An old-mode and
  new-mode pair counts as one changed line. A gitlink counts as one SHA line. Empty is not this
  id: it is the raw tree, path, mode and blob.
- **A rewritten commit is one whose patch no commit of the new head has.** This is the exact-match
  rule of `git range-diff`, applied to patches with no context. A reworded message is not a
  rewrite. With no rewritten commit the share is zero. Otherwise it is read from the pull request
  as a whole, never by adding up commits. A commit of the new head is reviewed work when a reviewed
  commit has its patch, or when the pull request at the last reviewed head holds at least half of
  its changed lines. "At least half" is a fixed reading, not a policy value. The cut is the last
  commit of the new head that is reviewed work, and the pull request is read again at the cut,
  from the cut's own merge base with the base branch, so a merge of the base branch after the cut
  adds no line. The
  count is the larger of two figures: the lines the reviewed pull request holds and the pull
  request at the cut does not, and the reverse. The commits after the cut are new commits, which
  scope growth reads and which add nothing here, whether they add lines or remove them. A new
  commit placed before reviewed work is inside the cut, so its lines count as rewritten. No commit
  message is read.
- **A rebase that leaves the patch of the pull request unchanged opens nothing**, whatever it did
  to the commits. A reword or a squash with the same patch carries. A fix folded into a commit with
  `--amend`, or with `--fixup` and `--autosquash`, counts only the lines its fold changed in the
  pull request, so a reviewed fix commit squashed into its target moves no line, and a line added
  and removed again nets to nothing.
- **A resolved conflict is read from merges.** Each two-parent merge that is new at the head is
  repeated with `git merge-tree`, and a conflicted path counts when the pull request changes it.
  A two-parent merge that git resolved with `-X ours` is still a conflict. A merge of more than
  two parents is a conflict even when its tree equals the first parent. Git records no conflict
  for a rebase. A conflict resolved in a rebase changes the patch, and the rewritten share counts
  it.
- **"The delta adds" counts changed lines the earlier patch does not hold.** A line that left the
  patch is reported and adds nothing.
- **The caller supplies three inputs, and a missing one is reported.** The class, the intent file
  and the acceptance criteria come from flags, and their earlier values come from the scope record
  of the last reviewed round. A trigger with a missing side is listed as `unevaluated` and does
  not fire. While the ledger holds a reviewed round, `--previous` is required. An input the earlier
  record holds must be given again, `review_surface_changed` included, so a trigger evaluated once
  is never dropped without a refusal.
- **Before round 1 of a scope nothing is compared.** The outcome is `full`.
- **Several triggers at once open one scope.** The record lists them all, and the ledger line
  names the first in the order of the schema.
- **A trigger with no scope left is the outcome `hold`.** The command appends nothing: the caller
  records a `scope-open` line or a `carry` line from the record's `event`.
- **The size guard of the plan is not here.** A later change reads the changed-line count this
  record prints.

## Alternatives rejected

- **Keep same-head unanimity and add a round cap.** Rejected. A cap with no rule for the open rows
  moves the decision to whoever is present at the cap.
- **Let a model decide closure from the ledger.** Rejected. The plan's evidence is that two runs of
  a model give different answers on the same head. A pure function does not.
- **Edit a row in place.** Rejected. An interrupted write could then lose more than one line, and
  two readers could reach different states.

## Consequences and limits

- The ledger is single-writer evidence that a gate holds. The engine does not check who appended a
  line, and a record of any of the three commands grants no authority. `ak review decide` trusts
  those lines as coverage, so the ledger file must sit outside author write. A hand-written carry
  line is coverage if it is in the file. There is no provenance check on a line.
- The tool runs no reproduction. The caller runs it and records the exit status at the head and at
  the merge base.
- The symbol rule reads no grammar. A language with no column-one declarations anchors a finding
  to the file's first lines, and its fingerprint then changes only with the cause key.
- This record lands with the ledger, the engine, the scope command and the policy data. No
  skill, protocol or gate calls them yet, so no review changes. The protocol wiring is a later
  change.
- `ak review scope` needs git 2.38 or later for `git merge-tree`. Repeating a merge writes its
  objects into the object store as unreachable objects. No work tree, index or ref changes.
- The scope command refuses a `--record` whose `head` is not `--head`. A later `ledger add` of a
  carry needs that last reviewed record as `--previous`. `readDelta` refuses a `--base` that the
  last reviewed head is a strict ancestor of, so a commit sitting between the reviewed head and a
  later empty head cannot empty the delta. Carry also requires that every non-merge commit in
  `previous..head` excluding `base` is empty or matches a reviewed own-commit patch or the
  reviewed pull request patch. An octopus
  merge is a large-rebase even when its tree equals the first parent. The base branch, like the
  ledger, must sit outside author write.
- The mutation check in `tests/review/mutation.test.ts` breaks each rule once and expects a red
  test. A rule added to the engine needs a mutant there.
