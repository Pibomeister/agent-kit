# Delegation vertical slice evaluation, 2026-10-01

The committed Claude receipt records one authorized run of the five current `super-bound` cases at
revision `7f21baedb1c43c334173b3556f6d6147205ed6fa`. The run produced two passes, two failures, and
one ungraded case. It does not satisfy the vertical slice's pass criterion.

## Cases and results

| Case | Result | Evidence |
| --- | --- | --- |
| Refresh-token floor | pass | The scorer ran; the red authentication floor, human authorship, and advisor citation were persisted. |
| Vague checkout criterion | pass | Readiness failed by named criteria and the vague language became frontier questions. |
| Refused large split | fail | The subject wrote a decision ticket instead of the required ordered stack or an accepted zero-context stop shape. |
| Approved direction, stop at decisions | fail | The review returned open decisions, but two implementation tickets were written before those decisions were resolved. |
| Approved specification, produce tickets | ungraded | The scorer ran, but the three paid graders were skipped at the cost ceiling. |

The compact receipt is
[`2026-10-01-results/claude-five-case.json`](2026-10-01-results/claude-five-case.json). It names the
measured revision, bundle digest, host, isolation method, per-case grader outcomes, and spend. The
runner exited 1. Its reported cost was $6.632 against a $6 cap; in-flight work completed after the
remaining group budget was allocated. No rerun or case iteration followed.

## Spend

The committed [spend ledger](2026-10-01-results/spend.json) records:

| Runs | Reported cost |
| --- | ---: |
| Earlier iterations and the withdrawn cross-family run | $12.366 |
| Manual Claude run at `1d6d53f1` | $3.750 |
| Five-case Claude run at `7f21baedb1c43c334173b3556f6d6147205ed6fa` | $6.632 |
| Cumulative reported spend | $22.748 |

Earlier Codex attempts did not report host cost, so that amount is not included.

## Evidence boundary

The earlier Claude, Codex, and Grok 3/3 claim is withdrawn because it did not use committed graders
on a committed tree. This note relies only on the committed receipt summary above. Codex and Grok
remain unproven for these case-file graders and are deferred to a follow-up committed runner task.

The current scaffolds create scorer output inside their fixture setup; the former claim that a
scorer stub depended on an external `TMPDIR` path no longer describes these cases.

## Out of scope

- The independent-oracle requirement for unreviewed work is deferred to `protocols/tdd`, which this
  slice names out of scope. The delegation reference and `super-bound` do not restate it (ruling
  `unreviewed-work-needs-independent-oracle`).
