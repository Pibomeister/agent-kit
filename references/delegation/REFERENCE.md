# Delegation records

Load this reference when a lifecycle body creates or consumes a ticket's `delegation`, `readiness`
or `assumptions` fields. The record controls which already-chartered checkpoints may be delegated;
it is evidence, not a finding and not a source of authority.

## Classes and checkpoint authority

The closed class vocabulary is `green`, `yellow-agent`, `yellow-owner` and `red`.

| Class | Authorship meaning |
| --- | --- |
| `green` | An agent may author the bounded implementation. |
| `yellow-agent` | An agent may author the implementation, with the human involvement the policy reserves. |
| `yellow-owner` | An agent drafts while a named human owns the work and approves the ticket before build. |
| `red` | A human authors the implementation; an agent may assist with bounded research or regression tests. |

The authoritative class-to-checkpoint map is
[`delegation_classes`](../../policies/authority-defaults.yaml). Read it at the checkpoint; do not
copy its lists into a skill. A class only narrows checkpoint authority already present in a
runner-validated charter. It never grants authority, and it is never a finding. Project guidance
may raise the class without producing a finding (ruling
`delegation-class-is-authority-not-finding`). Record downstream authorship as author kind plus host,
never as an implementation identity.

The class changes authorship and checkpoint authority, not whether bounding produces a ticket.
A `red` result produces a human-owned implementation ticket. A ticket whose class makes a human the
author states the authorship boundary in existing fields. `allowed_changes` remains the ticket's
full write scope for the implementer. Name the agent's permitted file and symbol subset in text, in
`goal` or `stop_conditions`, alongside non-file assistance such as research; put prohibited agent
work, including authoring the implementation, in `non_goals`. On a decision ticket the boundary
lives in `goal` and `non_goals`. Naming a human owner alone is not that boundary.

`merge` and `deploy` remain sensitive actions for every class, and a human merges every class. A
never-dropped pack or required sensitive action sets a floor that no factor or lowering may cross;
re-evaluate that floor from the actual diff before closure (ruling
`sensitive-surface-sets-the-floor`).

## Two snapshots and lowering

The ticket-time snapshot carries `stage: ticket`. It predicts the work from the approved scope,
attached packs, required sensitive actions, expected size, known history, specification and planned
verification. It decides how the work may be staffed before implementation.

The merge-time snapshot carries `stage: merge`. It uses the actual diff and verification evidence.
It may raise the class automatically. It does not inherit a lower ticket-time result when the diff
requires a higher one (ruling `delegation-class-is-authority-not-finding`).

`lowered_by` is normally `null`. A lowering records:

- `human`: the named person who made the decision;
- `reason`: evidence for the exception;
- `at`: the decision timestamp;
- `from`: the computed class that was lowered.

A later computed class above `from` supersedes the lowering and records `superseded: true`. A
lowering never crosses the sensitive floor. An instruction to delegate, a confidence statement, or
an advisor opinion is not lowering evidence.

## Obtain the record from the scorer

First write the ticket's evidenced `floor`, five factors, `stage`, `lowered_by` and a `class` seed,
and ensure both the ticket and project record validate. The seed is an input the schema requires,
not a judgment: a first ticket-time block seeds `class` at `green`, and a re-run carries the class
the previous run persisted. When `lowered_by` records a named human's lowering, the seed is the
class that person lowered to; the scorer still holds the floor and supersedes the lowering when a
later computed class exceeds `from`. The scorer only raises the seed, so any seed outside these
three cases is a hand-derived class. Then run:

```text
ak delegation <ticket> --project <project-record>
```

Persist the command's complete JSON output as the ticket's `delegation` block. Cite the ticket and
project artifact references used for the run wherever another artifact consumes the result. A body
must not reproduce the formula, weights, cut points, floor table or lowering logic. A missing or
failed scorer run leaves no delegation record and blocks the checkpoint.

## Factor evidence

Every factor carries a project-guided score and at least one evidence string. The meanings are
central; weights and cut points are project-configurable, advisory starting points. A score is an
integer from 0 to 3. For `reversibility`, `size`, `complexity` and `spec` a higher score records
more risk. `verification` records strength: a higher score means stronger verification, and a
ticket with no tests scores 0.

| Factor | Evidence expected at ticket time | Evidence expected at merge time |
| --- | --- | --- |
| `reversibility` | Flags, user visibility, data writes, external effects and consuming services. | Actual flag, migration, contract and external-effect behavior. |
| `size` | Estimated changed lines, files, modules and generated exclusions. | Measured diffusion across changed non-generated code. |
| `complexity` | Concurrency, caching, distributed state, known hotspots and prior fixes. | Complexity delta, churn, prior-fix evidence and new stateful constructs. |
| `spec` | The six readiness criteria, vague terms and unresolved assumptions below. | Decisions exposed by the diff that the approved ticket did not settle. |
| `verification` | Existing tests, the planned oracle and named verification path. | Receipts for tests, fail-before evidence, static checks and integration coverage. |

