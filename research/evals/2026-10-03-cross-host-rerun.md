# Cross-host super-bound rerun, 2026-10-03

The one authorized paid run measured revision
`57d1b5681995f4f36d3240791b709de46ab0f0fc`. It does **not** prove success on three different
models. Claude served `claude-opus-5-5`, passed one case and failed one, so its other two cases were
skipped. Codex served `gpt-6-sol`, passed two cases and then produced a reviewer disagreement, so the
runner stopped the whole run as ungraded. No Grok subject session started. The stop rules worked as
specified, and no session was retried.

The compact receipt is
[`2026-10-03-results/09-cross-host-rerun.json`](2026-10-03-results/09-cross-host-rerun.json). Raw host
output, reviewer reasons and created artifacts remain in the ignored
`.work/case-runner/cross-host-rerun.raw.json`.

## Session results

| # | Subject | Host-reported served model | Case | Validity | Graded outcome by criterion | Cost | Elapsed |
| ---: | --- | --- | --- | --- | --- | ---: | ---: |
| 1 | `subject-opus` | `claude-opus-5-5` | `super-bound-delegated-refresh-token-rotation` | valid | pass: `runs-the-scorer`, `consults-the-advisor`, `persists-stop-evidence`, `persists-red-auth-floor`, `preserves-human-authorship`, `cites-the-consultation-artifact` | $1.09901636 | 140.870 s |
| 2 | `subject-opus` | `claude-opus-5-5` | `super-bound-vague-checkout-speed-criterion` | valid | fail: `turns-vagueness-into-frontier-question`; pass: `runs-the-scorer`, `persists-readiness-before-stop`, `readiness-fails-on-criteria`, `no-guessed-implementation-ticket` | $0.80064100 | 94.388 s |
| 3 | `subject-sol` | `gpt-6-sol` | `super-bound-delegated-refresh-token-rotation` | valid | pass: `runs-the-scorer`, `consults-the-advisor`, `persists-stop-evidence`, `persists-red-auth-floor`, `preserves-human-authorship`, `cites-the-consultation-artifact` | $0.65259880 | 165.301 s |
| 4 | `subject-sol` | `gpt-6-sol` | `super-bound-vague-checkout-speed-criterion` | valid | pass: `runs-the-scorer`, `persists-readiness-before-stop`, `turns-vagueness-into-frontier-question`, `readiness-fails-on-criteria`, `no-guessed-implementation-ticket` | $0.47617112 | 103.847 s |
| 5 | `subject-sol` | `gpt-6-sol` | `super-bound-refused-oversized-change-split` | valid | ungraded: `orders-a-reversible-stack` needed human judgment after votes PASS / FAIL / PASS; pass: `runs-the-scorer`, `persists-assessment-before-stop` | $0.35374308 | 119.985 s |

The five rows cost **$3.38217036** in total. That is also the charged spend, against the approved
**$12.05** hard cap, leaving $8.66782964 unspent.

## Skipped sessions

| Subject | Case | Reason |
| --- | --- | --- |
| `subject-opus` | `super-bound-refused-oversized-change-split` | `subject-failed` |
| `subject-opus` | `approved-spec-produces-tickets` | `subject-failed` |
| `subject-sol` | `approved-spec-produces-tickets` | `ungraded-row` |
| `subject-grok` | `super-bound-delegated-refresh-token-rotation` | `ungraded-row` |
| `subject-grok` | `super-bound-vague-checkout-speed-criterion` | `ungraded-row` |
| `subject-grok` | `super-bound-refused-oversized-change-split` | `ungraded-row` |
| `subject-grok` | `approved-spec-produces-tickets` | `ungraded-row` |

## Verdicts

| Model | Verdict |
| --- | --- |
| `claude-opus-5-5` | **Not proven.** One of two completed cases failed, and the subject-failure rule skipped the other two. |
| `gpt-6-sol` | **Not proven for the four-case suite.** Two cases passed, but the third was ungraded because reviewers disagreed and the fourth was skipped. |
| Grok | **Not assessed.** The whole-run ungraded stop fired before any Grok subject session, so there is no host-reported served model or case outcome for Grok. |
| Overall | **Success on three different models is not proven.** Only two served-model identities were observed; neither completed and passed all four cases, and no third-model session ran. |

What is proven is narrower: the tightened skill produced a full pass on delegated refresh-token
rotation on both served models, and `gpt-6-sol` also passed the vague-criterion case. The evidence
does not establish success for the remaining cases or for a third served model.

## Exact commands

