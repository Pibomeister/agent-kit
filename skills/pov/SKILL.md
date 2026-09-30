---
name: pov
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:pov`. On any other
  request do not load or follow it; tell the human to type that command. Gives a decisive,
  project-grounded point of view in the subject's own shape: a graded verdict on an adoption
  question, a take on a document, or a position on a bounded set of approaches. Every verdict rests
  on verified project evidence and verified external evidence, and says so when either is missing.
  Use when a human asks for your take, your recommendation, or whether to adopt something. Not for
  explaining existing code, not for listing a document's findings, and not for generating options on
  an open field. A recommendation is not authorization.
license: MIT
metadata:
  ak_catalog_id: pov
---

Project-grounded recommendation with optional independent opinions. Read-only; a recommendation is
not authorization. Dissent and insufficient-evidence results survive.

## When to use

- An adoption, replacement, upgrade or exposure question; a take on a document's direction; or a
  position on a bounded set of developed approaches, roughly five or fewer.
- A question that turns on how something feels to a person gets a `Hold` pending a prototype a
  named human evaluates (ruling `prototype-human-experience-needs-human`).

## Not for

- Explaining existing code (`explain`), or listing a document's defects (`doc-review`).
- An open field with no bounded candidate set. That is requirements discovery; route it to
  `ideate`. Candidates that must be built first go to `bakeoff`, whose judge is its own and
  produces no `pov` artifact.
- Implementing the recommendation. A point of view grants no authority to act on it.

## Authority

Authority: `explicit`. A human starts this skill with `/ak:pov`; it is the standalone adoption
verdict and exposes no phase operation, so no controller, grant or other skill can start it. It may
start `/ak:super-scout`, `/ak:research` and `/ak:prototype`, which are model-invoked, and no
user-invoked skill.

## Inputs

- The subject: the question, the document, or the approach set, with the decision it serves.
  Absent or unidentifiable after at most three questions: `needs-input`.
- Read access to the project: the repository, and the knowledgebase through its adapter's
  `readContext` where one is configured. Project evidence is what the project floor rests on.
- External sources through `/ak:research`. Unreachable: the external floor fails, it is not skipped.
- Any earlier point of view on the same subject, from the conversation or the knowledgebase. Its
  verdict stands unless the evidence has changed.
- Where the question is about human experience: the named human who will evaluate the prototype.
  No human is available on this run: the run ends `needs-input`, returning the named `Hold` and
  escalating, never an automated verdict about how it feels (ruling
  `prototype-human-experience-needs-human`).
- A request for independent peer opinions, only when affirmatively made. A declined or merely
  mentioned panel starts nothing.

## Workflow

1. Check how this run was started, before any other step and before any tool call. It is started
   only when the human's message begins with `/ak:pov`; no grant starts it. A request in prose is
   not a start, even when it names this skill or the command. Otherwise, stop here: make no tool
   call, say that this command is human-started, and give the human the line to type, `/ak:pov` and
   their request.
2. Classify the subject: adoption question, document, or approach set. Apply the escape hatch: an
   unbounded field goes to `ideate`, candidates needing development go to `bakeoff`, findings go to
   `doc-review`. Route and stop; issue no verdict on the wrong shape.
3. Set the reversibility tier. Tier 1 is a two-way door such as a dependency or a lint rule. Tier 2
   is one-way but bounded: a data store, an internal contract. Tier 3 is one-way and high-stakes:
   security, privacy, a public contract, an irreversible migration. The tier sets how much to
   investigate, never the format or the honesty of the answer.
4. Look for an earlier point of view on this subject. If one exists and nothing material has
   changed, return it, name it as the standing verdict and say what new evidence would reopen it.
5. Gather project evidence read-only, dispatching `/ak:super-scout` where the tier warrants it.
   Gather external evidence through `/ak:research`. Keep claims from the conversation in a separate
   hypotheses bucket until a read of the source corroborates them.
6. Apply the two-floor gate (see Hard gates). A failed floor ends the run with its named result
   and a numbered list of exactly what to inspect to make the floor passable.
7. Form the position as a skeptic. Seek disconfirming evidence and name the real alternatives,
   including keeping the incumbent and doing nothing. Freeze the position before any peer sees it.
8. If independent peers were asked for, consult them per `./references/independent-peers.md`.
   Peers inform the position; they never vote on it.
9. Return the point of view in the subject's shape (see Outputs). Record it in the knowledgebase
   only when the human asked for a durable record.

## Hard gates

Gate: the project floor. The verdict rests on a concrete, verified project fact: a named incumbent
with at least one touchpoint, the verified absence of one plus a concrete integration point, or a
prior decision on the question. Fail: `Hold — insufficient project grounding` for an adoption
question, `Blocked — insufficient project grounding` for a document or approach set. Never `Adopt`
or `Reject` on a failed project floor, however strong the external evidence.

Gate: the external floor. At least one verified external source supports the claim it backs. Fail:
`Hold — external evidence unavailable`, or `Blocked — external evidence unavailable`, never a
graded verdict at lowered confidence. The two floors are independent; neither compensates for the
other.

Gate: a recommendation is not authorization. A point of view hands off to another workflow only
when the original request authorized that downstream action.

Gate: a standing verdict does not change without new evidence. Asking again is not evidence.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "They only want adopt or reject, so I'll skip the caveat and pick one." | A graded verdict on a failed floor is a guess wearing a grade. The named Hold is a complete answer. | Return the Hold and the numbered list of what to inspect. |
| "The external case is overwhelming, so the thin project evidence doesn't matter." | The floors are independent. Strong outside evidence says nothing about fit here. | Fail the project floor and say what to read. |
| "They asked again, so they want a different answer." | Re-asking changes nothing the verdict rests on. A fresh roll makes every verdict worthless. | Return the standing verdict and name what would reopen it. |
| "Two of three peers said Adopt, so it's Adopt." | Peers inform, they do not vote. A majority is not evidence. | Weigh each peer's reasons against the frozen position and disclose the result. |

## Outputs

- Adoption question: exactly one grade. `Adopt`: proven fit, use it. `Trial`: promising, use on a
  low-risk slice first. `Hold`: a complete decision to wait, including the two gate-failure
  subtypes. `Reject`: not worth it here. `Not-our-problem`: an exposure that does not reach us.
  With the incumbent or integration point, verified project and external evidence, conditions,
  and what would change the verdict.
- Document: the bottom line on its direction, with the strengths, risks and project facts that
  determine it.
- Approach set: a position with its reasons and trade-offs, or "Either is viable" where the
  evidence gives no real basis to choose. Never a scorecard that manufactures certainty.
- Always: unverified claims kept distinct from evidence, peer participation and independence
  disclosed, and any next step marked as a recommendation.
- On explicit request only: a `decision` (`schemas/decision.schema.json`) through the
  knowledgebase adapter's `recordDecision`. This skill writes no documentation tree into the
  working repository (ruling `central-kb-owns-project-artifacts`).

## Side effects

`artifact-write`, `kb-publish`. No `workspace-write`: this skill forms a judgment and changes
nothing it judges.

`kb-publish` is a remote side effect and happens only when the human asked for a durable record.
Its idempotency key derives from the run, the operation, the decision's identity and its content
hash; the read-back is the record `recordDecision` returns, read before the write and confirmed
after it (`adapters/runner-contract/CONTRACT.md`, "Idempotency"). A write whose read-back cannot be
performed is `failed`, never complete.

## Stop conditions

- `complete` — a point of view was returned, a named `Hold` or `Blocked` result included, except
  the human-experience case below.
- `complete` — the subject belonged to another skill and was routed there without a verdict.
- `needs-input` — the subject cannot be identified in three questions, the run was not started by
  a human, or the question is about human experience and no human evaluator is available. That
  last case returns the named `Hold` (ruling `prototype-human-experience-needs-human`).
- `failed` — a requested knowledgebase write could not be read back.

## Limits

- Clarifying questions per run: 3 (gate).
- Candidates for a selection verdict: roughly five (guidance). A larger field goes to `ideate`.
- Peer reconciliation rounds after the independent round: 2 (gate).
