---
name: ideate
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:ideate`. On any
  other request do not load or follow it; tell the human to type that command. Generates many
  grounded candidate ideas on an identified subject, critiques every one of them in an independent
  reviewer context, rejects the weak ones with a reason from a closed list, and returns a bounded
  set of survivors with a Not Doing list. Use when a human wants ideas, improvements or directions
  before any one of them is chosen. Not for judging options already on the table, not for defining a
  direction already chosen, and not for building anything. A recommendation is not authorization.
license: MIT
metadata:
  ak_catalog_id: ideate
---

Generate options, then critique them. No implicit commitment or scope expansion.

## When to use

- A human wants ideas, improvements or surprising directions on a subject, before choosing one.
- An open field: nothing bounded exists yet to compare or judge.
- Candidates may concern human experience. Critique can say whether such a candidate is grounded,
  never whether it lands: its merit is marked as needing a named human evaluator, and no survivor
  is ranked on an automated verdict about how it feels (ruling
  `prototype-human-experience-needs-human`).

## Not for

- A bounded set of developed options, or a stated position to judge. That is `pov`.
- A direction already chosen that needs its meaning or scope defined. That is `super-align`, or
  `super-bound` when the scope is the open question.
- Two live approaches that need building to compare. That is `bakeoff`.
- Planning or building a survivor. Ideation never hands work straight to `super-build`.

## Authority

Authority: `explicit`. A human starts this skill with `/ak:ideate`; it exposes no phase operation,
so no controller or grant can start it. It may start `/ak:super-scout`, `/ak:research` and
`/ak:prototype`, which are model-invoked, and no user-invoked skill. Invocation covers scoped
reading, candidate generation, critique dispatch and the returned deliverable. It does not cover
choosing a survivor, planning it, or expanding the subject the human named.

## Inputs

- The subject: a feature, flow, document, concept or question the ideas operate on, plus any focus
  hint. A catch-all such as "improvements" is not a subject. Ask at most three questions, and only
  to identify the subject; never about solution direction, constraints, audience, tone or success
  criteria, which belong to `super-align`. Still unidentifiable: `needs-input`.
- Grounding: the repository read-only, and the knowledgebase through its adapter's `readContext`
  where one is configured, with any earlier ideation on this subject and its rejections.
- External prior art through `/ak:research`, where the subject warrants it.
- For a candidate about human experience: the human who will evaluate it, named in advance. None
  named: the candidate survives only as unevaluated, labelled so (ruling
  `prototype-human-experience-needs-human`).
- An independent reviewer context for the critique.

## Workflow

1. Check authority. Continue only if a human started this run with `/ak:ideate`. Otherwise stop,
   name the command and do nothing else.
2. Classify the request. A bounded option set, a chosen direction or a build-to-compare request is
   routed (see Not for) and the run stops.
3. Identify the subject, within the question limit.
4. Ground before generating: gather what the project and any prior ideation already say. When
   grounding fails, warn, proceed, and tag every resulting candidate `reasoned:` visibly.
5. Generate the full candidate list before critiquing any of it. Spread across lenses by default:
   pain and friction, inversion, assumption-breaking, leverage, cross-domain analogy,
   constraint-flipping. `./references/frameworks.md` holds ways to work a thin lens. Each candidate
   carries a basis: `direct:` (a quoted project fact), `external:` (real, relevant prior art) or
   `reasoned:` (an argument). A candidate with no basis is dropped.
6. Critique every candidate in an independent reviewer context that sees the grounding and the
   list, never the generation history. It checks each basis and the ambition floor: would this
   warrant a team discussion? Returns sound, weak or refuted, with a one-line reason. None
   available: critique here, and label it degraded in the deliverable.
7. Arbitrate. Weigh the verdicts without being bound by them; overruling one requires saying why.
   Every rejection gets exactly one reason from the closed list (see Outputs). Be honest, not
   supportive: a weak idea is called weak.
8. Keep five to eight survivors, ranked by basis strength (`direct:` over `external:` over
   `reasoned:`), value, leverage and burden. Too many: a stricter pass. Too few: report the count;
   never lower the bar to fill it.
9. Return the deliverable in the session (see Outputs), recommending `super-align` as the next
   step for a chosen survivor.

## Hard gates

Gate: generation completes before critique starts, and every candidate is critiqued. Ranking
without critique is not ideation.

Gate: a survivor has a basis that the critique did not refute. Speculation dressed as ambition is
rejected, with the reason.

Gate: a rejected idea stays rejected unless new evidence answers its rejection reason. Re-running
the skill or asking again is not new evidence; a re-surfaced idea is shown with the reason it was
rejected and the evidence that would reopen it.

Gate: a recommendation is not authorization. The deliverable commits to nothing, widens no scope
and starts no downstream work.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "They said pick one and start building, so skip the critique." | Picking is the human's call, and building belongs to another workflow. An uncritiqued pick is a guess. | Critique all, return the survivors with rejection reasons, recommend `super-align`. |
| "This one is bold; the missing basis doesn't matter." | Boldness without a basis is what the unjustified reason exists to catch. | Reject it as unjustified, or find the basis. |
| "The whole product needs rethinking, not just this flow." | The human named the subject. Widening it is scope overrun. | Stay on the subject; note the wider thought in Not Doing. |
| "Last run rejected it, but it keeps coming back, so include it." | Recurrence is not evidence. The rejection reason still stands. | Show it as rejected with its reason and what would reopen it. |

## Outputs

- The deliverable: the subject and grounding summary; the survivors, each with its basis, why it
  matters, downsides and any human-evaluation need; the rejection summary, one reason per rejected
  idea; a Not Doing list making the trade-offs explicit; whether critique ran independently or
  degraded; and the recommended next step, marked as a recommendation.
- Rejection reasons, closed list: too vague; not actionable; duplicates a stronger idea; not
  grounded in the stated context; too expensive relative to likely value; already covered by
  existing workflows or docs; better handled as a variant; unjustified, no articulated basis; basis
  refuted by verification; below the ambition floor; subject-replacement; scope overrun.
- Insufficient evidence is a finished outcome: when grounding and critique leave nothing standing,
  say so and name what evidence would change it, rather than padding the survivor set.
- The deliverable lives in the session only. This skill publishes nothing and records nothing.
  Asked to save it, it still writes no documentation file into the working repository as a
  substitute (ruling `central-kb-owns-project-artifacts`); where to keep it is the human's call.

## Side effects

None. No `workspace-write`: ideation changes nothing it ideates about. No `artifact-write` and no
knowledgebase write: the deliverable is returned in the session and nowhere else.

## Stop conditions

- `complete` — a deliverable was returned, including an insufficient-evidence result.
- `complete` — the request belonged to another skill and was routed.
- `needs-input` — the run was not started by a human, the subject cannot be identified in three
  questions, or a survivor's merit is about human experience and the human asked for it to be
  settled without a named evaluator (ruling `prototype-human-experience-needs-human`).

## Limits

- Clarifying questions: 3 (gate).
- Survivors: 8 (gate); five is the floor aimed at, not forced.
- Critique passes: 2, the second only when too many survive (gate).
