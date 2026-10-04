---
name: codebase-design
description: >-
  Shared vocabulary for deep-module design. Use when a caller asks a bounded question about a
  module's interface, depth, seam, adapters, testability, leverage or locality. This is a reference,
  not a design or implementation process: with no design question, state the vocabulary and stop.
license: MIT
metadata:
  ak_catalog_id: codebase-design
---

Use the shared language in [the codebase-design reference pack](../../references/codebase-design-vocabulary/REFERENCE.md)
for deep modules. This skill supplies selection and stopping behavior around that single vocabulary
owner; it does not duplicate the glossary or create a design process.

## When to use

- A caller asks where a module's interface or seam should go.
- A caller asks whether a module is deep, shallow, testable or worth keeping.
- A caller asks how adapters, leverage or locality affect one bounded design.
- Another skill needs the shared deep-module vocabulary.

## Not for

- Discovering deepening opportunities across a repository; that is `improve-architecture`.
- Settling a feature's direction or domain language; that is `super-align`, which loads the
  `domain-modeling` reference when domain terms are at issue.
- Reviewing a requirements document or plan; that is `doc-review`.
- Implementing a design or running TDD; an approved ticket enters `super-build`, which owns TDD.

## Authority

Authority: `model`. A caller or parent skill loads this reference when the question matches its
description; no grant or phase operation is involved. Loading it authorizes no edits or downstream
workflow.

## Inputs

- An optional bounded design question and any interface, caller, dependency or test facts needed to
  answer it. With no question, return the vocabulary and principles below, then stop.
- Read [the vocabulary and four principles](../../references/codebase-design-vocabulary/REFERENCE.md) before
  answering or stating them.
- For a deepening question, read
  [the deepening guide](../../references/codebase-design-vocabulary/DEEPENING.md).
- For an explicit request to compare alternative interfaces, read
  [design it twice](../../references/codebase-design-vocabulary/DESIGN-IT-TWICE.md). Do not load either
  procedural guide otherwise.

## Workflow

1. Load the reference pack's `REFERENCE.md`, then identify the bounded design question. If none was
   supplied, state its eight glossary terms and four principles, then stop without inspecting a
   repository or inventing a process.
2. Answer the question using this vocabulary. Use the project's domain terms for the domain, but
   use these terms for codebase design; do not replace them with loose synonyms.
3. Load only the supporting guide the question calls for. Apply its criteria to the stated facts;
   do not turn a reference answer into a repository survey, alignment session, review or build.
4. Return the answer and stop. If the request is actually for a process, name the owning skill from
   `Not for` instead of reproducing that process here.

## Hard gates

Gate: no design question means no invented work. State the vocabulary and four principles, then
stop; do not inspect files, propose a sequence or start another skill.

Gate: this skill is read-only reference material. It writes no code or artifact, makes no decision
for the caller and starts no downstream process.

Gate: use **module**, **interface**, **implementation**, **depth**, **seam**, **adapter**,
**leverage** and **locality** with the meanings in the reference pack. Do not substitute component,
service, API or boundary for those concepts.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "They invoked a design skill and said go, so I should inspect the repository." | This reference has no discovery process, and an invocation is not a design question. | State the vocabulary and principles, then stop. |
| "The answer is obvious, so I can start implementing it." | A reference answer is not an approved ticket or implementation authority. | Return the answer and name `super-build` only when implementation is actually requested and approved. |
| "Service and API are familiar enough." | Those words collapse distinct ideas and lose the shared design language. | Name the module, its interface and the seam precisely. |

## Outputs

- With a bounded question: a read-only answer using the glossary and relevant principles, with the
  owning neighboring skill named when the request belongs to a process.
- With no question: the glossary terms and four principles, with no proposal or next action.

## Side effects

None. It returns guidance in the session and changes nothing.

## Stop conditions

- `complete` — the bounded question is answered using the shared vocabulary.
- `complete` — no question was supplied, so the vocabulary and principles were stated and the run
  stopped without inspection or process.
- `complete` — the request belongs to a neighboring process, so its owning skill was named and no
  part of that process ran here.
- `needs-input` — a bounded question was supplied but omits facts required to distinguish the
  interface, callers or dependencies; return the missing facts and no speculative design.

## Limits

- Repository inspection without a bounded design question: 0 (gate).
- Workspace or durable artifact writes: 0 (gate).
- Supporting guides loaded: only those selected by the stated question (gate).
