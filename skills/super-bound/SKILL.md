---
name: super-bound
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:super-bound`, or
  under a validated grant, or when a supervisor's bypass grant passes the bundle's `ak-gate.mjs
  bypass check`. On any other request do not load or follow it; tell the human to type that
  command. Turns an approved direction into a decision-level specification, a reviewed plan and a
  dependency graph of zero-context implementation tickets with named verification. Use when the
  direction is agreed and the work needs bounding. Not for deciding what to build, and not for a
  reviewed ticket that already carries its acceptance criteria.
license: MIT
metadata:
  ak_catalog_id: super-bound
---

Produce the specification, plan and zero-context tickets. A decision ticket is never implementation.

## When to use

- An approved direction exists and the work needs a specification, a plan and tickets before anyone
  builds.
- A specification exists but nobody has settled the slicing, the blocking edges or which ticket owns
  which file.
- The approved direction covers several modules and no capability map has been drawn.
- A delegated controller holds a charter naming the `spec-approval` checkpoint and an approved
  alignment result binds to the current source revision.

## Not for

- Deciding what to build. An unsettled direction goes back to a human-started alignment run; this
  skill starts from an approved result and does not reopen it.
- A reviewed ticket that already carries its acceptance criteria and verification command. That
  work enters at build, and re-bounding it re-decides what a reviewer already accepted.
- Charting a multi-session effort into decision tickets and fog. That is `wayfind`.
- Reviewing the specification for coherence or decision readiness. This skill calls `/ak:doc-review`
  for that rather than grading its own artifact.
- A single mechanical rename with one call site and one test.

## Authority

Authority: `explicit` at `/ak:super-bound`; prose is not a start. `bound.run` has
`delegated-grant` authority and requires runner-validated `spec-approval`, plus `ticket-approval`
when it emits implementation tickets (`adapters/runner-contract/CONTRACT.md`). A host that cannot
validate the grant stops for explicit invocation (ruling `entrypoint-phase-operation-split`). No
skill starts this one directly; its model-invoked child is `doc-review`.

Under a bypass grant (ADR-0008), a supervisor-held file stands in for the typed command for one
task. From the task's worktree, run `node <this skill's directory>/../../bin/ak-gate.mjs bypass check --grant <path> --task <id>
--phase super-bound`: exit 0 is the start, and a refusal is a stop with
`needs-decision`. The grant starts the phase and nothing else. The specification approval at step 7
and every ticket approval still come from the supervisor through `needs-decision`; the worker never
approves its own specification or tickets.

## Inputs

- An approved alignment result bound to the current source revision. Missing or stale:
  `needs-input`; approval against other code does not transfer.
- Recorded project context, read through the knowledgebase adapter's `readContext`: the `prd` in
  scope, settled `adr` pages and glossary. Empty is a fact; unreachable is `failed`.
- A project record (`schemas/project.schema.json`) with change, test and delegation guidance.
  Missing delegation guidance is `needs-input`; scorer inputs are never invented.
- At `bound.run` only: a `charter` (`schemas/charter.schema.json`) listing `spec-approval`, and
  `ticket-approval` where tickets will be emitted. Absent: `needs-input`.

## Workflow

1. Before any tool call, require `/ak:super-bound`, a validated grant for `bound.run`, or the
   bypass check in Authority exiting 0. Otherwise stop, make no tool call, identify this as
   human-started and return `/ak:super-bound <request>`.
2. Detect before asking: read the dependency manifest, test runner, lint and CI configuration;
   report the result in two lines and ask only what remains.
3. For a multi-module direction, draw a reviewed capability map of stable kebab-case module ids,
   responsibilities and dependencies before writing any module specification.
4. Write the specification at decision level: problem, solution, non-goals, acceptance criteria,
   test seams, verification commands, out of scope. No file paths and no code, except a fragment a
   prototype already settled exactly — a state machine, a reducer, a schema, a type shape.
5. Choose test seams before slices; name why the chosen, preferably single seam is the highest
   available. Use the alignment vocabulary with
   [the domain-modeling reference pack](../../references/domain-modeling/REFERENCE.md) rather than
   renaming the same things here.
6. Run `/ak:doc-review` on the specification and resolve everything it returns before cutting a
   ticket.
7. Take the specification approval. The plan record carries it as `specification_approval`, bound
   to the specification's own hash (`specification_hash`), so slicing afterwards does not void it.
   Under a bypass grant, report `needs-decision` naming the specification hash and stop; only the
   supervisor's answer is the approval.
8. Load [the delegation reference pack](../../references/delegation/REFERENCE.md) and follow its
   ordered stack, readiness, assumptions and advisor procedures for every zero-context slice.
9. Run `ak delegation <ticket> --project <project-record>` after populating its floor and evidenced
   factors; persist its complete JSON with `readiness` and `assumptions` before returning, including
   on `needs-input`. Never derive the class in this body.
10. Give every ticket exact consumed and produced interfaces. Write for a skilled implementer with
    no context about this toolset or domain.
11. Declare blocking edges, exclusive file ownership, shared generated artifacts and migration
    numbering. Overlapping writers serialize even without a dependency edge.
12. Type-check every ticket. An implementer opening it with an empty context window who still
    cannot do it is not holding an implementation ticket: reshape it, or reclassify it
    `type: decision` and send it back.
13. Self-review, then publish: every acceptance criterion is covered by a ticket, no ticket carries
    an unfinished-content marker or a "same as the earlier ticket" instruction, and each ticket's
    produced names and types match the next one's consumed names exactly. Under a bypass grant,
    report `needs-decision` listing the tickets and their hashes and stop before publishing; only
    the supervisor's answer approves them.

## Hard gates

Gate: a decision ticket is never emitted as executable work. A ticket that fails the zero-context
check is reclassified, never shipped as an implementation ticket because the deadline is close.

Gate: every ticket carries exact scorer output, all six named `readiness` criteria plus
`vague_terms`, and `assumptions` items using `text` and `resolved_as`. Vagueness, an open assumption
or scorer failure stops it; no total, hand-derived class or request to delegate substitutes (ruling
`delegation-class-is-authority-not-finding`). No factor or lowering crosses the sensitive floor
(ruling `sensitive-surface-sets-the-floor`).

Gate: a direction spanning independently deployable stack phases is split in the reference's order,
with schema contract separate. Refusal to split emits a decision ticket; size alone is guidance.

Gate: on a supporting host, a ticket whose class requires consultation is not approved until its
`kb_refs` cites the consultation artifact as the delegation reference defines; an unsupported host
cites none (ruling `advisor-consultation-follows-class`).

Gate: approval binds to the specification's hash, not the whole plan's. A changed specification
does not inherit the old approval; take it again.

Gate: no ticket ships with an unfinished-content marker, with "add appropriate error handling" or
"handle the edge cases" in place of the specifics, or with a pointer to another ticket in place of
the work.

Gate: evidence that invalidates a decision settled earlier in this session stops the write. Return a
blocked-or-replan result naming the settled decision and the new evidence; never resolve it
silently.

Gate: the consensus plan gate is entered only on genuine architectural disagreement, declared high
risk, or a review-driven replan — never automatically on a routine breakdown. It is a protocol this
skill enters, not a skill it starts:
[the consensus plan gate protocol](../../protocols/consensus-plan-gate/PROTOCOL.md).

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The ticket is obvious to me, so it is written clearly enough." | The implementer knows almost nothing about this toolset or problem domain. "Obvious to the author" names exactly the context the ticket fails to carry. | Write the consumed and produced signatures and the verification command, then reread the ticket as someone who has seen nothing else. |
| "This ticket is basically the earlier one — I'll say 'similar to' and save the repetition." | A pointer to another ticket is context the implementer's window does not contain. | Repeat the specifics in full in this ticket. |
| "I'll put the file paths in the specification so nobody has to guess." | A path in the specification settles an implementation decision the specification has not made, and the first refactor makes it wrong while it still reads authoritative. | Keep the specification at decision level; paths belong in the ticket, and only where a prototype settled them. |
| "New evidence contradicts what we settled an hour ago — I'll just take the better answer." | A decision settled earlier in the session is not the planner's to overturn quietly; the human who settled it is not in the write. | Stop the write and return a blocked-or-replan result naming the settled decision and the evidence against it. |
| "Their guidance is about a hundred lines a change, so this has to become three tickets." | Change size is a configurable starting point, not a gate, and neither it nor the test split is grounds for a finding on its own (ruling `numeric-heuristics-are-guidance`). | Slice on verifiable behavior. Where the natural slice exceeds the project's own guidance, record the exception in the project record. |
| "They insist on one ticket for the whole migration, so I'll keep it together." | Refactor, expand, flagged behavior, consumer, backfill and contract are independently deployable delivery boundaries; a request cannot collapse them. | Order the stack with contract separate, or emit a decision ticket naming the refusal when the zero-context gate cannot pass. |

## Outputs

- `prd` page — the requirements when they are newly stated, published through the knowledgebase
  adapter's `publishArtifact` under a `kb-document` placement naming kind `prd` and the scope. The
  knowledgebase resolves the location and this skill supplies no path (ruling
  `central-kb-owns-project-artifacts`).
- Plan record, a run artifact with envelope schema `plan-record`
  (`schemas/plan-record.schema.json`) — the specification, the seams, the slicing and the dependency
  graph, published under a `run-artifact` placement and linked from the `prd`.
- `ticket` (`schemas/ticket.schema.json`), `type: implementation`, id `bound-<spec>-<slice>` — one
  per slice, with interfaces, ownership, edges, criteria, verification, `readiness`, resolved
  `assumptions` and the exact ticket-time `delegation` output.
- `ticket`, `type: decision` — emitted for an open fork, with the three evidence blocks persisted in
  place of the implementation ticket that could not be written.
- At `bound.run`: the same artifacts as drafts. That operation drafts to the knowledgebase and does
  not publish.

## Side effects

`artifact-write`, `scratch-write`, `kb-draft`, `kb-publish`. No `workspace-write`: this skill plans
the change and never makes it.

`kb-publish` is a remote side effect. Its idempotency key derives from the run, the operation, the
knowledgebase record identity and the published artifact's hash; the read-back is the record ref and
stored hash `publishArtifact` returns, read before the write and confirmed after it
(`adapters/runner-contract/CONTRACT.md`, "Idempotency"). A publication whose read-back cannot be
performed is `failed`, never complete.

## Stop conditions

- `complete` — the specification is approved at its hash, every acceptance criterion is covered by a
  ticket, every implementation ticket carries the three evidence blocks, and every published
  artifact's read-back matched what was sent.
- `needs-input` — a start by neither the typed command nor a validated grant, which returns the
  command to type and nothing else; no approved alignment result, an approval bound to a different
  revision, missing project guidance or grant at `bound.run`, a failed scorer, an unresolved
  assumption or vague criterion, or a settled decision that new evidence invalidated.
  When assessment ran, the returned draft retains `delegation`, `readiness` and `assumptions`.
- `cap-reached` — the consensus plan gate reached its round cap, or the runner-supplied ticket
  budget ran out. Returns the unresolved architectural question or the undecomposed remainder.
- `cancelled` — the human ended the run before approving the specification.
- `failed` — the knowledgebase is unreachable, or a publication's read-back cannot be performed.

## Limits

- Consensus plan-gate rounds: 5 (gate, `policies/limits.yaml`).
- Implementation tickets started per run: the runner-supplied `ticket-budget` (gate when supplied).
  A cap the runner did not supply is not enforced and not guessed; the run records that it was
  absent.
- Test seams a feature is verified across: as few as the feature allows, ideally one (guidance).
- Change size: roughly one hundred lines where that is natural, and test shape: roughly 80 / 15 / 5
  across unit, integration and end-to-end tests. Both are configurable starting points carried in
  the project record, neither is enforced here, and neither is grounds for a finding on its own
  (ruling `numeric-heuristics-are-guidance`).
