---
name: super-verify
description: "Turns a completion claim into receipts: for each acceptance criterion, the command or probe that would prove it, run fresh, with exit status, output digest, revision and environment identity recorded. Use when a specific implemented behaviour has to be shown to work. Not for judging whether code is well written, not for fixing what fails, and not for ratifying an account of a green run."
license: MIT
metadata:
  ak_catalog_id: super-verify
  ak:
    mode: autonomous
    autonomy_unenforceable:
      - "artifact-write is storage only: the host does not compute or check the artifact hash, so envelope hash binding is this package's own work."
      - kb-write is not provided by the host; the knowledgebase adapter supplies it and refuses rather than falling back to a repository path when no knowledgebase is configured, which is why it does not cap this row while that adapter is attached (ruling `fail-closed-adapter-lifts-ceiling`).
      - environment identity is not attested by the host. This package records what it observed of the environment and never reports an identity it could not read.
---

## When to use

Use when a caller claims a specific behaviour works and the claim can be named as an acceptance
criterion: the export includes archived rows; a 400 is no longer retried; the migration runs twice
without changing the second result.

Use when a ticket's acceptance criteria need evidence before the work can be reported done, and the
evidence has to be re-checkable by someone who was not in the run.

Use when the code has moved since the last receipts were taken and a claim that was true of the old
revision has to be established again for the new one.

Use when a repair has landed and what follows it is new verification rather than a re-reading of the
receipts taken before it.

## Not for

Not for an opinion about whether code is well written, well factored or well named. That is a review
lane's judgement, and this skill has no instrument for it: a passing command says the behaviour
holds, not that the code deserves to.

Not for producing the fix when a check fails. A failing check is a reproduction, and a reproduction
enters through `diagnose`, which states its hypothesis before any edit and emits either a verified
bounded patch under a grant or a work packet — never a patch this lane wrote on the way past (ruling
`diagnose-patch-or-packet-never-both`).

Not for verifying a claim nobody stated. "Check that everything still works" names no criterion, so
nothing would settle it and any result would be an impression.

Not for ratifying someone's account of a run. A description of a green test suite is the thing a
receipt exists to replace, and re-reporting it with this skill's name on it launders an assertion
into evidence.

## Authority

Authority: `model`. A controller or a parent skill starts it when a claim needs evidence; no slash
command exposes it and no human act is required to start it.

No grant covers delegation, because no phase operation exposes this skill
(`policies/invocation.yaml`). Who starts the run also does not change what it may conclude: the
implementer of the change may invoke it, and the receipts still close what they close, because
closure is a property of the evidence and of a policy rule saying that evidence suffices, never of
the caller's confidence in the work (ruling `closure-requires-independent-verification`).

## Inputs

The claim, resolved to named acceptance criteria (`schemas/ticket.schema.json` `acceptance_criteria`,
by AC id). Absent, or phrased so that no command could settle it: stop and report `needs-input` with
the criterion it would need.

The repository at the revision being verified, readable (`repository-read`). Unreadable, or no
revision named: stop and report `failed`. A receipt whose revision is null is not a receipt.

The project's own test, build and check commands, discovered rather than assumed. A command guessed
from the ecosystem's convention verifies whatever that command happens to do, which is not the same
claim.

The environment the checks run in, identified (`schemas/verification.schema.json`). Test execution
belongs in the appropriate isolated environment, and repository test code does not receive production
credentials by default.

Optionally, receipts from an earlier run. They are history: a receipt is evidence for the revision it
names and for no other, and one taken before the code moved is read as invalidated rather than as a
head start. The code moved when either the revision or the working-tree diff hash differs from the
receipt's (`common#/$defs/revision_ref`); an uncommitted edit on the same revision is a move.

## Workflow

1. Resolve the claim into the acceptance criteria it is made of, by id. A claim that resolves to no
   criterion stops here with `needs-input`.
2. Discover the project's own commands — the test runner, the build, the type check, the wrapper the
   repository actually uses — before deciding what to run.
3. For each criterion, identify the command or probe that would prove it. Where no realistic check
   exists, say so on the criterion rather than leaving it out: the outcome is recorded with its
   reason, not dropped from the matrix.
4. Run each command fresh and complete, at the revision under verification. A partial run, a cached
   result and a previous run's output are not this run's evidence.
