# Cross-host delegation case-run plan, 2026-10-02

The committed runner is `tests/learn/evals/case-runner.ts`. It loads the named `case.yaml`, creates
its scaffold, starts the selected subject through the existing adapter, applies the case's grader
objects without rewriting them, and writes one receipt. `--dry-run` prints the subject, case,
effective cap, timeout, grant and exact host argv without starting a host or reviewer.

No live session described here has run. The two target subjects are the Codex-host `subject-sol` and
the Grok-host `subject-grok` bindings used by the prior cross-host records. Together with the Claude
receipt already committed by the delegation slice, successful receipts would cover three distinct
subjects. The live receipts must retain each host's reported served binding before that claim is
made.

PR #62 split the former `approved-direction-produces-spec-and-tickets` case into a review-decision
stop and a later approved-specification slicing case. The fourth command below uses the current
`approved-spec-produces-tickets` case: it is the successor that exercises spec-to-ticket slicing.
The three other commands are the cases tagged `delegation-vertical-slice` on the current tree.

## Commands

Build the all-profile bundle and bind `.work/eval-matrix.yaml` before obtaining fresh approval for
paid execution. This dry run lists all eight planned sessions and starts none:

```sh
bun tests/learn/evals/case-runner.ts --dry-run \
  --subject subject-sol --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml
```

After fresh approval, the eight live commands are:

```sh
bun tests/learn/evals/case-runner.ts --execute --subject subject-sol \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --json .work/cross-host-cases/subject-sol/delegated-refresh-token-rotation.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-sol \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --json .work/cross-host-cases/subject-sol/vague-checkout-speed-criterion.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-sol \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --json .work/cross-host-cases/subject-sol/refused-oversized-change-split.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-sol \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml \
  --json .work/cross-host-cases/subject-sol/approved-spec-produces-tickets.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --json .work/cross-host-cases/subject-grok/delegated-refresh-token-rotation.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-grok \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --json .work/cross-host-cases/subject-grok/vague-checkout-speed-criterion.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-grok \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --json .work/cross-host-cases/subject-grok/refused-oversized-change-split.json

bun tests/learn/evals/case-runner.ts --execute --subject subject-grok \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml \
  --json .work/cross-host-cases/subject-grok/approved-spec-produces-tickets.json
```

## Expected spend

The only committed full-case measurements for these graders are the Claude run in
`research/evals/2026-10-01-results/claude-five-case.json`. Its per-case cost includes the subject
and paid grader work, so it is the closest reproducible estimate for one runner command. No
committed Codex or Grok receipt has yet run these case-file graders; the same estimate is therefore
used for each target subject rather than inventing a host multiplier.

| Case | Recorded comparable cost | Codex expected | Grok expected |
| --- | ---: | ---: | ---: |
| `super-bound-delegated-refresh-token-rotation` | $1.8451152 | $1.8451152 | $1.8451152 |
| `super-bound-vague-checkout-speed-criterion` | $0.3805600 | $0.3805600 | $0.3805600 |
| `super-bound-refused-oversized-change-split` | $0.3535800 | $0.3535800 | $0.3535800 |
| `approved-spec-produces-tickets` | $1.2404326 | $1.2404326 | $1.2404326 |
| Per subject | $3.8196878 | $3.8196878 | $3.8196878 |

Expected total for eight commands: **$7.6393756**. This is an estimate, not a ceiling: the runner
uses the matrix's independent reviewer panel, and host length, cache use and reported pricing can
change the actual spend.

## Known obstacle

`research/evals/2026-10-02-grok-smoke-3.md` records the quiet-machine rerun at `eb96dfd`: all three
ordinary Grok sessions finished before timeout but were invalid because the host refused and
cancelled a call. The refused calls included Grep, Bash `env`, and a read-only Bash inspection
chain. The three sessions cost $0.39468084. A separate repair is in progress; until it lands, a
Grok receipt from the commands above may be invalid and will be kept under `invalid_sessions`, not
counted as a case result.
