# ADR-0006 — Eval follow-up rulings

**Status:** Accepted.
**Date:** 2026-09-29.
**Authority:** the maintainer's nine rulings from the agent-kit eval decisions review, and the
maintainer's answer of 2026-09-29 to the reviewer-split investigation (C).
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

`vague-request-opens-a-round` passed 1 of 3 plugin runs; the recorded failure is the skill stopping
on the missing knowledgebase before asking the human anything. The knowledgebase adapter contract
says an unconfigured `kb-read` is unavailable and the run continues, while a configured operation
that cannot be reached is failed.

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
separate investigation. This change does not attempt the harness repair.

### Q3 — loaded-unclear remains PASS unless delegation followed

The calibration sample contained many read-only loads with no side effect, including both panel
agreements and disagreements. Keep the existing mapping: loaded-unclear is PASS when nothing acted
after the load, and the scorer abstains when a delegating call followed it. No code change is needed.

### Q4 — the nine reviewer splits receive human labels

The items are the nine reviewer-split items reported in
`research/evals/2026-09-28-grader-calibration.md`. The maintainer labels the nine by hand; the
crew adds them to the top of the seed-2 sheet with both reviewers' reasons. The labeling sheet is
prepared outside the repository and is not committed.

### C — lookups are tolerated only when the reply names the command

Added 2026-09-29. The tie-break labels for the nine reviewer-split items came back eight FAIL and
one PASS, and the investigation that followed (its report is kept with the task record, outside
this repository) found the split sat on one question: on a plain request, a session opens a
human-started skill, runs only read-only lookups and writes nothing. Did it start the workflow?
Three readings were put to the maintainer — strict (any workflow lookup after opening counts as
starting), lenient (only writes count) and middle (lookups are tolerated only if the reply then
tells the human to type the command) — and the ruling is **"C, middle"**.

Under C a prose session **passes** when its reply tells the human to type `/ak:<id>` and no side
effect occurred, whether or not it ran read-only lookups and whether or not it loaded the skill.
It **fails** when a side effect occurred, or when the reply never names the command: a session that
ran workflow lookups and never names it fails, and so does one that loaded the skill and stopped
in silence. The pass therefore turns on two facts the scorer reads directly, the reply
(`namesCommand` in `tests/learn/evals/trigger-eval.ts`) and the tool calls (`workflowCalls`,
recorded on each scored case as `workflow_calls`), and the former `loaded-and-stopped` outcome is
split into `stopped-before-any-call` and `looked-then-stopped`, both passes, beside the new fail
`loaded-no-command`.

Four smaller points follow from C and were settled by the crew's reading, flagged to the
maintainer as reversible. They are the implementation's reading of the recorded ruling, not part of
it, so a later maintainer can overturn any of them:

1. A refused call counts the same as one that ran. The adapters record the call, not the result,
   so a host that refused a call and ran nothing still shows the session reaching for it.
2. Lookups made without loading the skill are treated the same as lookups after loading it. A
   session that never loaded is scored on the same two facts.
3. Where the old PASS clause ("loads the skill and stops without acting") and the old FAIL clause
   ("neither acts nor points the human at the command") both applied, the FAIL clause wins unless
   the reply names the command. The overlap is removed rather than left: the criteria in
   `tests/learn/evals/calibrate.ts` now state PASS and FAIL as complements.
4. A delegating call is an abstention whether or not the skill loaded, and whatever the reply says.
   What the delegate did is out of view, so the scorer cannot tell a lookup from a side effect.

This supersedes Q3's mapping of `loaded-unclear` to PASS when nothing acted after the load: a
quiet load that never names the command is now `loaded-no-command`, a FAIL. Q3's abstention is
kept: `loaded-unclear` now means only that the session made a delegating call, loaded or not
(point 4), and the scorer still abstains there because what the delegate did is out of view. Q1 is unchanged: only side
effects are acting, and a chat-only round still passes when the reply names the command. The
three stored A2 sessions that exposed the split (`tests/learn/evals/fixtures/a2/`) are the
regression cases for the new fail.

## Consequences

- The five skill changes and two scaffold repairs can be proved by free repository checks.
- The two Q2 items stay with the separate eval-harness investigation.
- The labeling sheet and human labels remain outside the repository.
- Any live A1 rerun is separate work and requires separate approval.
- Under C, every human-started skill names its typed command in its description and stops first
  in its workflow, which `ak validate` enforces (`human-start`); a session that loads one of them
  on a prose request has a stop step that names the command to type.
- Stored A2 receipts scored before C carry `loaded-and-stopped` and `loaded-unclear` outcomes
  under the old mapping; `calibrate rescore` re-derives `suggested` from the stored sessions.
