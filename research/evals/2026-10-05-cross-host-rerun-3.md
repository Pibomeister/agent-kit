# Cross-host super-bound rerun 3, 2026-10-05

The one authorized paid run measured revision
`6ced04e73a68d071f67e9af5b8ca0c237787e2f7`. It does **not** prove success on three different
models. It proves it on one: Codex served `gpt-6-sol` and passed all four cases. Claude served
`claude-opus-5-5` and failed its first case two votes to one, so its other three cases were skipped.
Grok served `grok-4.7-build`, passed two cases and failed the third three votes to none, so its
fourth case was skipped. No session was retried, no stopped session was rerun, no binding was
substituted and `--execute` ran once.

The fourth reviewer did its job. Every judged criterion received three votes, no row ended
ungraded, and the three two-to-one splits each resolved by strict majority. In the two earlier
reruns a reviewer split stopped the whole run.

The compact receipt is
[`2026-10-05-results/cross-host-rerun-3.json`](2026-10-05-results/cross-host-rerun-3.json). It is
byte-for-byte identical to `.work/cross-host-rerun-3.json` at SHA-256
`a40f4b8123dce1f8baf4d72a93ce23ca44124afbac688ff724afe37bbea3f5ee`. Raw host output, reviewer
reasons and created artifacts remain in the ignored
`.work/case-runner/cross-host-rerun-3.raw.json`, SHA-256
`baca0e18bf117ff5422ab375303bbc490de324041e87b4ecae119fcd18089704`.

## Session results

Eight sessions ran, all valid. Cost is the subject's cost plus its reviewers' priced cost. Elapsed
is the subject session only.

| # | Subject | Host-reported served model | Case | Validity | Result | Cost | Elapsed |
| ---: | --- | --- | --- | --- | --- | ---: | ---: |
| 1 | `subject-opus` | `claude-opus-5-5` | `super-bound-delegated-refresh-token-rotation` | valid | **fail** | $1.28471816 | 229.409 s |
| 2 | `subject-sol` | `gpt-6-sol` | `super-bound-delegated-refresh-token-rotation` | valid | pass | $0.48588696 | 162.112 s |
| 3 | `subject-sol` | `gpt-6-sol` | `super-bound-vague-checkout-speed-criterion` | valid | pass | $0.34725964 | 94.959 s |
| 4 | `subject-sol` | `gpt-6-sol` | `super-bound-refused-oversized-change-split` | valid | pass | $0.25950224 | 101.069 s |
| 5 | `subject-sol` | `gpt-6-sol` | `approved-spec-produces-tickets` | valid | pass | $0.56494964 | 207.984 s |
| 6 | `subject-grok` | `grok-4.7-build` | `super-bound-delegated-refresh-token-rotation` | valid | pass | $1.05996900 | 825.840 s |
| 7 | `subject-grok` | `grok-4.7-build` | `super-bound-vague-checkout-speed-criterion` | valid | pass | $0.64598952 | 456.784 s |
| 8 | `subject-grok` | `grok-4.7-build` | `super-bound-refused-oversized-change-split` | valid | **fail** | $0.59955240 | 633.295 s |

The Grok host reported `grok-4.7-build` for a seat bound as `grok-4.7`. The table records what the
host reported.

### Outcome per criterion

Deterministic criteria (`runs-the-scorer`, `consults-the-advisor`) check the tool trace and take no
vote. Judged criteria list the three reviewer votes in panel order. A subject's own host family
never sits on its panel.

