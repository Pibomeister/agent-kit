---
name: super-bound
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:super-bound`, or
  under a validated grant. On any other request do not load or follow it; tell the human to type
  that command. Turns an approved direction into a decision-level specification, a reviewed plan and
  a dependency graph of zero-context implementation tickets with named verification. Use when the
  direction is agreed and the work needs bounding. Not for deciding what to build, and not for a
  reviewed ticket that already carries its acceptance criteria.
license: MIT
metadata:
  ak_catalog_id: super-bound
---

Requirements and specification, implementation plan, dependency graph, ownership boundaries,
acceptance criteria and verification commands. A decision ticket is never an implementation ticket.

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

Authority: `explicit` at the public entrypoint, `delegated-grant` at the phase operation
`bound.run`. A human starts the public entrypoint by typing `/ak:super-bound`. A request in prose
is not a start, even when it names this skill or the command. A delegated controller starts
`bound.run` only under a runner-validated grant covering `spec-approval`, and only with a second
grant covering `ticket-approval` when the operation emits implementation tickets
(`adapters/runner-contract/CONTRACT.md`). Where the host cannot validate a grant, the operation
stops for explicit invocation rather than approving on the controller's word (ruling
`entrypoint-phase-operation-split`). No skill starts this skill directly; it calls `doc-review`,
which is model-invoked, and that direction is the legal one.

Under a bypass grant (ADR-0008), a supervisor-held file stands in for the typed command for one
task. Run `node <this skill's directory>/../../bin/ak-gate.mjs bypass check --grant <path> --task <id>
--phase super-bound` (or `ak lifecycle bypass check`): exit 0 is the start, and a refusal is a stop with
`needs-decision`. The grant starts the phase and nothing else. The specification approval at step 7
and every ticket approval still come from the supervisor through `needs-decision`; the worker never
approves its own specification or tickets.

## Inputs

- An approved alignment result that binds to the current source revision. Absent, or bound to a
  different revision: return `needs-input`. A direction approved against other code is not an
  approval of this one.
- Recorded project context, read through the knowledgebase adapter's `readContext`: the `prd` in
  scope, the settled `adr` pages, and the glossary the vocabulary was agreed in. An empty result is
  a fact; an unreachable knowledgebase returns `failed`.
- The project record's configured guidance (`schemas/project.schema.json`) for change size and test
  shape. Absent: the starting points below are advisory and nothing enforces them.
- At `bound.run` only: a `charter` (`schemas/charter.schema.json`) listing `spec-approval`, and
  `ticket-approval` where tickets will be emitted. Absent: `needs-input`.

## Workflow

1. Check how this run was started, before any other step and before any tool call. It is started
   only when the human's message begins with `/ak:super-bound`, when a controller started the phase
   operation `bound.run` under a validated grant, or when the bypass check in Authority exits 0. A
   request in prose is not a start, even when it names this skill or the command. With neither, stop
   here: make no tool call, say that this command is human-started, and give the human the line to
   type, `/ak:super-bound` and their request.
2. Detect before you ask. Read what the repository already states — its dependency manifest, its
   test runner, its lint configuration, its continuous-integration configuration — report what you
   found in two lines, and ask only what is left.
3. When the approved direction spans more than one module, draw the capability map first: a table of
   stable kebab-case module ids, each with its responsibility and what it depends on. The map is
   gated like every other step; a human reviews it before any module's specification is written.
4. Write the specification at decision level: problem, solution, non-goals, acceptance criteria,
   test seams, verification commands, out of scope. No file paths and no code, except a fragment a
   prototype already settled exactly — a state machine, a reducer, a schema, a type shape.
5. Choose the test seams before the slices. The fewer seams the feature is verified across the
   better, and the ideal number is one; name the seam you chose and why it is the highest one
   available. Use the vocabulary the alignment run already established with
   [the domain-modeling reference pack](../../references/domain-modeling/REFERENCE.md) rather than
   renaming the same things here.
6. Run `/ak:doc-review` on the specification and resolve everything it returns before cutting a
   ticket.
7. Take the specification approval. The plan record carries it as `specification_approval`, bound
   to the specification's own hash (`specification_hash`), so slicing afterwards does not void it.
   Under a bypass grant, report `needs-decision` naming the specification hash and stop; only the
   supervisor's answer is the approval.
8. Slice into tickets. Each slice cuts a narrow but complete path through every layer, is demoable
   or verifiable on its own, and is sized to fit one fresh context window.
9. Give every ticket its interfaces: what it consumes from earlier tickets with exact signatures,
   and what it produces that later tickets rely on with exact names, parameters and return types.
   Write for a skilled developer who knows almost nothing about this toolset or problem domain.
10. Declare the blocking edges, and then declare what the edges do not cover: exclusive file
    ownership per ticket, shared generated artifacts, and global migration numbering. Two tickets
    with no edge between them are still unsafe in parallel when they write the same file.
11. Where one mechanical change breaks call sites across the tree and no vertical slice can land
    green, use the wide-refactor shape instead: expand, then migrate in batches with each batch its
    own ticket blocked by the expand, then contract, blocked by every batch.
12. Type-check every ticket. An implementer opening it with an empty context window who still
    cannot do it is not holding an implementation ticket: reshape it, or reclassify it
    `type: decision` and send it back.
13. Self-review, then publish: every acceptance criterion is covered by a ticket, no ticket carries
    an unfinished-content marker or a "same as the earlier ticket" instruction, and each ticket's
    produced names and types match the next one's consumed names exactly.

## Hard gates

Gate: a decision ticket is never emitted as executable work. A ticket that fails the zero-context
check is reclassified, never shipped as an implementation ticket because the deadline is close.

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

## Outputs

- `prd` page — the requirements when they are newly stated, published through the knowledgebase
  adapter's `publishArtifact` under a `kb-document` placement naming kind `prd` and the scope. The
  knowledgebase resolves the location and this skill supplies no path (ruling
  `central-kb-owns-project-artifacts`).
- Plan record, a run artifact with envelope schema `plan-record`
  (`schemas/plan-record.schema.json`) — the specification, the seams, the slicing and the dependency
  graph, published under a `run-artifact` placement and linked from the `prd`.
- `ticket` (`schemas/ticket.schema.json`), `type: implementation`, id shape
  `bound-<spec>-<slice>` — one per slice, each with its interfaces, its owned files, its blocking
  edges, its acceptance criteria and its verification command.
- `ticket`, `type: decision` — emitted for each fork the zero-context check exposed, in place of the
  implementation ticket that could not be written.
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
  ticket, and every published artifact's read-back matched what was sent.
- `needs-input` — a start by neither the typed command nor a validated grant, which returns the
  command to type and nothing else; no approved alignment result, an approval bound to a different
  revision, a missing grant at `bound.run`, or a settled decision that new evidence invalidated.
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
