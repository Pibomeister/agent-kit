# Checkpoints, operations and the escalation shape

Loaded at Workflow step 5 of `../SKILL.md`, and again whenever a card blocks. The operations and
their grant categories are declared in `policies/invocation.yaml`; the checkpoint categories and
what each may never be used for are in `policies/authority-defaults.yaml`. This file maps one to
the other and adds nothing to either.

## Phase to operation

| Phase | Operation | Checkpoint category the grant must cover |
|---|---|---|
| Alignment | `align.run` | `align-answer` |
| Spec | `bound.run` | `spec-approval`, plus `ticket-approval` when it emits tickets |
| Ticket map | `wayfind.map` | `ticket-approval` |
| Build go | dispatch to the implementer seat through `/ak:super-build` | `build-go`, implementation tickets only |
| Full review | `review.full` | `finding-adjudication` |
| Fix loop | `review.delta` | runs inside the active review run; `delta-closure` when the charter lists it |
| Readiness | `review.readiness` | `finding-adjudication` |
| Ship | `ship.prepare` | `ship-pr`. Merge and deploy are never on it. The autonomous form also needs a runner that records gate evidence outside the worker's reach |
| Pull-request feedback | `feedback.assess` | `reply-pr-comment`, plus `resolve-pr-thread` when resolving |
| Pull-request watch | `pr.watch` | `ship-pr` |
| CI repair | `ci.repair` | `ci-repair`, within its attempt cap |
| Behavioral QA | `qa.cycle` | `build-go` |
| Lesson publication | `lesson.publish` | `lesson-publication` |

A lesson candidate is drawn through compound's capture operation, lesson.capture, which drafts and
never publishes. Publication is the separate row above.

A checkpoint category the charter does not list is not granted. It escalates.

## Cards that always escalate

These escalate whether or not the two seats agree, because they are decisions dressed as
checkpoints:

- A product fork: two approaches still alive after alignment.
- A public contract, protocol or schema that existing clients can observe.
- Authentication, tenancy, payments, secrets or personal data.
- Irreversible data work: a migration, delete, backfill or drop.
- Scope past the original request by more than a missing test or a rename.
- A critical review finding that is not a mechanical patch, or any security finding.
- A delete with no answer for why the thing exists.
- Any sensitive action with no approved `sensitive_grants` entry.
- A third fix cycle on the same finding.
- The seats disagree, a seat is unavailable, or required evidence is missing.
- A runner cap is hit.
- The work source is missing.
- The acceptance criterion is what a person experiences.

## The escalation

One message, not a diary. The fields are `schemas/common.schema.json#/$defs/escalation`:

```
NEED:     the one decision needed
OPTIONS:  two to six bounded options
TRIED:    what the pair already ruled out, with evidence refs
DEFAULT:  what happens if the human says "just pick" — one of the options
CHARTER:  the triggering rule, e.g. policy:authority-defaults/seat_separation/missing_seat or charter:sensitive_grants/merge
BLOCKED:  the ticket, finding or spec section held
```

`CHARTER` names the failure that occurred. A seat that timed out is a seat failure, not a
disagreement, and the human reading it needs to know which.

Until the human answers: no new tickets, no ship, no deletion. Scout and verify may keep running
within budget. If the cap arrives first, the run ends `cap-reached`, with any pull request left as it
is and the ledger linked from the run report the runner holds. Nothing is merged.
