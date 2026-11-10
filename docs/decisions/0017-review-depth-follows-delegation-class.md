# ADR-0017 — Review depth follows the delegation class

**Status:** Accepted.
**Date:** 2026-11-10.
**Authority:** the owner's ask of 2026-11-10, captured verbatim in
`research/sources/review-routing-owner-ask-2026-11-10.md`, and the owner's approval of the
review-routing specification, its plan and this decision record on 2026-11-10, in the words
"Approved on all fronts", relayed by Firstmate. The approval record is the Firstmate task record
`ak-review-routing-plan/approval.md`, relay correlation `5fb6b89178063bbc`. It binds to the
specification's content hash.
**Prior art read:** ADR-0012, ADR-0013, `policies/review.yaml` block `pass_1`,
`policies/resolved-conflicts.yaml` rows `panel-composition-by-declared-risk` and
`delegation-class-is-authority-not-finding`, `references/delegation/REFERENCE.md`,
`src/lifecycle/gate.ts` `DELEGATION_CLASSES`, `AUTHORING.md` sections 5 to 7, and the
review-routing specification and plan.

## Context

The first review pass selects its panel from declared risk. Correctness always sits. The
standards gate sits when the project declares standards. Other seats sit when the diff or the
attached packs earn them. A change within the project's size guidance gets the lean panel
(ruling `panel-composition-by-declared-risk`).

The delegation class is `green`, `yellow-agent`, `yellow-owner` or `red`. It decides who may
author a ticket and which checkpoints a charter may delegate (ruling
`delegation-class-is-authority-not-finding`). It does not reach the review. A green change and a
red change of the same size get the same panel.

The owner asked on 2026-11-10 that the class decide the level of scrutiny. Verification and
evidence now carry more of the merge call, so a review can be lighter where the class is lower.
A full panel takes a long time and uses a large share of a run's work.

## Decision

The merge-stage delegation class selects a **review depth** for the first pass. The depth
selects only the baseline seats. Ruling `review-depth-follows-delegation-class` records this
decision, and `policies/review.yaml` `pass_1.depth` holds it as policy data. Requirements R1 to
R12 of the review-routing specification are:

1. **One map.** `green` maps to `single`. `yellow-agent` and `yellow-owner` map to `reduced`.
   `red` maps to `full`. The map lives in one policy block and one code constant, and a test holds
   them equal. No body restates it.
2. **Three baselines.** `single` sits one generalist reviewer. `reduced` sits the lean panel, and
   the class selects it, not the size guidance. `full` sits today's selection unchanged, which
   includes the lean panel for a change within the size guidance.
3. **Never drop an activated seat.** Every conditional and stack seat that the artifact evidence
   activates sits at every depth. The security and adversarial seats stay required once activated.
   At `single` or `reduced`, evidence that activates either seat, or attaches a pack with a floor,
   means the class is scored again before selection.
4. **The merge-stage class comes first.** Before selection, the first pass takes the approved
   ticket's class as the seed, re-evidences the factors and the floor from the actual diff, and
   runs the scorer in merge stage. The scorer only raises the seed. Only a named human lowers it,
   and never across a floor.
5. **No class evidence means `full`.** The depth is `full` when routing is off, the change has no
   ticket delegation block, the project has no `guidance.delegation`, the scorer or the depth
   command fails, or the run's build record carries no class. The review record names the reason.
6. **Deeper, never shallower.** A seat's evidence of a higher class is an escalation signal, not a
   finding. The run scores again and seats the baseline seats the new depth adds, over the same
   snapshot. A run never moves to a shallower depth.
7. **Shared surfaces set a floor.** A project may declare paths that many features depend on, each
   with a class. A change that touches one has that class as a floor. This is a third floor source
   beside packs and sensitive actions. No factor, weight or cut point changes.
8. **One generalist reviewer.** A new seat for `single` depth holds the owner's five review points:
   patterns and conventions, project rules cited rule by rule, likely bugs, reuse of an existing
   helper, and correctness against the acceptance criteria. It obeys every rule that binds the other
   seats, and it is independent of the author.
9. **Routing is recorded.** The review record gains an optional `routing` object with the mode, the
   class, the depth, a fallback reason and any escalation. The `review-full` gate record gains an
   optional depth, and the recorder refuses a depth shallower than the class allows.
10. **Off by default, shadow first.** The project setting `review.routing` takes `off`, `shadow` or
    `on`, and the default is `off`. `shadow` computes and records the depth and seats today's panel.
    `on` seats the routed depth.
11. **What does not change** is stated in the next section.
12. **The delivery pipeline's Review is not routed.** It runs the same way for every class. It is
    already one reviewer, so it is a constant single-reviewer floor under every class.

## What does not change

- `delta` keeps its two core lanes and its specialist-return rule.
- `readiness` keeps its two independent lanes.
- Fix-cycle and review-round limits, closure rules, seat independence, the verdict vocabulary and
  the finding schema.
- `PRE_SHIP_GATES`. A change at any depth still needs `review-full` and `review-readiness` at head.
- The invocation law. super-review `full` and `readiness` stay model-started (ADR-0013). ADR-0005
  stays Proposed.
- A human merges every class.
- `policies/authority-defaults.yaml` `delegation_classes`.

## Alternatives rejected

- **The class selects a fixed roster.** Rejected. Ruling `panel-composition-by-declared-risk`
  forbids a fixed roster, and a fixed roster could drop a security or adversarial seat that the
  evidence activated.
- **A green change skips the lifecycle review, and the pipeline's Review stands in.** Not taken. It
  changes the ship gate and ADR-0012, which says the pipeline runs unmodified and unskipped. The
  owner can decide it later with shadow data.

## Consequences and limits

- No live eval evidence exists for any depth. No eval runs under this decision.
- Shadow mode is the first evidence. It records the depth that routing would seat on real work,
  while the panel stays as it is today.
- Turning routing on for a project is a project-record change by the owner, after shadow.
- This record and its ruling change no behavior. Until later changes read `pass_1.depth`, the first
  pass selects as before.