Hotspot overlap and prior-fix density are transparent evidence when a project can supply them. Their
absence is recorded; a body does not invent either measurement.

## Readiness and vague terms

Every ticket records all six criteria separately. Each criterion carries its own score and evidence
stating what was checked and the artifact, field, command or repository location checked. A boolean,
status word or total never substitutes for criterion evidence. No readiness or stop flag is persisted
outside the schema: readiness is the six scored criteria with evidence, and the stop is stated in
the result. A criterion score is an integer from 0 to 2, where a higher score means the criterion is
more fully met and 0 means it is absent.

| Criterion | Evidence expected |
| --- | --- |
| `acceptance_criteria` | Each outcome is observable and checkable. |
| `interfaces` | Files, functions, routes, types or schemas are named at the appropriate boundary. |
| `examples` | A happy path and at least one relevant edge or error case are stated. |
| `non_goals` | Excluded behavior is explicit. |
| `existing_pattern` | The file or module to imitate is identified, or absence is evidenced. |
| `verification_path` | The test level and fixture or data source are named. |

`vague_terms` records each detected word or phrase, including terms such as “fast”, “clean up” and
“as needed”. Turn every unresolved hit into a frontier question that asks for the missing boundary
and proposes a concrete verification path: observable, workload or fixture, measurement or oracle,
and pass condition as applicable. Express the pass condition against the value the human supplies,
for example `p95 of <observable> on <workload> is at or below the target you name`; never choose a
number or otherwise invent the missing target. A criterion that remains ambiguous fails on its own
evidence; do not turn a readiness total into a finding or use it to fill in the missing decision.

## Assumptions

Record every assumption and resolve it as exactly one of:

- `criterion` when it changes behavior that users or consumers can observe;
- `non-goal` when the approved scope deliberately excludes it;
- `open` when a decision is still missing.

An `open` assumption is not implementation latitude. Resolve it before implementation, or emit a
decision ticket and stop the affected slice at the zero-context gate.

Persist `delegation`, `readiness` and `assumptions` on the draft ticket before any `needs-input`
return reached after this assessment. The stop is stated in the result and cites the failed criteria
and their evidence; it does not erase the draft or reduce the result to prose.
While any specification, assumption or review decision is open, an evidence-bearing draft, where one
exists, is kept and retyped `decision`; no implementation ticket is created or published until those
decisions are answered. Retyping is more than the `type` value: add the `decision` object the ticket schema
requires, carrying the open question, and drop `allowed_changes`, `write_ownership` and
`integration_owner`, which a decision ticket may not carry. `delegation`, `readiness` and
`assumptions` stay.

## Stack construction

Slice on independently verifiable behavior, not on a universal line count. Each slice is a narrow
but complete path through every layer, independently verifiable and sized for one fresh context
window. Order a stack as pure refactor, additive schema expand, behavior behind a flag, consumer,
backfill, then schema contract. The schema-contract change is a separate ticket. Where one
mechanical change breaks call sites across the tree and no vertical slice can land green, use the
wide-refactor shape instead: expand, then migrate in batches with each batch its own ticket blocked
by the expand, then contract, blocked by every batch. Each ticket names its criteria, interfaces,
ownership and verification.
When the direction already spans these independently deployable phases, their boundaries require
the ordered stack. A request to keep them in one ticket becomes an open decision; it does not erase
the boundaries. The decision ticket itself carries the full ordered stack as the recommended option,
in its `decision` question or its `goal`, with no exception alternative.

## Advisor consultation

On a host that offers an advisor facility, consultation is required and recorded as judgment
evidence for `yellow-owner` and `red`, recommended for `yellow-agent`, and silent for `green`.
The record surface is the knowledgebase consultation artifact: store the advisor's result there, and
cite it from the ticket's `kb_refs` as an evidence reference of kind `transcript` or `receipt`, with
the artifact id/ref and a one-line `note` that names it judgment evidence and says what it was used
for. A filesystem path,
document name or URL by itself is not evidence. The ticket carries the citation, never the
consultation itself.
Consultation adds judgment evidence only: it never lowers `delegation.class`, authorizes a sensitive
action, closes a finding or substitutes for a required independent lane. A host without the
facility remains valid and records no invented consultation evidence (ruling
`advisor-consultation-follows-class`).
