---
name: deprecate
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:deprecate`. On any
  other request do not load or follow it; tell the human to type that command. Plans and carries out
  the retirement of a surface other code depends on: the decision, consumer evidence, a notice and
  migration guide, incremental migration, and a removal held behind its own gate. Use when a human
  runs /ak:deprecate to sunset an API, a feature, a library or a schema shape. Not for deleting code
  nothing consumes.
license: MIT
metadata:
  ak_catalog_id: deprecate
---

Plan and execute an approved retirement or migration with compatibility, sequencing, rollback and
consumer evidence. Irreversible steps stay separately gated.

## When to use

- An old API, library, feature or service has a replacement and its consumers need moving.
- A schema shape must change in production — a rename, a drop, a split — without downtime.
- Code with active consumers has no owner, and the choice is to invest in it or retire it.

## Not for

- Deleting code nothing consumes and nothing exports. That is cleanup, `simplify`.
- Building the replacement. A retirement with no working alternative stops here until one exists.
- Removing anything on the strength of this skill's own invocation. The removal step has its own
  gate, below.
- Deciding product direction. Whether a feature should exist is a `strategy` question.

## Authority

Authority: `explicit`. A human starts this skill with `/ak:deprecate`. It may start model-invoked
skills only. The invocation authorizes the decision, the notice, the migration plan and the
consumer migrations; it does not authorize removal. Removing a public surface is
`public-contract-change` and dropping data is `destructive-data`: each needs an explicit charter
entry a human approved up front, naming the action and exactly what is permitted, bound to that
charter's hash (ruling `sensitive-actions-need-approved-charter-entry`). An approved deprecation plan
is not such an entry.

## Inputs

- The surface to retire and its replacement. No replacement: `needs-input`, naming the replacement as
  work that comes first.
- Consumer evidence through the knowledgebase adapter's `requestImpactAnalysis`, with its coverage
  statement. Unavailable: `needs-input`; this skill never substitutes its own guess at a consumer
  count. A partial graph is a stated limitation, and zero consumers on a partial graph is not zero.
- Existing decisions for the area, through `readContext`.
- The system of record for migration tickets, decided by configuration and never by reachability
  (`adapters/tracker/CONTRACT.md` §2; ruling `tracker-of-record-falls-back-to-kb`): the bound tracker
  where the project folder binds one and the project record agrees; the knowledgebase where there is
  no binding and the record names it or there is no record; `needs-input` otherwise. The chain is
  in the [tracker-of-record reference pack](../../references/tracker-of-record/REFERENCE.md).
- At the removal step only: the charter (`schemas/charter.schema.json`) with its approval bound to
  its hash. Absent, removal does not happen.

## Workflow

1. **Check authority.** Continue only if a human started this run with `/ak:deprecate`. Otherwise
   stop, say that a human starts this skill, and name the command.
2. **Decide.** Answer five questions before anything else: does it still provide unique value (then
   keep it); does a replacement exist (if not, stop); how many consumers depend on it, from the
   impact analysis; what does each consumer's migration cost; what does keeping it cost.
3. **Choose advisory or compulsory.** Default to advisory. Compulsory is for a security problem, a
   blocker or unsustainable upkeep, and it ships migration tooling, not only a deadline.
4. **Choose a migration pattern** from [the migration patterns](references/migration-patterns.md):
   strangler, adapter, feature flag, or expand and contract for any schema change.
5. **Publish the plan.** The decision as a proposed `adr`; the notice and migration guide, from
   [the notice template](assets/deprecation-notice.md), as a `process` page; one migration `ticket`
   per consumer in the system of record, through `createTicket` and `linkRecord`.
6. **Migrate incrementally.** One consumer at a time: find every touchpoint, move it to the
   replacement, verify behavior matches, remove its references to the old surface, confirm no
   regression. The owner of the retiring surface migrates its consumers; announcing and leaving them
   to it is not migration.
7. **Stop at the removal checkpoint.** Report the consumers migrated and those remaining. Removal is
   not the next step of the same pass.
8. **Remove, only under its gate.** When a charter entry covers the action and a fresh impact
   analysis with full coverage shows zero active consumers: remove the code, its tests, its
   configuration and its notices, destructive schema steps last and in their own deploy. The
   [`pack-delete` pack](../../packs/pack-delete/PACK.md) attaches to that diff; it constrains the
   removal and never starts one.

## Hard gates

Gate: no retirement without a working replacement.

Gate: no consumer count without the impact analysis. An unavailable or partial analysis is reported,
never filled with a guess.

Gate: removal needs an approved charter entry for the named action, bound to the charter's hash,
plus zero active consumers on a fresh, full-coverage analysis. Without both, the run stops before
removing anything.

Gate: a schema change is never made in place. Additive first; destructive last and alone; every
migration has a tested down path.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The plan was approved, so removing the old API finishes the job." | Approval of a plan is not a charter entry for `public-contract-change` or `destructive-data` (ruling `sensitive-actions-need-approved-charter-entry`). | Stop at the removal checkpoint and name the entry removal needs. |
| "Nobody uses it anymore." | Hyrum's law: every observable behavior has a dependent, and a belief is not evidence. | Run the impact analysis and report its coverage. |
| "Just rename the column, it's one line." | During the rollout old and new code run together, and one queries a column that no longer exists. | Expand and contract; never rename in place. |
| "Add the new column and drop the old one in the same migration." | That couples a safe add to a destructive drop. | Drops get their own deploy after no code reads the old shape. |
| "We'll write the rollback if we need it." | A migration with no down path is a deploy you cannot reverse. | Write and run the down path before the migration merges. |
| "Consumers will migrate on their own." | They will not; the owner of the retiring surface migrates them. | Cut a ticket per consumer and migrate them one at a time. |

## Outputs

- A proposed `adr` for the retirement decision and a `process` page for the notice and migration
  guide, published through the knowledgebase adapter's `publishArtifact` under `kb-document`
  placements scoped to the project. The knowledgebase resolves the location; this skill writes no
  notice or decision file into the working repository (ruling `central-kb-owns-project-artifacts`).
- One migration `ticket` (`schemas/ticket.schema.json`) per consumer, in the system of record.
- Consumer migrations in the workspace, verified one at a time, for the lane that owns integration.
- A removal-checkpoint report: consumers migrated, consumers remaining, the analysis coverage, and
  the charter entry removal would need.

## Side effects

`workspace-write`, `process-exec`, `scratch-write`, `kb-draft`, `kb-publish`, `tracker-write`,
`artifact-write`. `artifact-write` is the migration `ticket`s, run artifacts bound to their hash.
The removal step is `public-contract-change` or `destructive-data`, and happens only under an
approved charter entry naming it (ruling `sensitive-actions-need-approved-charter-entry`).

`kb-publish` and `tracker-write` are remote side effects. The idempotency key for each derives from
the run, the operation, the record's stable remote identity and the artifact's hash; the read-back is
the record the write returns, read before the write and confirmed after it
(`adapters/runner-contract/CONTRACT.md`, "Idempotency"). A write whose read-back cannot be performed
is `failed`, never complete.

## Stop conditions

- `complete` — the plan is published, the consumers in scope are migrated, and the run stopped at the
  removal checkpoint; or, under a covering charter entry, removal is done and verified.
- `complete` — the decision gate showed the surface still provides unique value; nothing retires.
- `needs-input` — not started with `/ak:deprecate`, no replacement, no impact analysis, no system of
  record, or removal requested without a covering charter entry.
- `failed` — a write's read-back cannot be performed, or a consumer migration broke verification and
  could not be reverted.
- `cancelled` — the human withdrew; published records stay, and nothing is removed.

## Limits

- Removal: never in the same pass as migration, and never without a covering charter entry (gate).
- Consumers migrated at a time: one, verified before the next (gate).
- Advisory by default; compulsory only for security, a blocker or unsustainable upkeep (guidance).