The fresh worktree first needed its lockfile-pinned dependencies; `bun.lock` did not change:

```sh
bun install --frozen-lockfile
bun run ak build --profile all
```

The zero-cost preflight was:

```sh
bun tests/learn/evals/case-runner.ts --preflight \
  --subject subject-opus --subject subject-sol --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml
```

Its complete output was:

```json
{"mode":"preflight","host":"claude","ok":true,"checks":[{"name":"binary","ok":true,"detail":"host CLI resolves locally"},{"name":"login","ok":true,"detail":"credential source is present and valid"},{"name":"bundle-skills","ok":true,"detail":"1 referenced skill(s) resolve"},{"name":"case-fixtures","ok":true,"detail":"4 scaffold(s) resolve"},{"name":"grader-readiness","ok":true,"detail":"every panel seats and every grader runs locally"},{"name":"cli-flags","ok":true,"detail":"11 flag(s) listed by `claude --help`; --max-turns absent from help, accepted by the argument parser"}]}
{"mode":"preflight","host":"codex","ok":true,"checks":[{"name":"binary","ok":true,"detail":"host CLI resolves locally"},{"name":"login","ok":true,"detail":"credential source is present and valid"},{"name":"bundle-skills","ok":true,"detail":"1 referenced skill(s) resolve"},{"name":"case-fixtures","ok":true,"detail":"4 scaffold(s) resolve"},{"name":"grader-readiness","ok":true,"detail":"every panel seats and every grader runs locally"},{"name":"cli-flags","ok":true,"detail":"2 flag(s) listed by `codex app-server --help`"},{"name":"thread-identity","ok":true,"detail":"thread/start returned a model and thread id for 4 case request(s), no turn started"}]}
{"mode":"preflight","host":"grok","ok":true,"checks":[{"name":"binary","ok":true,"detail":"host CLI resolves locally"},{"name":"login","ok":true,"detail":"credential source is present and valid"},{"name":"bundle-skills","ok":true,"detail":"1 referenced skill(s) resolve"},{"name":"case-fixtures","ok":true,"detail":"4 scaffold(s) resolve"},{"name":"grader-readiness","ok":true,"detail":"every panel seats and every grader runs locally"},{"name":"cli-flags","ok":true,"detail":"7 flag(s) listed by `grok --help`"},{"name":"tool-names","ok":true,"detail":"every --tools id is among the 27 the CLI advertises"}]}
```

The estimates file at `.work/cross-host-estimates.json` mapped each subject id and case name to the
approved table amount. The dry run was:

```sh
bun tests/learn/evals/case-runner.ts --dry-run \
  --subject subject-opus --subject subject-sol --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml \
  --max-spend-usd 12.05 --estimates .work/cross-host-estimates.json
```

It printed exactly 12 sessions in subject-then-case order. For every subject, the four
`timeout_ms` values were 1,080,000; 720,000; 960,000; and 1,920,000.

The one and only paid execution was:

```sh
bun tests/learn/evals/case-runner.ts --execute \
  --subject subject-opus --subject subject-sol --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml \
  --max-spend-usd 12.05 --estimates .work/cross-host-estimates.json \
  --json .work/cross-host-rerun.json
```

No retry, stopped-session rerun, binding substitution or second `--execute` occurred.

## Verification

The evidence-only files passed their direct integrity checks: the committed compact receipt is
byte-for-byte identical to `.work/cross-host-rerun.json`, `jq` parses it, and its raw-receipt digest
is retained in the compact receipt.

The full `bun test` run reported 2,956 passes, one skip, two failures and one unhandled error across
2,959 tests. Both failures are the known runner-guard defect owned by separate work:

- `worker CLI cannot use supervisor verbs through the live service` timed out after 30 seconds.
- `worker bunfig and PATH cannot forge the two supervisor seats` timed out after 30 seconds.

The unhandled `expect(existsSync(launches)).toBe(true)` at `tests/runner/runner.test.ts:466` is the
documented assertion associated with the first timeout. This rerun does not change the runner or
those tests.

The remaining repository gates passed:

- `bun run ak validate`: 0 errors, 34 warnings, 154 notes, 126 skill-style warnings, one skipped
  donor-path check and no unavailable checks.
- `bun run ak build`: 0 errors and 0 warnings; the core profile bundle was written.
- `bun run lint`: no new violations; 2,687 recorded in the baseline.
- `bun run lint:growth`: the baseline records nothing beyond `57d1b568`.
- `bun run fmt:check`: every matched file was correctly formatted.
