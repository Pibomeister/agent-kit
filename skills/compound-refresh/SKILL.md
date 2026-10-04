---
name: compound-refresh
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:compound-refresh`.
  On any other request do not load or follow it; tell the human to type that command. Audits
  captured lessons against the current codebase and decides, for each, keep, update, consolidate,
  replace or retire, recording the evidence and the supersession rather than erasing anything. Use
  when lessons may have drifted, overlap, or contradict each other. Not for capturing a new lesson.
license: MIT
metadata:
  ak_catalog_id: compound-refresh
---

Keep, update, consolidate, replace or retire captured lessons, recording evidence and supersession
instead of silently erasing provenance.

## When to use

- A refactor, migration or dependency change may have made lessons about that area wrong.
- Two or more lessons cover the same subject and a reader would have to reconcile them.
- A lesson contradicts another lesson, or contradicts the code as it now stands.
- Under the `learning` profile, a review guardrail no longer earns its place, or a run of the
  learning runtime drafted something that has to be taken back.

## Not for

- Capturing a lesson from work just done. That is `compound`, a separate human-started run.
- Editing product code, tests, or the project's guidance files. This skill changes lessons and the
  runtime's ledgers only.
- Pruning by age. A lesson is not stale because it is old.
- Deleting anything. A lesson that stops applying is retired or superseded, and its record stays
  (`schemas/lesson.schema.json`).

## Authority

Authority: `explicit`. A human starts this skill by typing `/ak:compound-refresh`, and it exposes
no phase operation: no controller, grant or charter entry can start it. A request in prose is not
a start, even when it names this skill or the command. A controller that needs its effect stops
and names the slash command (ruling `entrypoint-phase-operation-split`).

## Inputs

- The scope: a subject, a module, or a set of lesson ids. Absent: the lessons touching what changed
  most recently in the knowledgebase's context for this project.
- The lessons in scope, through the knowledgebase adapter's `readContext`. Unavailable:
  `needs-input`. Its commands, and the commands for every change proposed below, are in the
  [knowledgebase-backend reference pack](../../references/knowledgebase-backend/REFERENCE.md).
- The current codebase, read-only, as the evidence each lesson is checked against.
- Optional, under the `learning` profile: `ak learn review report` for review patterns and their
  guardrail status, and `ak learn memory show` for working memory and lessons. The runtime is an
  optional host adapter; its absence narrows the scope and changes nothing else (ruling
  `learning-runtime-is-host-adapter`).

## Workflow

1. **Check how this run was started**, before any other step and before any tool call. It is started
   only when the human's message begins with `/ak:compound-refresh`; no grant starts it. A request
   in prose is not a start, even when it names this skill or the command, or asks for this work
   without naming either. Otherwise, stop before reading any lesson or code, checking inputs or
   answering the task: the only response is to tell the human to type `/ak:compound-refresh`
   followed by their request.
2. **Read each lesson in scope** and the code it describes.
3. **Classify each one.**
   - **Keep** — still accurate and still useful. Record that it was checked, and nothing more.
   - **Update** — the statement holds but a detail drifted: a renamed path, a moved module, a
     changed flag. Correct the detail in place.
   - **Consolidate** — two or more lessons cover one subject. Merge them only if a reader looking
     for either would find the merged one as fast; otherwise keep them apart and cross-reference.
   - **Replace** — the lesson is wrong, and there is real evidence for what is right now. Propose a
     new candidate that names the old one in `supersedes`.
   - **Retire** — the lesson no longer applies and nothing replaces it. Mark it retired with the
     reason; the record stays.
4. **Put contradiction first.** Two lessons that disagree are resolved before any staleness work,
   because a reader acting on the wrong one does harm and a stale one only wastes time.
5. **Leave the unverifiable alone.** A lesson whose claim cannot be checked from here is not false.
   Keep it and say it was not verified.
6. **Change the runtime's ledgers only through the runtime** (under the `learning` profile):
   - `ak learn review retire --id rp-NNN` retires a review pattern. The guardrail bullet goes; the
     pattern page stays with status `retired`, and a later ingest does not revive it.
   - `ak learn review rollback [--to SHA]` undoes the review ledger's judgement and policy commits.
     The raw event log is restored as it was, so what was observed is never taken back.
   - `ak learn memory rollback [--to SHA]` restores a repository's working memory and lessons.
7. **Propose, then publish only on the human's say-so.** Every Update, Consolidate, Replace and
   Retire goes to the knowledgebase as a candidate change. The human confirms it in this session
   before it is published (ruling `learning-drafts-not-publishes`).
8. **Report every decision** with the lesson id, the outcome and the evidence behind it.

## Hard gates

Gate: nothing is deleted. Retirement and supersession keep the record and its provenance.

Gate: age alone is not staleness, and an unverifiable claim is not a false one.

Gate: Replace needs evidence for the replacement. Without it the outcome is Keep, flagged, or Retire.

Gate: no edit outside lessons and the runtime's ledgers, and nothing inside the working repository
(ruling `central-kb-owns-project-artifacts`).

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "This lesson is two years old; it's probably out of date." | Age is not evidence. Old lessons about stable code are the most valuable ones. | Check it against the code. Keep it if it holds. |
| "I can't confirm this claim, so I'll retire it." | Unverifiable is not false, and retiring a true lesson loses knowledge nobody will rediscover cheaply. | Keep it and record that it was not verified. |
| "These five lessons all mention the cache; merge them into one." | A merged lesson nobody can find serves nobody. | Consolidate only where the merged lesson is as findable as each original. |
| "The guardrail is noisy; I'll edit the ledger file directly." | A hand edit bypasses the runtime's sticky retirement and its commit history, so it is revived or unrecoverable. | Run `ak learn review retire --id` and report it. |
| "Rolling back the review ledger will clear these bad events too." | Rollback undoes judgement and policy, never the record of what was observed. | Retire the patterns the events fed, and leave the events. |

## Outputs

- A decision per lesson in scope: Keep, Update, Consolidate, Replace or Retire, with its evidence.
- Candidate changes proposed to the knowledgebase; replacements as new `lesson` candidates naming
  what they supersede.
- Under the `learning` profile, the ledger commands run and their results.
- A report of every decision, what was published, and what awaits the human.

## Side effects

`artifact-write`, `kb-draft`, `kb-publish`, `process-exec`. No `workspace-write`: the working
repository is read, never changed. `process-exec` is the runtime's own commands and nothing else.

`kb-publish` is a remote side effect. Its idempotency key derives from the run, the operation, the
lesson's identity and its artifact hash, and the read-back is the lesson as the knowledgebase
returns it (`adapters/runner-contract/CONTRACT.md`).

## Stop conditions

- `complete` — every lesson in scope has a recorded decision.
- `needs-input` — the run was not started by the typed command, which returns the command to type
  and nothing else; the knowledgebase adapter is unavailable; or a change awaits the human's
  confirmation.
- `failed` — a write's read-back or a runtime command failed; the report names which.

## Limits

- Scope: the lessons named or selected at the start; nothing discovered mid-run is added to it
  (gate).
- Outcomes per lesson: exactly one (gate).
