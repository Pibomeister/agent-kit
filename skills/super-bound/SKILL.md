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

Requirements, specification, plan, dependency graph, ownership, acceptance criteria and verification.
A decision ticket is never executable work.

## When to use

Use for an approved direction that still needs decision-level specification and zero-context tickets.

## Not for

Do not use to choose a direction, re-bound an approved ticket, chart a multi-session effort or handle
a mechanical rename.

## Authority

Authority is `explicit` at the public entrypoint and `delegated-grant` at `bound.run`. Start only when
the human's message begins with `/ak:super-bound`, a controller holds a runner-validated grant covering
`spec-approval` plus `ticket-approval` when tickets will be emitted, or the bypass check below exits 0.
Prose mentioning the skill is not a start. An unverifiable grant stops for explicit invocation
(ruling `entrypoint-phase-operation-split`).

For a supervisor bypass grant, run from the task worktree:
`node <skill-dir>/../../bin/ak-gate.mjs bypass check --grant <path> --task <id> --phase super-bound`.
Refusal is `needs-decision`. The grant starts the phase only; the supervisor must still approve the
specification hash and each ticket hash, and the worker never approves either.

## Inputs

Require an approved alignment result bound to the current source revision; project `prd`, settled
`adr` pages and glossary via `readContext`; delegation guidance; and, at `bound.run`, a charter covering
the required checkpoints. Missing or stale approval, delegation guidance or charter is `needs-input`.
An empty context is a fact; an unreachable knowledgebase is `failed`. Missing change-size or test-shape
guidance leaves the project-configured starting points advisory rather than enforced.

## Workflow

1. Validate the start before any other tool call. Unless the run began with `/ak:super-bound` or a
   validated grant, stop, read nothing and respond only with the command the human must type.
2. Detect before asking: inspect dependency, test, lint and continuous-integration configuration;
   report what exists in two lines and ask only what remains.
3. For work spanning modules, gate a capability map of stable kebab-case module ids, responsibilities
   and dependencies before writing a module specification.
4. Write problem, solution, non-goals, acceptance criteria, test seams, verification commands and out
   of scope at decision level. Turn each vague criterion into a frontier question that proposes how
   the answer would be verified. Include no paths or code except an exactly prototype-settled fragment.
5. Choose slices only after the fewest viable, highest test seams. Preserve established vocabulary via
   [the domain-modeling reference](../../references/domain-modeling/REFERENCE.md).
6. If given a draft or scorer input, load the delegation reference and run
   `ak delegation <ticket> --project <project-record>`. A current `ak` on `PATH` is a prerequisite;
   a missing or incompatible command is a named prerequisite, not a scoring result. Persist its
   complete output, readiness and assumptions before review; the draft is not an implementation ticket.
7. Run `/ak:doc-review`. A receipt satisfies review only when bound to this specification and every
   decision is answered. If any specification, assumption or review decision remains open, return it
   and stop; create, draft and publish no implementation ticket.
8. Record human approval as `specification_approval` bound to `specification_hash`. A changed hash needs
   new approval. Under bypass, return `needs-decision` with the hash and stop for the supervisor.
9. Load [the delegation reference](../../references/delegation/REFERENCE.md). Follow its ordered-stack,
   readiness, assumption, authorship-boundary and evidence-reference rules for every slice.
10. Populate the floor, evidenced factors and permitted class seed, run
    `ak delegation <ticket> --project <project-record>` for each ticket, and persist its complete JSON
    plus readiness and assumptions, including before `needs-input`.
11. Give each ticket exact consumed and produced interfaces, blocking edges, exclusive file ownership,
    shared generated artifacts, global numbering constraints, acceptance criteria and verification.
12. Re-read each ticket from an empty context. Reshape an incomplete ticket or reclassify it
    `type: decision`; never ask the implementer to discover an unresolved decision.
13. Before publishing, prove every criterion is covered, interfaces connect exactly and no ticket uses
    unfinished-content language or another ticket as a substitute. Under bypass, return
    `needs-decision` with ticket hashes and stop for supervisor approval.

