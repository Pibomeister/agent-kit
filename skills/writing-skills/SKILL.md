---
name: writing-skills
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:writing-skills`. On
  any other request do not load or follow it; tell the human to type that command. Authors a new
  skill or edits an existing one in this package, test-first: a failing eval case and a recorded
  baseline come before any wording, and the change stops as a candidate for a separate review. Use
  when a human asks to write, change or harden a skill, protocol, role or reference in this catalog.
  Not for project documentation, and not for promoting a change.
license: MIT
metadata:
  ak_catalog_id: writing-skills
---

Author and improve skills using behavioral tests and provenance. Required for maintaining this
package; candidate edits pass evaluations and a separate review before promotion.

## When to use

- A human asks to write a new skill, protocol, role or reference for this catalog.
- A human asks to change an existing one: a gate that does not hold, a wrong-shaped output, a
  missing element.
- A supported lesson in the knowledgebase names a skill's instructions as the cause of a failure,
  and the human asks to turn it into a candidate change.
- A revision failed its evaluations or its review, and the human asks to roll it back.

## Not for

- Project documentation, decisions or lessons. Those belong to the central knowledgebase and to
  `compound`, and this skill writes none of them into the repository.
- Promoting a change. The author of a candidate never promotes it; evaluations and a separate
  review do.
- Fixing a defect in the `ak` CLI or its validators. That is ordinary code under `src/`, done
  test-first under the `tdd` protocol.
- Rewording a document for readability alone. That is the prose-quality reference pack, applied by
  whichever skill owns the document.

## Authority

Authority: `explicit`. A human starts it with `/ak:writing-skills`. No phase operation exposes it
(`policies/invocation.yaml` lists it among the user-invoked skills that expose none), so no
controller can start it under a grant. Started any other way, it stops at step 1 and names the
command.

## Inputs

- The target: a skill, protocol, role or reference id in `catalog.yaml`. A new id with no entry
  there: `needs-input` for the catalog owner, who adds the entry first.
- The failure to fix: an observed transcript, a failing eval case, or a knowledgebase lesson read
  through `readContext`. None of these: the baseline in step 3 must produce one.
- The eval runner and the repository at a readable revision. Unavailable: `needs-input`.

## Workflow

1. **Check authority.** Proceed only on an explicit `/ak:writing-skills` request. Otherwise stop,
   name the command, and change nothing.
2. **Read the contract.** Read `AGENTS.md`, `AUTHORING.md`, the target's `catalog.yaml` entry, the
   rulings that bind it in `policies/resolved-conflicts.yaml`, and the current output of
   `bun run ak validate`. They govern; this skill does not restate them. Where they are silent or
   wrong, file a `CONTRACT-DEFECTS.md` entry and stop on that item.
3. **RED: watch it fail.** Pick the eval case that exercises the failure, or write one under
   `evals/<id>/`. Run it without the change, in a context that has not seen the change. Record the
   behavior and every rationalization verbatim. If the baseline does not fail, stop: there is
   nothing to fix.
4. **Classify the failure and choose the form.** Load
   [the authoring-discipline reference](references/authoring-discipline.md) and match the form to
   the failure. A rationalization table is for discipline failures only, and its rows come from
   the rationalizations recorded in step 3.
5. **GREEN: write the smallest change.** Load
   [the prose-quality reference pack](../../references/prose-quality/REFERENCE.md) and write to it.
   Change the body and its `skill.yaml` mirror together, add a provenance row for every adapted
   file, and cite each binding ruling where the contract says to.
6. **Micro-test the wording when a full run is costly.** Use the protocol in the
   authoring-discipline reference: a no-guidance control, five or more samples per variant, every
   match read by hand. Micro-tests check wording; they never replace step 7.
7. **Verify.** Run the same cases with the change, in a fresh context. Then run
   `bun run ak validate` and `bun test`. Record each result with the revision it measured.
8. **REFACTOR: close loopholes.** A new rationalization in step 7 gets an explicit counter and a
   re-run. Repeat until the cases hold.
9. **Publish the change record and stop.** Publish the record through `publishArtifact`, then read
   it back. Return the change as a candidate for a separate review. Do not promote it.

Rolling back replaces steps 3–8: revert the target's source to its last verified revision, run
`bun run ak validate` and `bun test`, then publish a change record that notes the rollback (step 9).
Lessons and earlier change records are left as they are.

## Hard gates

Gate: no wording before a failing case. This holds for new skills and for edits to existing ones.
A change written first is discarded, not kept as a reference while the case is written. A rollback
restores verified wording rather than writing new wording, so step 3 does not apply to it.

Gate: no promotion without the recorded baseline, the verified run and a separate review. The
author of the change is never its reviewer, and never promotes it.

Gate: a rationalization table only for a discipline failure, with rows taken from the baseline.
Shape and omission failures get a recipe or a required slot.

Gate: rolling a skill back reverts skill source only. The lesson and the change record that
motivated it stay in the knowledgebase with their history.

Gate: nothing project-derived is written into this repository. Skill source, eval cases and
provenance rows are this package's own reusable instructions; the change record is not (ruling
`central-kb-owns-project-artifacts`).

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The skill is obviously clear, so it does not need a test." | Clear to its author is not clear to the agent that runs it. | Run the baseline and watch it fail first. |
| "It is only a small addition to one section." | A small edit is still an edit, and the gate covers edits. | Write or pick the failing case before the wording. |
| "It passed once; that is enough to ship." | A single sample does not show the wording binds, and passing is not review. | Record the run, and hand the candidate to a separate reviewer. |
| "I will add a rationalization table to be safe." | On a shape or omission failure, prohibitions add the unwanted content. | Classify the failure; use a recipe or a required slot. |
| "The skill reverted, so its lesson should go too." | The lesson's evidence did not change when the wording did. | Revert the source; leave the knowledge history intact. |

## Outputs

- A candidate change to this package: skill source, its `skill.yaml`, eval cases and provenance
  rows. It is not promoted.
- A change record: the target, the baseline and its verbatim rationalizations, the form chosen and
  why, and the verified results with the revision each measured. It is published as a knowledgebase
  `process` document for this catalog through `publishArtifact`, never to a repository path (ruling
  `central-kb-owns-project-artifacts`; `docs/decisions/0001-kb-document-vocabulary.md` §3).
- With the baseline passing: no change, and the baseline result returned.

## Side effects

`skill-source-write`, `process-exec`, `artifact-write`, `scratch-write`, `kb-publish`. No
`workspace-write`: the only repository files this skill changes are this package's own skill
source, eval cases and provenance rows, and nothing project-derived is written here (ruling
`central-kb-owns-project-artifacts`).

`kb-publish` is a remote side effect. Its idempotency key is the one
`adapters/runner-contract/CONTRACT.md` §5 derives, with the input artifact hash taken over the
draft persisted in scratch, which a resumed run reuses. The read-back is the record as the
knowledgebase returns it. A resumed run reads back first and does not publish a second copy. A
publish whose read-back cannot be performed is
`failed`, never complete.

## Stop conditions

- `complete` — the candidate is verified, the change record is published and read back, and the
  candidate is returned for a separate review.
- `complete` — the baseline did not fail; nothing was changed, and the result is returned.
- `complete` — a rollback is verified, and its change record is published and read back.
- `needs-input` — started without an explicit `/ak:writing-skills`; or the target has no
  `catalog.yaml` entry, for the catalog owner to add; or the repository or eval runner is
  unavailable; or `kb-write` is unavailable, and the change record is returned in the session
  instead; or the contract is silent or wrong and a defect entry was filed.
- `failed` — the change record's read-back could not be performed.

## Limits

- Changes written before a failing case: 0 (gate).