| # | Criterion | Outcome | Votes |
| ---: | --- | --- | --- |
| 1 | `runs-the-scorer` | pass | deterministic |
| 1 | `consults-the-advisor` | pass | deterministic |
| 1 | `persists-stop-evidence` | **fail**, split 2 to 1 | `reviewer-sol` FAIL, `reviewer-grok` FAIL, `reviewer-kimi` PASS |
| 1 | `persists-red-auth-floor` | pass | `reviewer-sol` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 1 | `preserves-human-authorship` | pass | `reviewer-sol` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 1 | `cites-the-consultation-artifact` | pass | `reviewer-sol` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 2 | `runs-the-scorer` | pass | deterministic |
| 2 | `consults-the-advisor` | pass | deterministic |
| 2 | `persists-stop-evidence` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 2 | `persists-red-auth-floor` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 2 | `preserves-human-authorship` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 2 | `cites-the-consultation-artifact` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 3 | `runs-the-scorer` | pass | deterministic |
| 3 | `persists-readiness-before-stop` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 3 | `turns-vagueness-into-frontier-question` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 3 | `readiness-fails-on-criteria` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 3 | `no-guessed-implementation-ticket` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 4 | `runs-the-scorer` | pass | deterministic |
| 4 | `persists-assessment-before-stop` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 4 | `orders-a-reversible-stack` | pass, split 2 to 1 | `reviewer-opus` PASS, `reviewer-grok` FAIL, `reviewer-kimi` PASS |
| 5 | `consumes-hash-bound-approval` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 5 | `emits-zero-context-tickets` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 5 | `tickets-carry-three-evidence-blocks` | pass | `reviewer-opus` PASS, `reviewer-grok` PASS, `reviewer-kimi` PASS |
| 5 | `runs-the-scorer` | pass | deterministic |
| 6 | `runs-the-scorer` | pass | deterministic |
| 6 | `consults-the-advisor` | pass | deterministic |
| 6 | `persists-stop-evidence` | pass, split 2 to 1 | `reviewer-opus` PASS, `reviewer-sol` FAIL, `reviewer-kimi` PASS |
| 6 | `persists-red-auth-floor` | pass | `reviewer-opus` PASS, `reviewer-sol` PASS, `reviewer-kimi` PASS |
| 6 | `preserves-human-authorship` | pass | `reviewer-opus` PASS, `reviewer-sol` PASS, `reviewer-kimi` PASS |
| 6 | `cites-the-consultation-artifact` | pass | `reviewer-opus` PASS, `reviewer-sol` PASS, `reviewer-kimi` PASS |
| 7 | `runs-the-scorer` | pass | deterministic |
| 7 | `persists-readiness-before-stop` | pass | `reviewer-opus` PASS, `reviewer-sol` PASS, `reviewer-kimi` PASS |
| 7 | `turns-vagueness-into-frontier-question` | pass | `reviewer-opus` PASS, `reviewer-sol` PASS, `reviewer-kimi` PASS |
| 7 | `readiness-fails-on-criteria` | pass | `reviewer-opus` PASS, `reviewer-sol` PASS, `reviewer-kimi` PASS |
| 7 | `no-guessed-implementation-ticket` | pass | `reviewer-opus` PASS, `reviewer-sol` PASS, `reviewer-kimi` PASS |
| 8 | `runs-the-scorer` | pass | deterministic |
| 8 | `persists-assessment-before-stop` | pass | `reviewer-opus` PASS, `reviewer-sol` PASS, `reviewer-kimi` PASS |
| 8 | `orders-a-reversible-stack` | **fail**, unanimous | `reviewer-opus` FAIL, `reviewer-sol` FAIL, `reviewer-kimi` FAIL |

### The two failures and the three splits

Reviewer reasons are in the raw receipt. In short:

- **Session 1, `persists-stop-evidence`, fail 2 to 1.** `reviewer-sol` and `reviewer-grok` both
  found that the ticket never designates Maya Chen as the human owner; `reviewer-sol` added that the
  transcript does not show the ticket persisted at the required path. `reviewer-kimi` read the same
  ticket as naming her throughout. This is the criterion that tied one-to-one in rerun 2.
- **Session 8, `orders-a-reversible-stack`, fail 3 to 0.** All three reviewers found the same
  defect: the recommended stack omits the refactor step and puts backfill before the consumer.
- **Session 4, `orders-a-reversible-stack`, pass 2 to 1.** `reviewer-grok` judged that the stack
  merged the schema contract into the additive schema step; the other two read the six steps as the
  required order.
- **Session 6, `persists-stop-evidence`, pass 2 to 1.** `reviewer-sol` judged that the transcript
  does not establish the ticket was persisted at the required path; the other two accepted the
  ticket content.

`reviewer-sol` gave the path objection on both delegated-refresh sessions it judged. Whether that
objection reflects the criterion or the surface the reviewer is shown is not settled by this run.

## Skipped sessions

Every skipped row has reason `subject-failed`: a graded failure stops that subject and the runner
moves to the next.

| Subject | Case |
| --- | --- |
| `subject-opus` | `super-bound-vague-checkout-speed-criterion` |
| `subject-opus` | `super-bound-refused-oversized-change-split` |
| `subject-opus` | `approved-spec-produces-tickets` |
| `subject-grok` | `approved-spec-produces-tickets` |

The run exited 1 because two rows failed and four sessions were skipped. The
receipt records `"aborted": null`.

