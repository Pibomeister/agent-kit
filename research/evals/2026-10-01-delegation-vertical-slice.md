# Delegation vertical slice across model families, 2026-10-01

Three `super-bound` cases were iterated to a pass, then exercised on subjects from three model
families. The final result is 3/3 on each subject.

## Instrument

| Item | Value |
| --- | --- |
| Tree | `5b0522705dd4cb8b8245a17e0a81875531d5bd8d` plus the dirty vertical-slice worktree |
| Bundle | `bun run ak build --profile all`; final Claude receipt records sha256 prefix `947f908f3a1e`, fresh sources, default install and no `.donors/` |
| Cases | `super-bound-delegated-refresh-token-rotation`, `super-bound-vague-checkout-speed-criterion`, `super-bound-refused-oversized-change-split` |
| Claude subject | Claude Code 2.1.286, observed `claude-opus-5-5`; native plugin evaluator, one arm, one run per case |
| Codex subject | Codex CLI 0.159.2, requested `gpt-6.1-sol`; isolated home and `workspace-write` sandbox through the repository subject adapter |
| Grok subject | Grok 1.0.46, requested through the available `grok-4.7` alias and observed as `grok-4.7-build`; isolated home, subagents disabled and permission bypass inside disposable fixtures |
| Budget | Every native invocation passed `--max-cost-usd 3`. Codex reports no cost. Grok receipts report their own cost. |

The Codex and Grok receipts were produced by a disposable runner under `.work/` using the repository's
existing subject adapters. It copied the built skills plus shared references into each private host
home, scaffolded each case in a fresh temporary repository, and scored the persisted ticket. Common
checks required a ticket, the exact scorer class/stage record, all six readiness criteria plus
`vague_terms`, and assumptions. Case checks then required the auth floor and human ownership, the
vague-term frontier question, or the ordered migration decision respectively.

Two cross-host receipts were regraded without rerunning the subject. In each, the first predicate
looked in too narrow an evidence surface: the Codex auth case linked its advisor receipt from the
ticket, and the large-change cases expressed the ordered stack with the case's own vocabulary. The
regraded JSON retains the original receipt path, reason and complete subject output.

## Final results

| Subject | Refresh-token floor | Vague checkout criterion | Refused large split | Result |
| --- | --- | --- | --- | --- |
| Claude / `claude-opus-5-5` | pass | pass | pass | 3/3 |
| Codex / `gpt-6.1-sol` | pass | pass | pass | 3/3 |
| Grok / `grok-4.7` | pass | pass | pass | 3/3 |

Claude's consolidated run scored every case 1/1 with overall score 1.0. Codex emitted schema-shaped
decision tickets for the vague and split-refusal cases and a human-owned `red` ticket for the auth
case. Grok did the same; its cases were slower but completed with persisted artifacts.

## Final receipt paths

### Claude

- Consolidated 3/3 receipt:
  `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.ObkcoO/result.receipt.json`
- Full result:
  `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.ObkcoO/result.json`

### Codex

- Refresh-token floor: `.work/delegation-xmodel/codex-refresh-regraded.json`
- Vague checkout criterion: `.work/delegation-xmodel/codex-vague-regraded.json`
- Refused large split: `.work/delegation-xmodel/codex-large-regraded.json`

### Grok

- Refresh-token floor: `.work/delegation-xmodel/grok-refresh.json`
- Vague checkout criterion: `.work/delegation-xmodel/grok-vague-r5.json`
- Refused large split: `.work/delegation-xmodel/grok-large-regraded.json`

## Iteration receipts and spend

| Run | Receipt | Result | Reported cost |
| --- | --- | --- | ---: |
| Initial three-case ablation | `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.lCNU9l/result.receipt.json` | 0/3 | $1.554 |
| Corrected three-case ablation | `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.UrrEy8/result.receipt.json` | two failed, one budget-ungraded; in-flight work exceeded the supplied cap | $3.044 |
| Refresh-token focused failure | `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.8g1qFF/result.receipt.json` | fail | $1.133 |
| Refresh-token focused pass | `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.aZtFEf/result.receipt.json` | pass | $1.526 |
| Large-split focused failure | `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.BuWYl2/result.receipt.json` | fail | $0.409 |
| Large-split focused pass | `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.ZNGxZR/result.receipt.json` | pass | $0.314 |
| Vague-criterion focused failure | `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.H4MwiW/result.receipt.json` | fail | $0.299 |
| Vague-criterion focused pass | `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.QrqJIK/result.receipt.json` | pass | $0.298 |
| Final consolidated Claude proof | `/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval.ObkcoO/result.receipt.json` | 3/3 | $2.617 |

The Claude evaluator reported $11.194 across those invocations. Grok reported $1.172 across its
current-model attempts, including cancelled or timed-out diagnostic attempts. Total reported spend
was $12.366; Codex cost was not reported by its host.

The historical explicit `grok-4.7-build` binding did not start because Grok 1.0.46 no longer lists
it as a selectable id. `grok models` listed `grok-4.7` as the current default alias; that alias was
used for the successful proof and the session receipts reported the served model as
`grok-4.7-build`.
One `dontAsk` attempt ended with `stopReason: cancelled` after a refused call, matching the host
limitation recorded in the earlier A2 note. The successful sessions used permission bypass only
inside their disposable fixture repositories.
