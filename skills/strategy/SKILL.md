---
name: strategy
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:strategy`. On any
  other request do not load or follow it; tell the human to type that command. Interviews a human
  for the product's standing strategy (purpose, positioning, users, key metrics, tracks and
  boundaries), pushes back on weak answers, and publishes the result as the product's strategy page
  in the knowledgebase. Use when a human starts or revisits a product's direction and runs
  /ak:strategy. Not for planning features, scheduling work or updating the tracker, and not for a
  library with no product framing.
license: MIT
metadata:
  ak_catalog_id: strategy
---

Work from standing product goals and strategic constraints. No automatic feature expansion.

## When to use

- A product has no strategy on record and a human wants one written.
- A human wants to revisit one section of an existing strategy: the metrics, the positioning, the
  tracks.
- The product's direction has changed and the recorded strategy no longer describes it.

## Not for

- Planning features or writing requirements. Options are `ideate`; a chosen direction becomes work
  through `super-align` and `super-bound`.
- Scheduling, prioritizing or reconciling in-flight work. That lives in the tracker, and this skill
  neither reads it for decisions nor writes to it.
- A library, a weekend project or anything with no product framing to anchor. There is nothing for a
  strategy to decide.
- Deriving the strategy from the repository. The human answers; the repository only grounds the
  question.

## Authority

Authority: `explicit`. A human starts this skill with `/ak:strategy`. It may start model-invoked
skills only; the next steps it names are for the human to start. Every section it publishes comes
from the human's answers in this session, and the draft is published only after the human has seen
it and had an edit round.

## Inputs

- A focus, if the human named one: a section to revisit, or a scope. Absent, the recorded state
  decides the path.
- The product's existing strategy page and its revision history, through the knowledgebase
  adapter's `readContext` for `concept` pages scoped to the product. An empty result is a first run;
  an unreachable knowledgebase is `needs-input`.
- Stated intent, read to ground the questions: the README, the product's other `concept` and `prd`
  pages, and what the code is organized around. Bounded to "what is this and who is it for", never a
  full profile of the repository.
- Recent commits, read only for where attention has gone. They inform the Tracks question and drift
  on an update run, never a conclusion.
- The product's name. If grounding does not supply it, ask.

## Workflow

1. **Check authority.** Continue only if a human started this run with `/ak:strategy`. Otherwise
   stop, say that a human starts this skill, and name the command.
2. **Ground, then show it.** Build a model of the product from the inputs and show it in three to
   five lines, each naming its source: what the product seems to be, who it seems to serve, where
   attention has gone. Invite correction. A repository with nothing substantive is a normal path:
   say so in one line and interview ungrounded.
3. **Route by what is on record.** No strategy page: announce a first run. A page exists: read
   [the update guide](references/update-run.md) before anything else, and announce an update run.
4. **Interview**, per [the interview guide](references/interview.md), one question at a time,
   using the host's blocking-question tool where one is listed and numbered options in chat
   otherwise. First run order: Purpose, Positioning, Users, Key metrics, Tracks, the stress test,
   Boundaries, then Milestones and Brand only if the human wants them. An update run summarizes the
   page in three to five lines, lists drift candidates with their evidence, and revisits the section
   the focus named or the human picks.
5. **Push back, twice at most.** Quote the human's own words back when an answer is weak. After two
   rounds, capture what was given and name the section as worth revisiting. That is a completed
   section, not a blocked run.
6. **Draft.** Fill [the strategy template](assets/strategy-template.md) from the surviving answers,
   in the human's language. Present the whole draft in chat and offer one edit round.
7. **Publish** the approved draft as the product's strategy page, under the ownership rules in the
   update guide, and read it back.
8. **Hand off in one line.** Say where the page lives and that `ideate`, `super-bound` and
   `product-pulse` read it as grounding on their next run. Stop.

## Hard gates

Gate: no section is written from the repository alone. Evidence sharpens a question; an answer
comes from the human.

Gate: nothing reaches the tracker. No ticket is created, moved, reprioritized or scheduled.

Gate: no feature, schedule or implementation plan enters the page. Short is a feature; push back on
expansion rather than adding sections.

Gate: nothing is published before the human has seen the full draft and had an edit round.

Gate: a section carrying an author-approved marker, and a page the human does not own, are never
edited. Report the conflict and stop on that section.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The README says who it's for; I'll fill in Users and skip the question." | A strategy the human never stated is a guess wearing their name. | Open the question with what the README suggests and let them confirm or correct. |
| "They want the roadmap sorted too; I'll file the tracks as tickets." | Tracks are investment areas, not scheduled work, and the tracker is out of scope. | Name the tracker as out of scope and stop there. |
| "Twelve metrics is thorough." | A dashboard is not a strategy. | Ask for the three to five they would stake the quarter on. |
| "Third round of pushback; this answer is still weak." | The interview spirals and the human disengages. | Capture it after two rounds and name it as worth revisiting. |
| "Nobody would mind if I tidy this hand-written page into the template." | Someone else's shape is their captured intent, and readers depend on it. | Edit by meaning in its own shape. |

## Outputs

- The product's strategy, published as a `concept` page through the knowledgebase adapter's
  `publishArtifact` under a `kb-document` placement scoped to the product. The knowledgebase
  resolves the location; this skill writes no strategy file into the working repository (ruling
  `central-kb-owns-project-artifacts`).
- In the session: the grounding model, the draft, the sections named as worth revisiting, and the
  one-line handoff.

## Side effects

`process-exec`, `scratch-write`, `kb-draft`, `kb-publish`. No `workspace-write`, no
`tracker-write`.

`kb-publish` is a remote side effect. Its idempotency key derives from the run, the operation, the
page's stable remote identity and the artifact's hash; the read-back is the record the publish
returns, read before the write and confirmed after it (`adapters/runner-contract/CONTRACT.md`,
"Idempotency"). A publish whose read-back cannot be performed is `failed`, never complete.

## Stop conditions

- `complete` — the approved draft is published and read back, and the handoff is named.
- `complete` — an update run where the human confirmed every section still holds; nothing is
  published.
- `needs-input` — not started with `/ak:strategy`, the knowledgebase cannot be read or written, the
  product's name is unknown, or the human's answer is awaited.
- `failed` — a publish's read-back cannot be performed.
- `cancelled` — the human withdrew; nothing is published.

## Limits

- Pushback rounds per section: two (gate).
- Key metrics: three to five; tracks: two to four (guidance).
- Grounding shown before the first question: three to five sourced lines (guidance).
- Edit rounds on the draft before publishing: one (guidance).
