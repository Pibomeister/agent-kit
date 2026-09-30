---
name: improve-architecture
description: >-
  Human-started command: it runs only when the human's message begins with
  `/ak:improve-architecture`. On any other request do not load or follow it; tell the human to type
  that command. Surveys a codebase for shallow modules, presents deepening candidates, and grills
  the one the human picks into a proposed decision. Use when a human wants to know where the
  architecture has gone shallow and runs /ak:improve-architecture. Not for cleanup inside a feature
  diff, and not for a repository-wide rewrite.
license: MIT
metadata:
  ak_catalog_id: improve-architecture
---

Survey module boundaries and propose one worthwhile deepening. No unsolicited repository-wide
rewrite; implementation is a separate human-started work source.

## When to use

- A human wants a periodic look at where the architecture has gone shallow, outside any feature.
- A named subsystem keeps costing effort to change and the human wants to know whether a deeper
  module would fix that.
- A review or a cleanup pass named an architectural finding and the human has chosen to take it up.

## Not for

- Tidying a diff. Behavior-preserving cleanup of a settled scope is `simplify`.
- Rewriting the repository. This skill proposes candidates and takes exactly one further.
- Implementing the chosen deepening. That is a new work source a human starts separately, through
  `super-align` or `super-bound`; this skill never continues into code.
- Retiring a public surface. That is `deprecate`.

## Authority

Authority: `explicit`. A human starts this skill with `/ak:improve-architecture`. It may start
model-invoked skills only; it starts no user-invoked skill, which is why the implementation handoff
is named for the human rather than begun here.

## Inputs

- A direction, if the human named one: a module, a subsystem or a pain point. Absent, the commit
  history chooses where to look.
- The repository, readable at a named revision. Unreadable: `failed`.
- The project's existing decisions and domain vocabulary, through the knowledgebase adapter's
  `readContext` for `adr` and `concept` pages in the area. Unavailable: `needs-input`; a survey that
  cannot see what was already decided will re-litigate it.
- The design vocabulary in
  [the codebase-design reference pack](../../references/codebase-design/REFERENCE.md): module,
  interface, depth, seam, adapter, leverage, locality, and the deletion test.

## Workflow

1. **Check how this run was started**, before any other step and before any tool call. It is started
   only when the human's message begins with `/ak:improve-architecture`; no grant starts it. A
   request in prose is not a start, even when it names this skill or the command. Otherwise, stop
   here: make no tool call, say that this command is human-started, and give the human the line to
   type, `/ak:improve-architecture` and their request.
2. **Scope before scanning.** Take the human's direction if there is one. Otherwise read a good
   stretch of the commit history and let the areas that keep changing pull attention first; widen
   the net only if the changes are scattered. Read the existing decisions and vocabulary for that
   area before reading its code.
3. **Explore for friction**, organically, with the questions in
   [the survey guide](references/survey.md). Apply the deletion test to anything that looks shallow:
   would deleting it concentrate complexity, or only move it?
4. **Write the candidate report** to the host's temporary directory, never into the repository, and
   tell the human its path. One card per candidate, in the card shape in the survey guide, with a
   strength of Strong, Worth exploring or Speculative, ending with one top recommendation.
5. **Handle decisions already made.** Surface a candidate that contradicts an existing `adr` only
   when the friction is real enough to reopen it, and say so plainly on the card, naming the record.
   Do not list every refactor a decision forbids.
6. **Ask which one.** Propose no interfaces yet. Ask the human which candidate to explore, and take
   exactly one.
7. **Grill the chosen candidate** inline, one question at a time, using the host's blocking-question
   tool where one is listed and numbered options in chat otherwise: constraints, dependencies, the
   shape of the deepened module, what sits behind the seam, which tests survive. Use the
   [deepening guide](../../references/codebase-design/DEEPENING.md) for dependency categories and
   seam discipline.
8. **Record what was decided.** When the grilling settles a shape, publish it as a proposed `adr`.
   When the human rejects the candidate for a load-bearing reason a future survey would need, offer
   to publish that rejection as a proposed `adr`, and publish only on a yes. An ephemeral reason
   ("not now") or a self-evident one is not recorded.
9. **Hand off and stop.** Name the implementation as a separate human-started run and stop. A term
   the new module introduced is carried in the proposed decision's text for a later `super-align`
   run to settle.

## Hard gates

Gate: one candidate goes further per run. The human picks it; this skill never grills or proposes
several at once, and never proposes changing the whole repository.

Gate: no code is written. This skill proposes and records; implementation is a separate
human-started work source.

Gate: an `adr` is published `proposed` and never accepted here. Acceptance happens in review, never
by its author.

Gate: nothing lands in the repository. The report goes to the temporary directory; decisions go
through the knowledgebase.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The human said restructure everything, so I'll grill every candidate." | A batch of deepenings chosen at once is an unsolicited rewrite, and each one's grilling is shaped by the last. | Present the candidates and ask which one. |
| "The shape is settled; I'll start moving the code." | Implementation is a new work source a human starts, with its own alignment and bounds. | Publish the proposed decision and stop. |
| "There's an ADR against this, so I'll leave the candidate out." | A decision whose friction is now real is worth reopening, and hiding it hides the evidence. | Surface it with the record named, only if the friction is real. |
| "They said not now; I'll record that so nobody suggests it again." | An ephemeral reason recorded as a decision blocks a future survey for no durable cause. | Record only a load-bearing reason, and only on a yes. |
| "This module is small, so it must be shallow." | Size is not depth; the deletion test is. | Apply the deletion test and report what it shows. |

## Outputs

- Candidate report — a self-contained page in the host's temporary directory, never committed and
  never published; transient scratch.
- `adr` pages, published `proposed` through the knowledgebase adapter's `publishArtifact` under a
  `kb-document` placement scoped to the project. The knowledgebase resolves the location; this
  skill supplies no path and writes no decision file into the working repository (ruling
  `central-kb-owns-project-artifacts`).
- The grilled interface shape and the implementation handoff, returned in the session.

## Side effects

`process-exec`, `scratch-write`, `kb-draft`, `kb-publish`. No `workspace-write`.

`kb-publish` is a remote side effect. Its idempotency key derives from the run, the operation, the
record's stable remote identity and the artifact's hash; the read-back is the record the publish
returns, read before the write and confirmed after it (`adapters/runner-contract/CONTRACT.md`,
"Idempotency"). A publish whose read-back cannot be performed is `failed`, never complete.

## Stop conditions

- `complete` — the chosen candidate is grilled, its proposed `adr` is published and read back, and
  the handoff is named.
- `complete` — the survey found no candidate worth proposing, or the human declined all of them.
- `needs-input` — not started with `/ak:improve-architecture`, or the knowledgebase cannot be read
  or written.
- `failed` — the repository is unreadable, or a publish's read-back cannot be performed.
- `cancelled` — the human withdrew; nothing further is published.

## Limits

- Candidates taken further per run: 1 (gate).
- Candidates presented: as many as the survey found worth a card (guidance).
- Report location: the host's temporary directory only (gate).
