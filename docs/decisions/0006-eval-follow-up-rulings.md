# ADR-0006 — Eval follow-up rulings

**Status:** Accepted.
**Date:** 2026-09-29.
**Authority:** the maintainer's nine rulings from the agent-kit eval decisions review.
**Evidence read:** `research/evals/2026-09-28-a1-rerun.md`,
`research/evals/2026-09-28-a2-cross-model.md`, and
`research/evals/2026-09-28-grader-calibration.md`.

## Context

The stored A1 results exposed five skill or case defects. The grader-calibration review left four
criteria questions open. These decisions repair only those identified surfaces. They authorize no
live or paid run, do not change the invocation classes, and leave ADR-0005 Proposed.

## Decisions

### F1 — doc-review always presents four buckets

`drafted-spec-gets-a-panel` loaded the skill in all three plugin runs but passed none. The replies
used a separate blockers section and omitted an empty Applied bucket, because the prior contract
named the buckets without fixing the presented form.

The result now has one verdict line followed by Applied, Proposed fixes, Decisions and FYI, in that
order, with every heading present even when empty. Blocking findings belong under Decisions;
`blocked` is a verdict, not another bucket.

### F2 — diagnose is loop-first, including cap prompts

`bug-with-repro-gets-a-cause` loaded in all three plugin runs and passed none: the replies read a
cause from code before reporting the red loop. Its deterministic order check named `Write`, while
the observed fix used `Edit`. `third-failed-fix-stops-the-run` ran in an empty workspace and never
loaded the skill.

The description includes repeated-fix failures; the candidate red command is the first tool call;
the report follows the workflow's evidence order; the order check recognizes `Edit`; and the cap
case receives a repository plus a record of all three failed attempts.

### F3 — super-align separates unavailable from failed context

In `vague-request-opens-a-round`, one run treated an unconfigured knowledgebase as unreachable and
stopped before asking a question. The knowledgebase adapter contract says an unconfigured
`kb-read` is unavailable and the run continues, while a configured operation that cannot be reached
is failed.

An unavailable adapter is now a coverage limitation: the interview continues through restatement,
then publication stops with `needs-input` naming `kb-read` and `kb-write`. A configured operation
failure remains `failed`. Empty context still continues as a fact.

### F4 — wayfind cannot accept a session-only map

All three plugin runs of `no-system-of-record-stops-before-charting` accepted the promise that the
human would copy the map out later. The requirement existed only in the input ladder, so pressure
could waive it.

The requirement is a hard gate. A human waiver is not a system of record. With neither durable
backend available, the run stops before charting with `needs-input` naming `tracker-access` and
`kb-write`; the rationalization is called out explicitly.

### F5 — super-scout opens on person-facing questions

Across the stored A1 cases that carried a load indicator, super-scout loaded zero times. Its
description led with the dossier artifact and a later-lane use rather than the questions people
actually ask. The negative case also ran in an empty workspace and refused for the wrong reason.

The description now opens with “where does this live?”, “what calls it?” and “which tests cover
it?” triggers while preserving the non-triggers. The unbounded negative receives a real repository
so it measures scope refusal. The invocation class does not change.

### Q1 — chat-only work is not acting

Calibration items `b490d138531b` and `371013d2a018` ran an alignment question round in the reply but
made no write or other side effect. Only side effects count as acting. A chat-only round that ends
before any write passes. The written A2 grading criteria now say this directly, and a focused test
protects the existing PASS result.

### Q2 — “not installed” is an eval-harness defect under investigation

Items `4f11203a580d` and `8ba34a5c3e1f` refused because the requested skill was reported as not
installed. This is not resolved by redefining redirect or miss. It is an eval-harness defect under
separate investigation. Until that investigation fixes and remeasures the items, exclude them from
agreement figures. This change does not attempt the harness repair.

### Q3 — loaded-unclear remains PASS unless delegation followed

The calibration sample contained many read-only loads with no side effect, including both panel
agreements and disagreements. Keep the existing mapping: loaded-unclear is PASS when nothing acted
after the load, and the scorer abstains when a delegating call followed it. No code change is needed.

### Q4 — the nine reviewer splits receive human labels

The split items are `96a9d27022dd`, `ca34dec5fa03`, `21c96c702c6f`, `42c946364500`,
`ce1583f612b9`, `64a492575a8c`, `5099b7934c71`, `777921fdc724`, and `d14f1a606abb`.
The maintainer will label them by hand. The working seed-2 sheet is prepared elsewhere with both
reviewers' reasons at the top; it is not committed here.

## Consequences

- The five skill changes and two scaffold repairs can be proved by free repository checks.
- No stored agreement figure may include the two Q2 items until the separate harness investigation
  resolves and remeasures them.
- The labeling sheet and human labels remain outside the repository.
- Any live A1 rerun is separate work and requires separate approval.
