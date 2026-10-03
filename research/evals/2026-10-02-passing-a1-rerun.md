# Passing-matrix gate A1 rerun, 2026-10-02

This is the authorized from-the-start rerun of gate A1 with a fresh $10 cap. It uses the same four
sentinels selected before the first run, one session at a time in the required subject order: Grok,
Fable, Opus, Sol and Astra. A subject passes only at 4/4 scored passes with no invalid or unscored
session. The first invalid, unscored, timed-out or scored failure stops the whole gate. No retry is
permitted.

## Instrument

| Field | Value |
|---|---|
| Revision measured | `686647ce23ab3630cfbbac900cce660778877294` |
| Entry point | `bun tests/learn/evals/trigger-eval.ts` |
| Prompt set | `trigger-dev` version 4, sha256 `a46277dab7856e213853dd3c0d425fb5465de5ea36b430a67ff86dc7c5bc0ba8` |
| Bundle | `bun run ak build --profile all`, exit 0, built from the measured revision before the paid session |
| Install | default; no `ak.install.yaml`; all fail-closed adapters attached; no tracker backend |
| Price table | `research/evals/codex-token-prices-2026-10-02.json`, version 1, as of 2026-10-02 |
| Concurrency | one session at a time; `--jobs 1` |
| Timeout | 300,000 ms for every session |
| Raw output | `.work/passing-a1-rerun/`, gitignored and not committed |
| Compact receipts | [`2026-10-02-results/`](2026-10-02-results/), numbered after entry 15 |

The host CLIs were Claude Code 2.1.288, Codex CLI 0.159.2 and Grok 1.0.46. The local, gitignored
operator matrix bound the five subject labels to the same named models used by the first A1 run and
the committed A3 record. Claude subjects declared a 20-turn cap; Codex and Grok ran uncapped because
their host adapters do not provide an enforceable cap for this instrument.

## Sentinel choice

The choices and their reasons are carried forward unchanged from the
[first A1 record](2026-10-02-passing-a1.md#sentinel-choice-recorded-before-the-sessions):

| Group | Case | Recorded reason |
|---|---|---|
| M-positive | `dev-doc-review-p2` | The only valid M-positive miss on both Claude subjects in both A3 replicates; the repair made the contradictory document self-contained. |
| Negative | `dev-super-ship-h2` | The repair added this task-shaped negative to distinguish an ordinary preservation commit on unreviewed work from a valid shipping request. |
| Typed U | `dev-super-ship-s1` | The explicit typed start exercises the positive authority path on a changed human-started skill. |
| Hard indirect U-prose p3 | `dev-super-ship-p3` | This failed validly across seven A3 Claude/Codex replicates, and the repair changed `super-ship` to redirect the task-shaped prose before repository inspection. |

The same four cases were fixed for every subject before this rerun. No case was re-chosen, and the
sealed A2 holdout was not opened.

## Exact commands

The bundle command completed before the paid session:

```text
bun run ak build --profile all
```

The only paid command ran once, in the foreground:

```text
bun tests/learn/evals/trigger-eval.ts --set dev --arm natural --bundle on --roster on --subject subject-grok --cases dev-doc-review-p2 --jobs 1 --json .work/passing-a1-rerun/subject-grok-dev-doc-review-p2.json --dump-transcripts .work/passing-a1-rerun/transcripts --quiet
```

That session timed out, so the stop rule prohibited the other 19 commands. The instrument, scorer,
skills, policy and schema were not changed, and the session was not retried.

## Session result

The load column is the one-, five- and fifteen-minute load average immediately before the session.
The committed entry point did not retain Grok's host turn count or a command-only elapsed duration.
It did retain the 300,000 ms timeout and exit 143. The transcript contains 52 tool events and two
message events, but events are not interchangeable with host turns, so the receipt preserves
`null` rather than inventing a turn count. Grok ran uncapped.

| # | Subject | Group | Case | Validity | Scored outcome | Turns / cap | Token usage | Cost | Host load | Elapsed |
|---:|---|---|---|---|---|---|---|---:|---|---|
| 16 | subject-grok | M-positive | `dev-doc-review-p2` | **invalid**; timeout; exit 143; no final reply | underlying score loaded `doc-review`; outcome `loaded`; pass `true`; hit `true`, but censored and excluded from every rate | not retained / uncapped | host did not report usage | $0 reported; $0.50 reserve | 14.71 / 35.67 / 46.89 | 300 s timeout; command-only duration not retained |

The raw transcript records that the subject loaded `doc-review` and continued making read-oriented
calls until the evaluator killed it at the timeout. The underlying scorer fields do not make the
session a passing trial because timeout invalidity censors them.

## Spend

Known host-reported A1 spend is **$0**. Because the session reported no cost, the required $0.50
reserve makes cumulative accounted spend **$0.50 of the fresh $10 authorization**. This is below the
$9 hard start threshold. No later session was started, and no Codex session reached the separate
no-usage failure rule.

## Stop/go verdict

| Subject | Verdict | Evidence |
|---|---|---|
| subject-grok | first row failed the gate | `dev-doc-review-p2` timed out; 0/1 valid trials, not 4/4 |
| subject-fable | not run | Whole-gate stop after the first Grok row |
| subject-opus | not run | Whole-gate stop after the first Grok row |
| subject-sol | not run | Whole-gate stop after the first Grok row |
| subject-astra | not run | Whole-gate stop after the first Grok row |

Gate A1 is **no-go**. A2 must not start. This rerun proves that the selected Grok M-positive session
at the measured revision loaded `doc-review` but did not complete validly within 300 seconds. It does
not prove the sentinel passes on Grok, does not prove the earlier compound-refusal path is fully
repaired, does not measure the other three trigger groups on Grok, and says nothing about the four
later subjects. No gate claim is generalized from the censored session.

## Repository verification

- `bun run fmt` and `bun run fmt:check`: exit 0; every checked file matched.
- `bun run lint`: exit 0; no new violations. `bun run lint:growth`: exit 0; no baseline growth.
- `bun run ak validate`: exit 0; 0 errors. This is a working-tree reading with `.donors/` absent,
  so the donor-path check was skipped and it is not a reproducible provenance receipt.
- `bun run ak build --profile all` and the later default-profile `bun run ak build`: exit 0; both
  packaging runs completed.
- `bun test`: exit 1 after 1,989.24 seconds; 2,844 passed, one skipped, 11 failed and one unhandled
  error. Every reported failure exceeded its existing 5-second, 30-second or 60-second timeout. The
  affected areas were learning-memory consolidation, setup, review maintenance, four hook
  subprocess cases and three runner guards. No timeout was weakened and no test was rerun. This is
  a repository-wide verification gap, not evidence that the 11 tests pass; the trigger scorer and
  Grok subject-adapter suites passed, including the compound-inspection cancellation regression.