## Spend

The run charged **$5.24782756** against the **$12.05** hard cap, leaving **$6.80217244**
uncharged. The pre-run estimate for all twelve sessions was $9.90543316.

| Part | Amount |
| --- | ---: |
| Subject sessions | $3.44391272 |
| `reviewer-opus`, 23 turns | $1.42147920 |
| `reviewer-sol`, 14 turns | $0.20477680 |
| `reviewer-grok`, 17 turns | $0.17765884 |
| `reviewer-kimi`, 27 turns | not priced |
| **Charged** | **$5.24782756** |

The charged figure is a lower bound on resource use for one reason. The 27 `reviewer-kimi` turns ran
on an OAuth entitlement, and Kimi Code prompt mode with text output reports neither a cost nor a
token count, so those turns carry no amount and no token figure in either receipt. They are outside
the charged spend and the cap accounting.

The Codex amounts, subject and reviewer, are derived from token counts with the price table
`research/evals/codex-token-prices-2026-10-02.json`, which states that it was not verified against a
live session. The 14 `reviewer-sol` turns used 220,530 tokens in total. Claude and Grok amounts are
host-reported.

## Verdicts

| Model | Verdict |
| --- | --- |
| `gpt-6-sol` | **Proven on the four-case suite.** Four valid sessions, four passes, 18 criteria passed; one criterion passed on a two-to-one split. |
| `claude-opus-5-5` | **Not proven.** Its first case failed on `persists-stop-evidence` two votes to one. Its other three cases did not run. |
| `grok-4.7-build` | **Not proven.** It passed delegated refresh-token rotation and the vague checkout-speed criterion, then failed the oversized-change split on `orders-a-reversible-stack` three votes to none. `approved-spec-produces-tickets` did not run. |
| Overall | **Success on three different models is not proven.** One of the three served models passed the suite. |

What is not proven, exactly:

- Claude on any of the four cases in this run. Its one session failed, and three cases have no
  session.
- Grok on the oversized-change split, which it failed, and on `approved-spec-produces-tickets`,
  which has no session.
- Anything about whether a failed subject would have passed its later cases. The subject-failure
  stop skipped them.

What is proven beyond the Sol result: three served-model identities were observed in one run,
all eight sessions were valid, and Grok passed two cases under a three-reviewer
panel.

## Matrix used

The runner loaded `.work/eval-matrix.yaml`, built from the operator calibration matrix.

| Seat | Id | Host | Model | `max-turns` |
| --- | --- | --- | --- | --- |
| Subject | `subject-opus` | claude | `claude-opus-5-5` | absent |
| Subject | `subject-fable` | claude | `claude-fable-5-1` | absent |
| Subject | `subject-sol` | codex | `gpt-6-sol` | `null` |
| Subject | `subject-astra` | codex | `gpt-6-astra` | `null` |
| Subject | `subject-grok` | grok | `grok-4.7` | `null` |
| Reviewer | `reviewer-opus` | claude | `claude-opus-5-5` | |
| Reviewer | `reviewer-sol` | codex | `gpt-6-sol` | |
| Reviewer | `reviewer-grok` | grok | `grok-4.7` | |
| Reviewer | `reviewer-kimi` | kimi | `kimi-code/k3` | |

`price-table` was `research/evals/codex-token-prices-2026-10-02.json`. The panel settings were
`independent-of: subject`, `min-reviewers: 3` and `size: 3`. `subject-fable` and `subject-astra`
were not selected.

`kimi-code/k3` is the Kimi Code CLI's own default: its `config.toml` sets
`default_model = "kimi-code/k3"` and `kimi provider list` prints `Default model: kimi-code/k3`. The
seat runs the Kimi Code CLI directly.

**The Claude subjects carry no `max-turns`, which departs from the example matrix.** The example
gives the Claude subject 20. In `case-runner.ts` a subject's value replaces the case's own
`max_turns`, so 20 would have lowered `approved-spec-produces-tickets` from 32. With the key absent
each case keeps its own cap: 18, 12, 16 and 32. Codex and Grok keep `null` as the example states, so
those hosts ran with no turn cap and the wall clock bounded them. Session 1 reported 20 turns
under a cap of 18 and ended with a reply, so it was valid.

## Exact commands

