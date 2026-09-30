---
name: ultraqa
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:ultraqa`, or under a
  validated grant. On any other request do not load or follow it; tell the human to type that
  command. Adversarial behavioral verification: run the built thing as a hostile user would and
  record what breaks. Separate from diff review and after it, never instead of it. At most five
  cycles, stopping at three occurrences of the same failure. Any mutation it makes invalidates the
  affected review evidence and says so.
license: MIT
metadata:
  ak_catalog_id: ultraqa
---

## When to use

Use when the diff is clean — reviewed, with receipts bound to the head — and the open question is
whether the behavior survives hostile input, bad ordering, partial failure and unexpected state.

Use when a defect class keeps reaching users that diff review cannot see: something that is correct
line by line and wrong when run.

Use when a bounded, adversarial pass over a running system is wanted before a change is shipped, with
its findings bound to the revision it actually exercised.

## Not for

Not for reviewing the diff. Reading the change and judging it is the review lane's work. This skill
runs the system; it does not form an opinion about how the code is written.

Not for use instead of review. It runs after the diff is clean, not as a substitute for the pass that
made it clean. QA cycles that mutate code behind the reviewer's back create a fourth, unofficial
loop.

Not for an open-ended hunt. Five cycles is the ceiling, and a failure seen three times is a signal
about the approach rather than an invitation to a sixth attempt.

Not for a fix that outruns its cycle. A cycle may repair what it found and re-run, but each repair
is a mutation that invalidates the review evidence bound to the state before it, and an unbounded
repair sequence dressed as a QA pass is what the cycle cap forbids.

Not for closing its own findings. A finding closes on independent verification evidence bound to the
revision under review plus a policy rule that says that evidence suffices — never on this run's
confidence that it probably fixed it (ruling `closure-requires-independent-verification`).

## Authority

One entrypoint, `cycle`, running the declared phase operation `qa.cycle` under a grant covering
`build-go`. A human starts it by typing `/ak:ultraqa`; a controller may start it in the verifying
state of a delegated run. A request in prose is not a start, even when it names this skill or the
command.

Where the host cannot validate the grant, the entrypoint stops for explicit invocation rather than
reproducing the delegated effect through a side door (ruling `entrypoint-phase-operation-split`).
Authority narrows on delegation and never broadens.

## Inputs

The revision under test, identified, and a runnable build of it. Without a build that runs, there is
nothing to verify and the run stops.

The behavioral contract the system claims to meet: requirements, acceptance criteria, or the
documented behavior the change asserts.

The review verdict and receipts already bound to this revision, so the run knows which evidence its
own mutations would invalidate.

The cycle budget the runner supplies, and the failure ledger from any earlier cycle in this run.

## Workflow

1. Check how this run was started, before any other step and before any tool call. It is started
   only when the human's message begins with `/ak:ultraqa`, or when a controller started the phase
   operation `qa.cycle` under a validated grant. A request in prose is not a start, even when it
   names this skill or the command. With neither, stop here: make no tool call, say that this
   command is human-started, and give the human the line to type, `/ak:ultraqa` and their request.
2. Confirm the diff is clean for this revision — a review verdict and receipts that bind to it.
   Absent, stop with `needs-input`; do not run as a substitute for the review.
3. Record the revision under test and the hash of the workspace as found. Every finding this run
   emits names that revision.
4. Derive adversarial cases from the behavioral contract across the eight hostile classes in
   `./references/adversarial-cases.md`: malformed input, repeated interruption, injected
   instructions, cancel-and-resume with stale state, a dirty worktree, hung or long-running commands,
   flaky tests, and misleading success output.
5. Run one cycle: establish the baseline, exercise the cases against the running system, capture
   what actually happened, and record each failure with the invocation that produced it and the
   observed behavior. A pass needs the baseline, the adversarial cases, the evidence and the cleanup
   all to pass, not the last of them alone.
6. Classify a harness setup failure as harness debris rather than a product defect: repair the
   harness and re-run the case before any defect is recorded against the system.
7. Fingerprint each failure by cause and symptom rather than by the line it surfaced on, so the same
   defect seen twice is recognised as one.
8. Consult the failure ledger. A fingerprint on its third occurrence stops the run: three
   occurrences is evidence the approach is wrong, not that the last attempt missed a detail.
9. Where the cycle mutated the workspace — to isolate a failure or to repair one — record the
   mutation and mark the review evidence it affects as invalidated. The approvals bound to the
   previous state do not carry forward to the mutated one.
10. Clean up and roll back the cycle's scaffolding before the next one, leaving unrelated dirty work
    untouched, so the next cycle starts from a state it can describe.
11. Decide whether to run another cycle. New information from the last cycle justifies one; a repeat
    of what is already in the ledger does not. Five cycles is the ceiling.
12. At the cap, or when a cycle produces no new information, stop and emit the failure ledger, the
    cycle record, the mutation record, the residual risks and the evidence-invalidation notice.
13. Hand each remaining failure to the lane that owns the fix. At most two fix-and-verify cycles
    follow; the third stops with an explicit blocked-or-replan decision and the open failures
    attached (ruling `two-fix-cycles-then-stop`).

## Hard gates

Gate: at most five cycles in one run. The cap is a ceiling, not a target, and a cycle that would
repeat what the ledger already holds is not run.

Gate: a fingerprint reaching three occurrences stops the run. Repeated failure is a signal about the
approach, and the run reports it rather than attempting a fourth pass at it.

Gate: every mutation of the workspace is recorded, and the review evidence it affects is marked
invalidated in the same record. Evidence bound to the pre-mutation state is never presented as
covering the post-mutation state.

Gate: this run does not close its own findings. Closure needs independent verification evidence bound
to the revision plus a policy rule saying that evidence is sufficient (ruling
`closure-requires-independent-verification`).

Gate: findings bind to the revision actually exercised. A failure observed against one build is never
reported against another, and a build that could not be produced yields no findings at all.

Gate: at most two fix-and-verify cycles follow the failures this run reports; the third stops with an
explicit blocked-or-replan decision (ruling `two-fix-cycles-then-stop`). The five QA cycles and the
two fix cycles are separate caps, and neither is spent to extend the other.

Gate: the run does not weaken the system to make a case pass — no disabled assertion, no relaxed
timeout, no removed guard — and a case that cannot be run is reported as not run rather than as
passing. A single green run after a red one is not a pass for a flaky case.

Gate: the safety boundary holds while the cases are hostile. No destructive command, no secret
exfiltration or credential dump, no write to a production system, no unbounded process spawning and
no unbounded wait. Unrelated dirty work in the tree is preserved rather than cleaned up.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The review has not finished, but QA will catch whatever it would have." | QA runs the system and review reads the change; they see different defects, and running one in place of the other silently drops a whole class. | Wait for the verdict and the receipts, then run against the revision they bind to. |
| "That same timeout failed twice; a third look will pin it down." | A third occurrence of one fingerprint is the cap, and the information it would add is that the approach is wrong, which the ledger already says. | Stop, report the fingerprint with all three observations, and hand it to a replan rather than a fourth cycle. |
| "I changed one line to isolate the bug, so the earlier approval still stands." | The approval was bound to the state before the change, and carrying it forward presents evidence about one revision as evidence about another. | Record the mutation, mark the affected approvals invalidated, and say which findings now need re-verification. |
| "Cycle five found nothing new, so one more cycle is nearly free." | The cap is the ceiling, and the cycle that finds nothing new is the signal to stop rather than the argument for continuing. | Stop at the cap or at the first cycle with no new information, and emit the ledger. |
| "This case fails because the timeout is too aggressive; raising it makes it pass." | Raising the timeout changes what the system promises, and the pass that follows proves the weaker promise while reading like the original. | Report the failure with the timing observed, and leave any decision to change the promise to the lane that owns it. |
| "The build would not start, so there is nothing to report." | A build that will not run is itself the most severe finding available, and reporting silence hides it. | Report the build failure as the outcome, name what could not be exercised, and emit no findings about behavior that was never run. |
| "I verified the fix myself, so the finding is closed." | Closure needs independent verification evidence bound to the revision plus the policy that says it suffices; this run's confidence is neither. | Report the failure as still open with what would close it, and let the verification lane produce the evidence. |
| "The case is flaky, so it is not a real failure." | Non-determinism under adversarial conditions is a behavioral property, and calling it flaky discards the observation that the system is not deterministic. | Record the failure with its observed frequency and the conditions, and report the non-determinism as the finding. |

## Outputs

The failure ledger: each failure with its fingerprint, the invocation that produced it, the observed
behavior, the expected behavior from the contract, the cycle it appeared in and its occurrence count.

The cycle record: how many cycles ran, what each added, and why the run stopped — cap, repeated
fingerprint, or no new information.

The mutation record: every workspace change this run made, with the reason it was needed, and the
cleanup or rollback that followed it.

The residual risks: what the run could not exercise, what it exercised without a conclusive result,
and what the cap left unexplored.

The evidence-invalidation notice: which review approvals and verification receipts no longer cover
the workspace, and which findings therefore need re-verification. An empty notice is stated rather
than omitted.

All of it is emitted as run artifacts, bound to the revision exercised. This skill names no repository
path for project-derived content.

## Side effects

`workspace-write`, `branch-create`, `process-exec`, `artifact-write`, `scratch-write`.

No `local-commit` and no `remote-push`: this run may change the working state to isolate a failure,
and turning that into a commit or a published branch belongs to lanes holding those effects.

No `pr-comment` and no `pr-thread-resolve`. No `kb-draft` and no `kb-publish`.

## Stop conditions

`complete`: a cycle produced no new information, or the cycle cap was reached, and the ledger, the
cycle record, the mutation record and the invalidation notice are emitted.

`needs-input`: the run was started by neither the typed command nor a validated grant, the diff is
not clean for this revision, the behavioral contract is missing, or no runnable build exists.
Returns what it would need, which for the first is the command to type, and runs no cycle.

`cap-reached`: five cycles ran, or a fingerprint reached three occurrences. Stops with the ledger and
the blocked-or-replan decision attached.

`failed`: the build could not be produced or the system could not be exercised. The reason is named,
no behavioral findings are emitted, and the run stays resumable.

`cancelled`: the caller withdrew mid-run. Cycles already run are reported with their ledger entries
and any mutation left in the workspace is named.

## Limits

QA cycles per run: 5 (gate). `policies/limits.yaml` `ultraqa_cycles`.

Occurrences of one fingerprint before stopping: 3 (gate). `policies/limits.yaml`
`same_failure_occurrences`.

Fix-and-verify cycles on the failures reported: 2 (gate). `policies/limits.yaml` `fix_cycles`.

Case count per cycle: none of its own (guidance). The runner's budget bounds the pass, and a cap the
runner did not supply is not enforced and not guessed.