## Hard gates

- Every ticket carries exact scorer output, all six readiness criteria plus `vague_terms`, and
  assumptions with `text` and `resolved_as`. Each criterion records what was checked and where; every
  readiness or stop state cites that evidence. A bare boolean, total or hand-derived class is invalid
  (ruling `delegation-class-is-authority-not-finding`). No factor or lowering crosses the sensitive
  floor (ruling `sensitive-surface-sets-the-floor`).
- Every ticket states what the agent may do and what it must not do. Naming a human owner alone is not
  a human-authorship boundary.
- An unresolved vague term becomes a frontier question with a proposed observable, fixture or workload,
  measurement or oracle, and pass condition as applicable. Never invent the missing target.
- Where independently deployable phases apply, record this exact ordered, reversible recommendation:
  pure refactor; additive schema expand; behavior behind a flag; consumer; backfill; schema contract.
  Schema contract is separate. Refusal adds a decision ticket after the recommendation; it never turns
  the result into a choice between the stack and an exception. Size alone remains guidance.
- Required consultation is cited in `kb_refs` by transcript or receipt id/ref plus a one-line note
  explaining the judgment evidence. A bare path, name or URL is not evidence. Unsupported hosts cite
  none (ruling `advisor-consultation-follows-class`).
- No implementation ticket exists while a specification, assumption or review decision is open. A
  decision ticket may carry the fork, but is never executable work.
- Approval binds to the specification hash. New evidence contradicting a settled decision stops the
  write with that decision and evidence named; it is never resolved silently.
- Enter [the consensus plan gate](../../protocols/consensus-plan-gate/PROTOCOL.md) only for genuine
  architectural disagreement, declared high risk or review-driven replan, never routine breakdown.
- No ticket substitutes vague error handling, unnamed edge cases, an unfinished-content marker or a
  pointer to another ticket for concrete work.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The readiness flag is enough." | A flag hides what was checked and cannot justify a stop. | Persist criterion-level evidence and cite it from the state. |
| "The owner is human, so authorship is clear." | Ownership does not say what agent work is allowed. | State what the agent may and must not do. |
| "The requester refused the stack, so I can offer an exception." | Refusal does not erase independently deployable boundaries. | Record the exact ordered recommendation, then a decision ticket for the refusal. |

## Outputs

- A `prd` page published by scope through `publishArtifact`; the knowledgebase chooses its location
  (ruling `central-kb-owns-project-artifacts`).
- A `plan-record` run artifact with specification, seams, slicing and dependency graph, linked from the
  `prd`.
- One `ticket` per slice: `type: implementation`, id `bound-<spec>-<slice>`, with interfaces, ownership,
  edges, criteria, verification, readiness, resolved assumptions and exact ticket-time delegation.
- A `type: decision` ticket for an unresolved fork, carrying any completed evidence blocks in place of
  the implementation ticket. At `bound.run`, these outputs remain drafts.

## Side effects

Effects are `artifact-write`, `scratch-write`, `kb-draft` and `kb-publish`; the working repository is
not modified.
For publish, derive the idempotency key from run, operation, record identity and artifact hash; read
before writing and confirm the returned ref and stored hash afterward. Missing read-back is `failed`.

## Stop conditions

- `complete`: hash-bound approval, criterion coverage, three evidence blocks per implementation ticket
  and matching publication read-backs.
- `needs-input`: invalid start; missing or stale inputs; failed scorer; vague criterion; open assumption
  or review decision; or new evidence invalidating a settled decision. Preserve completed evidence.
- `cap-reached`: five consensus rounds or the runner-supplied ticket budget; return the unresolved
  architectural question or remainder. Never invent an absent ticket budget.
- `cancelled`: the human ends the run before approval. `failed`: knowledgebase or read-back failure.

## Limits

Prefer one highest viable test seam. Change size and test-shape values are project-configured guidance,
not gates or findings (ruling `numeric-heuristics-are-guidance`).