5. Read the whole output: exit status first, then the counts the output reports. A suite that reports
   failures while exiting zero is read by its output, and the disagreement is recorded as
   `exit_disagreement` with `verdict_from: output` and an `output_reports` quote.
6. Record one receipt per check with the command as an argument vector or the probe with its target,
   the exit status, the digest of the relevant output, the revision, the environment identity, and
   the criteria it supports. For an opened run the receipt also names the ticket verification id it
   executed as `check`, lists the output log under `artifacts` with that digest, and carries the
   ticket ref `{id, hash}` whose hash is `artifactHash` of the ticket (`common#/$defs/hash`: sha256
   over its canonical JSON without `approvals`), the value `open` wrote as the ticket's hash in the
   run record.
7. Set the outcome of each check to what happened: it ran and confirmed, it ran and refuted, it did
   not run, it does not apply to this change, or it ran and settled nothing. Each outcome that is not
   a pass carries a reason.
8. Assemble the matrix: every criterion on one axis, every receipt on the other, and no criterion
   left without a cell.
9. Invalidate, rather than rewrite, any earlier receipt this run supersedes — record what changed and
   when. The old receipt stays readable; what changes is whether it still describes the current state.
10. Claim exactly what the receipts support, and publish the matrix and the receipts through the
    knowledgebase adapter's `publishArtifact` operation with a run-artifact placement. Return the
    verdict per criterion, not a summary sentence over them.
11. When every criterion is confirmed, record the gate with every receipt file recorded at this
    head: `node <this skill's directory>/../../bin/ak-gate.mjs record --gate verify --receipt <file>`
    (repeat `--receipt` for each receipt). The bundle's gate copies each receipt and its digested
    output into the run store and writes references in the v2 phase record; it does not turn those
    references into a verdict. It skips, with a note, a receipt bound to another revision and
    refuses one whose output log it cannot find, and the pre-ship check refuses one whose ticket ref
    is not the run record's `artifactHash` value from step 6. Re-recording a corrected receipt under
    the same id replaces the earlier one at this head, except a failed receipt, which stays.
    The record names this revision and diff hash, so any later edit makes it stale and super-ship
    sends you back here.
    Run it from the project checkout; the run defaults to the branch's opened-run pointer (or the
    branch-named v1 run when none was opened) and records default to the repository's git directory.
    A binding's brief supplies `--run` and `--dir` when it has them. A run that was never opened,
    whether branch-named or supplied by a binding, has no task record, so retain its compatible
    marker-only call without `--receipt`; it is history, not proof. A record on a run that
    `ship-preflight` has closed is refused; the task needs a new `open`.

## Hard gates

Gate: no completion claim without fresh evidence for the revision claimed. An agent's description of
a green run is not a receipt — a receipt carries the command or probe, exit status, output digest,
revision and environment identity — and a patch that changed after a receipt was taken does not
inherit it (ruling `closure-requires-independent-verification`).

Gate: a classifier, a confidence score and a reviewer's judgement are advisory and are recorded as
such. None of them turns missing proof into a pass, and a criterion with no check is reported as
having none.

Gate: a check is never skipped, an assertion never weakened, a threshold never lowered and coverage
never removed in order to obtain a passing receipt. Each of those is a separate decision, recorded on
the receipt that follows it, and a required product-code change is not a repair this lane absorbs:
what returns from it is a bounded patch with new verification, not the old receipt read again (ruling
`ci-repair-restricts-purpose-not-permission`).

Gate: a receipt names the head it verified, and that head is never conflated with a review run's
comparison base or its reviewed head. Where architecture, requirements, the comparison base or the
affected surface has changed materially, the affected receipts are invalidated and a new baseline is
deliberately established — a new scope with its own first pass, not another delta loop (ruling
`delta-baseline-reset-not-third-loop`).

Gate: an outcome that is not a pass is recorded with its reason and never omitted. A criterion
missing from the matrix reads as covered to everyone downstream, which is the one thing a missing
result must never do.

