# Cross-host super-bound rerun 2, 2026-10-04

The one authorized paid run measured revision
`011be5ef497fc0d9f70aef8b177f255fee202402`. It does **not** prove success on three different
models. Claude served `claude-opus-5-5`, but its first case ended ungraded after the two eligible
reviewers split one-to-one. The whole-run ungraded stop then skipped the remaining eleven sessions,
so no Sol or Grok subject session started. No session was retried and no binding was substituted.

The compact receipt is
[`2026-10-04-results/cross-host-rerun-2.json`](2026-10-04-results/cross-host-rerun-2.json). It is
byte-for-byte identical to `.work/cross-host-rerun-2.json` at SHA-256
`dfa68f9949f46564b0ebed48f0e742ba319a2b6415e918522f46eb286c245992`. Raw host output, reviewer
reasons and created artifacts remain in the ignored
`.work/case-runner/cross-host-rerun-2.raw.json`.

## Session result

| Subject | Host-reported served model | Case | Validity | Graded outcome by criterion | Cost | Elapsed |
| --- | --- | --- | --- | --- | ---: | ---: |
| `subject-opus` | `claude-opus-5-5` | `super-bound-delegated-refresh-token-rotation` | valid | pass: `runs-the-scorer`, `consults-the-advisor`; ungraded: `persists-stop-evidence` after votes `reviewer-sol: FAIL` / `reviewer-grok: PASS`; not judged because the row was already ungraded: `persists-red-auth-floor`, `preserves-human-authorship`, `cites-the-consultation-artifact` | $1.33030884 | 271.902 s |

The reviewer split was recorded in both the compact and raw receipts. It was a one-to-one tie, not
a strict majority: Sol said the transcript did not establish that the ticket JSON was persisted at
the required path, while Grok found the required scorer output, evidence, assumptions and human
owner in the ticket. The grader therefore retained `needs-human` with reason `reviewers disagree`,
and the runner correctly treated the row as ungraded.

## Skipped sessions

Every skipped row has reason `ungraded-row`.

| Subject | Case |
| --- | --- |
| `subject-opus` | `super-bound-vague-checkout-speed-criterion` |
| `subject-opus` | `super-bound-refused-oversized-change-split` |
| `subject-opus` | `approved-spec-produces-tickets` |
| `subject-sol` | `super-bound-delegated-refresh-token-rotation` |
| `subject-sol` | `super-bound-vague-checkout-speed-criterion` |
| `subject-sol` | `super-bound-refused-oversized-change-split` |
| `subject-sol` | `approved-spec-produces-tickets` |
| `subject-grok` | `super-bound-delegated-refresh-token-rotation` |
| `subject-grok` | `super-bound-vague-checkout-speed-criterion` |
| `subject-grok` | `super-bound-refused-oversized-change-split` |
| `subject-grok` | `approved-spec-produces-tickets` |

The single completed session charged **$1.33030884** against the **$12.05** hard cap, leaving
**$10.71969116** unspent.

## Verdicts

| Model | Verdict |
| --- | --- |
| `claude-opus-5-5` | **Not proven.** Its first case was valid but ungraded after a one-to-one reviewer tie; its other three cases were skipped. |
| `gpt-6-sol` | **Not assessed.** The whole-run ungraded stop fired before any Sol subject session. |
| `grok-4.7` | **Not assessed.** The whole-run ungraded stop fired before any Grok subject session. |
| Overall | **Success on three different models is not proven.** Only one served-model identity was observed, no model completed the four-case suite, and no case received a graded pass or fail. |

The run proves only that the revised harness preserved a tied panel as ungraded and stopped without
overspending or silently choosing a winner. It does not prove the vague-target behavior, the
two-to-one majority behavior, the remaining three cases, or success on Sol or Grok.

## Exact commands

The fresh worktree first installed its lockfile-pinned dependencies. The SHA-256 of `bun.lock` was
`b332db1c982cb8d299ab8d80cb8fde19c7e1f16cd2487ee11a54dd007c6f9ece` both before and after the
install.

```sh
bun install --frozen-lockfile
bun run ak build --profile all
```

The build completed with zero errors, warnings, notes, skill-style warnings, skipped checks and
unavailable checks. The zero-cost preflight was:

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

The estimates file at `.work/cross-host-estimates.json` mapped every selected subject id and case
name to the approved estimate table amount. The dry run was:

```sh
bun tests/learn/evals/case-runner.ts --dry-run \
  --subject subject-opus --subject subject-sol --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml \
  --max-spend-usd 12.05 --estimates .work/cross-host-estimates.json
```

It printed exactly twelve sessions in subject-then-case order. For every subject, the four
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
  --json .work/cross-host-rerun-2.json
```

No retry, stopped-session rerun, binding substitution or second `--execute` occurred.

## Verification

The committed compact receipt is byte-for-byte identical to the runner output, `jq` parses it, its
revision is the measured revision, its charged spend is $1.33030884, and its skipped list has eleven
rows. The repository gates then reported:

- `bun test`: 2,973 passes, one expected donor-snapshot skip and zero failures across 2,974 tests.
- `bun run ak validate`: zero errors, 34 warnings, 154 notes, 126 skill-style warnings, one skipped
  donor-path check and no unavailable checks.
- `bun run ak build`: zero errors and zero warnings; the core profile bundle was written.
- `bun run lint`: no new violations; 2,687 recorded in the baseline.
- `bun run lint:growth`: the baseline records nothing beyond `011be5ef`.
- `bun run fmt:check`: every matched file was correctly formatted.