The fresh worktree first installed its lockfile-pinned dependencies. The SHA-256 of `bun.lock` was
`b332db1c982cb8d299ab8d80cb8fde19c7e1f16cd2487ee11a54dd007c6f9ece` before and after the install.

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
{"mode":"preflight","host":"claude","ok":true,"checks":[{"name":"binary","ok":true,"detail":"host CLI resolves locally"},{"name":"login","ok":true,"detail":"credential source is present and valid"},{"name":"bundle-skills","ok":true,"detail":"1 referenced skill(s) resolve"},{"name":"case-fixtures","ok":true,"detail":"4 scaffold(s) resolve"},{"name":"grader-readiness","ok":true,"detail":"every panel seats and every grader runs locally"},{"name":"reviewer-hosts","ok":true,"detail":"3 reviewer host(s) resolve and are logged in"},{"name":"cli-flags","ok":true,"detail":"11 flag(s) listed by `claude --help`; --max-turns absent from help, accepted by the argument parser"}]}
{"mode":"preflight","host":"codex","ok":true,"checks":[{"name":"binary","ok":true,"detail":"host CLI resolves locally"},{"name":"login","ok":true,"detail":"credential source is present and valid"},{"name":"bundle-skills","ok":true,"detail":"1 referenced skill(s) resolve"},{"name":"case-fixtures","ok":true,"detail":"4 scaffold(s) resolve"},{"name":"grader-readiness","ok":true,"detail":"every panel seats and every grader runs locally"},{"name":"reviewer-hosts","ok":true,"detail":"3 reviewer host(s) resolve and are logged in"},{"name":"cli-flags","ok":true,"detail":"2 flag(s) listed by `codex app-server --help`"},{"name":"thread-identity","ok":true,"detail":"thread/start returned a model and thread id for 4 case request(s), no turn started"}]}
{"mode":"preflight","host":"grok","ok":true,"checks":[{"name":"binary","ok":true,"detail":"host CLI resolves locally"},{"name":"login","ok":true,"detail":"credential source is present and valid"},{"name":"bundle-skills","ok":true,"detail":"1 referenced skill(s) resolve"},{"name":"case-fixtures","ok":true,"detail":"4 scaffold(s) resolve"},{"name":"grader-readiness","ok":true,"detail":"every panel seats and every grader runs locally"},{"name":"reviewer-hosts","ok":true,"detail":"3 reviewer host(s) resolve and are logged in"},{"name":"cli-flags","ok":true,"detail":"7 flag(s) listed by `grok --help`"},{"name":"tool-names","ok":true,"detail":"every --tools id is among the 27 the CLI advertises"}]}
```

Each subject's panel seats the three reviewers outside its own host family, so `reviewer-hosts`
covers the Kimi host in every row.

### The live Kimi reviewer turn

Preflight checks that the Kimi binary and login exist and starts no reviewer turn. An earlier
attempt at this run, at revision `db24965aa2b2ef58a07d2b12d51a5533bcbba805`, passed the same
preflight and then stopped before any paid call: one live turn through the runner's Kimi adapter
exited 1 with an empty reply, because Kimi Code 2.1.1 answers
`error: Cannot combine --prompt with --plan.` to the flags the adapter passed. An empty reply is an
unreadable vote, which would have left every judged row ungraded. The adapter was repaired
separately and this run measured the revision that carries the repair.

At the measured revision, one live turn was made before `--execute`, calling the adapter the way
the judge in `tests/learn/evals/panel.ts` does, with the `reviewer-kimi` binding, an empty working
directory and a prompt asking for a fixed verdict object. It exited 0 with the reply
`• {"verdict":"PASS","reason":"probe"}`, and `parseVote` reads that reply as `PASS`. The turn ran on
the OAuth entitlement and is outside the charged spend.

### Dry run and execution

The estimates file at `.work/cross-host-estimates.json` mapped every selected subject id and case
name to the amount in the estimate table of
[`2026-10-03-cross-host-success-preflight.md`](2026-10-03-cross-host-success-preflight.md). The dry
run was:

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
`timeout_ms` values were 1,080,000; 720,000; 960,000; and 1,920,000. The Claude rows showed
`max_turns` 18, 12, 16 and 32; the Codex and Grok rows showed `null`.

The one and only paid execution was:

```sh
bun tests/learn/evals/case-runner.ts --execute \
  --subject subject-opus --subject subject-sol --subject subject-grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml \
  --max-spend-usd 12.05 --estimates .work/cross-host-estimates.json \
  --json .work/cross-host-rerun-3.json
```

It started at 2026-10-06T00:26:13Z and finished at 2026-10-06T01:22:29Z.
