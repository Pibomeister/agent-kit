# ADR-0012 — no-mistakes delivery ends super-ship at handoff

Accepted risk, as the approved specification states it:

> changes the pipeline makes after its own Review step (its test, document, lint and ci fix commits, and CI-monitor rebases including conflict resolutions) have no reviewer, neither the lifecycle's nor the pipeline's; they ship on verify at the pushed head and the pipeline's CI alone, and a CI-monitor rebase after the worker reports done ships without even that verify.

**Status:** Accepted. Supersedes ADR-0002 §1 and the earlier content of ruling
`no-mistakes-as-ship-transport`.
**Date:** 2026-10-07.
**Authority:** Approved no-mistakes integration specification, Design A (“judge, hand off, adopt”);
ruling `no-mistakes-as-ship-transport`.

## Context

Under no-mistakes delivery, two systems inspect the same change. agent-kit records lifecycle
judgment at a committed handoff head. no-mistakes performs its own Review, tests, document and lint
checks, possible fixes, push, pull request and CI. Its Review may challenge a lifecycle-approved
decision. Disabling that Review, its fixes or its rebase would change the pipeline's contract.

## Decision

agent-kit owns judgment through an immutable handoff head. The worker commits before verify,
review-readiness and the full or delta review, records all three at that commit with the review
approved, and records ship-preflight at the same head with an
empty working-tree diff. Under no-mistakes delivery super-ship stops there: it does not push, open a
pull request or pass `--skip`. No `auto_fix` value is a precondition. no-mistakes then owns the branch
unmodified and unskipped. A parked gate is answered inside that pipeline. An ask-user finding,
including a challenge to a lifecycle-approved decision, goes to the supervisor as an ordinary
needs-decision. The pipeline's `--intent` contains only the captain's words.

After no-mistakes reports checks passed, agent-kit adopts the pipeline's attributed changes and
re-runs verification at the pushed head. It does not redo review. An `unreviewed` commit, a `missing`
handoff commit or an overridden Review step escalates to the supervisor as needs-decision. A run on
a replaced branch is identified by the existing `--run <run>` selector.

## Accepted costs and limits

- The pipeline attestation, commit subjects and subject-based pairings are worker-attested claims.
  A forged pipeline subject can be adopted as what it claims. Gate records and receipts written by
  the same-user worker remain worker-attested; their storage location adds no independent authority.
- The change receives both lifecycle review and no-mistakes Review. Their judgments may disagree;
  no-mistakes keeps its right to challenge.
- A no-mistakes Review approved after parking with unverified files attests `completed`. Adoption
  cannot infer the missing verification from that status.
- Adoption can honestly escalate when a rebase drops a commit that only bumps a version. The bound
  phase estimated this from recorded runs: https://github.com/Pibomeister/agent-kit/pull/119 had
  version-only commit `5b913169` absent from pushed head `bfaae06c`, and
  https://github.com/Pibomeister/agent-kit/pull/126 had a rebase drop version-only commit `b0104efa`.
  This is an estimate, not a general rate.
- The opening sentence names the review gap accepted for pipeline changes after Review and for
  CI-monitor rebases after the worker reports done. Attribution failure escalates instead of
  silently adopting an unknown change.

The patched Firstmate binding and its skip transport remain available only as a deprecated legacy
path for delivery mode `agent-kit`; they are no longer the default path. ADR-0002 §1 describes that
legacy design and is superseded for no-mistakes delivery.
