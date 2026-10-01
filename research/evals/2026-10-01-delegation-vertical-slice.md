# Delegation vertical slice across model families, 2026-10-01

The delegation slice adds three adversarial `super-bound` cases and extends the positive one. This
note records what has been measured, what has not, and what it cost.

The short answer: **the cross-family proof is still owed.** No run has yet been graded by the
committed graders at a committed revision on all three families, so this note claims no pass.

## Cases

| Case | Path |
| --- | --- |
| Refresh-token floor | `evals/super-bound/delegated-refresh-token-rotation/case.yaml` |
| Vague checkout criterion | `evals/super-bound/vague-checkout-speed-criterion/case.yaml` |
| Refused large split | `evals/super-bound/refused-oversized-change-split/case.yaml` |
| Approved direction (extended) | `evals/super-bound/approved-direction-produces-spec-and-tickets/case.yaml` |

## What was measured, and why it is not a receipt

An earlier pass on this branch ran the three new cases on a Claude, a Codex and a Grok subject and
reported 3/3 on each. Those figures are withdrawn:

- The tree was `5b0522705dd4cb8b8245a17e0a81875531d5bd8d` plus uncommitted changes. Nobody can
  rebuild it.
- The Codex and Grok runs were scored by a throwaway runner with its own predicates, not by the
  graders in the case files. Two of its results were regraded without a rerun.
- The receipts sat in temporary and gitignored directories. None is committed.
- The fixtures have changed since. The advisor stub and the factor evidence no longer state the
  graded answer, the scorer output no longer sits in the repository the subject reads, and the
  advisor grader now reads the `kb_refs` citation.

## Spend

| Runs | Reported cost |
| --- | ---: |
| Earlier Claude-host iterations and the withdrawn consolidated run | $11.194 |
| Earlier Grok attempts, including cancelled and timed-out ones | $1.172 |
| Earlier Codex attempts | not reported by the host |
| Rerun authorized at an $8 cap | $0.000, not started |
| Cumulative | $12.366 |

## Why the rerun has not happened

The rerun was authorized for all four cases on Claude, Codex and Grok, against the committed
graders at the committed revision. It was not started, for three reasons:

1. **No committed revision yet.** The fixture and grader changes above ship in the same commit as
   this note. A receipt has to name the revision it measured, so the run comes after that commit.
2. **The case-grader path changes user state.** `scripts/eval-local.sh` is the repository's path
   for running a case file's graders. It moves `~/.docker/cli-plugins` and `~/.docker/bin` aside
   for the run, and its header says to run it only by hand. The gate step that made these changes
   may not touch files outside its worktree, and both directories exist on the operator's machine.
3. **Codex and Grok cannot execute the committed graders.** The cross-model path in
   `research/evals/2026-09-28-a2-cross-model.md` is `tests/learn/evals/trigger-eval.ts` with the
   subject adapters under `tests/learn/evals/subjects/`. It scores routing over a prompt set. It
   does not read a case file, run its scaffold, or evaluate `llm` and `tool_used` graders. Only
   the Claude host's plugin evaluator does that. This is why the earlier pass fell back to a
   throwaway runner.

## Follow-ups

- Run the four cases with `scripts/eval-local.sh` by hand at the commit that carries this note,
  and commit a compact receipt summary under `research/evals/` in the shape of
  `research/evals/2026-09-25-results/`.
- Decide how Codex and Grok get graded: either a repository runner that executes case-file graders
  on those hosts, or an accepted narrower proof. Until then the three-family criterion is open.
- One scaffold detail is unverified until a paid run: the scorer stub reads its output from a
  directory under `TMPDIR`, outside the workspace, and the eval sandbox has to allow that read.

## Out of scope

- The independent-oracle requirement for unreviewed work is deferred to `protocols/tdd`, which this
  slice names out of scope. The delegation reference and `super-bound` do not restate it (ruling
  `unreviewed-work-needs-independent-oracle`).