Gate: the run reports what it found. A run whose every check failed has completed, and reporting that
is the result; a run that reports nothing because the news was bad has failed at the only job it has.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The caller already ran the tests and says they pass — re-running them wastes a few minutes." | A description of a green run is the assertion a receipt exists to replace (ruling `closure-requires-independent-verification`), and the caller's run was at a revision this one cannot name. | Identify the command, run it fresh at the revision under verification, and record exit status, digest, revision and environment. |
| "The last receipt was green and the change since then only touched a comment." | Whether the change was material is exactly what the receipt cannot tell you, and "only a comment" is a judgement made by the party who wants to skip the run. | Treat the moved revision as invalidating, re-run, and record the invalidation against the old receipt rather than deleting it. |
| "The suite exits zero, so it passed, even though the summary line lists two failures." | The exit status and the output disagree, and reading only the convenient half is how a green result is manufactured from a red run. | Record both, set the outcome from what the output shows, and add `exit_disagreement` with the output's failure report. |
| "There is no sensible way to check this one, so I will leave it out of the matrix." | A criterion absent from the matrix is indistinguishable from a criterion that passed, and the reader has no way to learn otherwise. | Record it as not applicable or inconclusive with the reason, so the gap is visible where the evidence would have been. |
| "This test is flaky — re-running until it goes green is how everyone handles it." | A pass selected from repeated attempts is a statement about the sampling, not about the behaviour, and the failing runs are the evidence being discarded. | Record every run as its own receipt, report the instability as the finding it is, and route the flake to diagnosis rather than to a retry. |
| "The check only fails because the assertion is too strict; loosening it is the obvious fix." | Changing what a check asserts changes the claim, and a receipt taken afterwards proves the weaker claim while reading as though it proved the original (ruling `ci-repair-restricts-purpose-not-permission`). | Leave the assertion alone, report the failure, and let the separate decision that would weaken it be taken and recorded where decisions are. |

## Outputs

One receipt per check (`schemas/verification.schema.json`), each naming the criteria it supports and
bound to the revision it describes. A receipt that supports nothing is not part of the matrix and is
not evidence for anything.

The acceptance-to-evidence matrix: every acceptance criterion with its outcome and the receipt that
produced it, including the criteria that were not run, do not apply, or settled nothing. The shape is
a matrix because the missing cell is the point.

Invalidation records against receipts this run supersedes, naming what changed. Nothing is rewritten
in place.

All of it is published through the knowledgebase adapter's `publishArtifact` operation with a
run-artifact placement (`adapters/knowledgebase/CONTRACT.md`). This skill names no repository path
for project-derived content.

## Side effects

`process-exec`, `scratch-write`, `artifact-write`, `kb-publish`.

`kb-publish` is a remote effect: the idempotency key is derived from the content hash of the receipt
set per `adapters/runner-contract/CONTRACT.md` §5, and the returned record reference is read back
before the run reports. Republishing an unchanged set after an interruption is a no-op success rather
than a second record.

No `workspace-write`, no `local-commit`: verification does not change what it is verifying. Whatever
a check writes lives in scratch and is cleaned up, and a check that can only pass by editing the tree
is reported, not accommodated.

## Stop conditions

`complete`: every acceptance criterion has an outcome and a reason where that outcome is not a pass,
and the receipts are published. A run whose checks all failed is complete; the failures are the
result.

`needs-input`: the claim resolves to no acceptance criterion, or no revision was named. Returns the
criterion or the revision it would need, and no partial matrix presented as a verdict.

`failed`: the repository is unreadable at the named revision, the environment cannot be identified,
or the knowledgebase refuses the write. The receipts are returned unpublished with the refusal rather
than written to a path in the repository.

`cancelled`: the caller withdrew the claim mid-run. Receipts already taken are kept and published as
what they are — evidence about the checks that ran — because a completed check is a fact whether or
not anyone still wants it.

## Limits

This skill declares no numeric cap of its own. The runner's elapsed-time budget is the only bound it
enforces, and a budget the runner did not supply is not enforced and not guessed
(`policies/limits.yaml`).

Receipts per criterion: at least one, always (gate). A criterion may carry several, and none of them
replaces another.

Re-runs: every run is its own receipt (gate). A second run does not overwrite the first, and a pass
selected out of repeated attempts is reported as instability rather than as a pass.

Commands: the project's own, discovered (gate). This skill runs no command it chose by convention
rather than by discovery, and a project with no discoverable check for a criterion produces a
recorded outcome, not an invented command.
