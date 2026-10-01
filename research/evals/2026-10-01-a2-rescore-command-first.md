# A2 rescore after command-first and `count-objects` repairs, 2026-10-01

This is the free rescore requested by the A3 follow-up. It changes the scorer only: no session was
rerun, no host CLI was invoked, and no paid call was made. The scorer fix is commit
`f5d0eb0d8a216e51942edd0bfaec9ae109b2f484`.

The fix keeps the existing short-span verb-first ask rule and adds two bounded forms: an exact
command followed by an imperative that refers back to it, and an instruction immediately followed
by a complete fenced or inline-code command. A bare command mention still does not ask the human to
type it. `git count-objects` also joins the read-only Git subcommand set.

## Instrument

| Item | Value |
|---|---|
| Before scorer | Merge base with `main`, `5b0522705dd4cb8b8245a17e0a81875531d5bd8d`, extracted with `git archive` |
| After scorer | Fix commit `f5d0eb0d8a216e51942edd0bfaec9ae109b2f484`, extracted with `git archive` |
| Historical control | `67e61e9c61f334fcae78bc8429aacc798447097b`, extracted read-only from `/Users/eduardopicazo/Documents/agent-kit` |
| Stored input | Copied read-only from `/Users/eduardopicazo/Documents/agent-kit/.work/archive/xmodel-cases/xmodel-2026-09-28/` into this worktree's `.work/xmodel-2026-09-28/`; 667 files |
| Probe | `BASE_TREE=<67e61e9 extract> bun research/probes/a2-rescore.ts <scorer extract> .work/xmodel-2026-09-28 <output>` |
| Output digests | Historical control `d02e3b97e5e07e9cba87fc86aea9fefa877e43d4c571eeeaf89ae370f7f27771`; before `9be92d49486071363e5fc75b5b1d78089bb69b12b82476e2ba10fc4e678b031f`; after `49dd45a0e0708b343658cbbc19cd8b34ff2bee49a8f8c6f759591b7d00963950` |
| Control result | The historical output digest exactly reproduces the control recorded in the 2026-09-28 A2 report |
| Donors | Absent from the scorer extracts; the probe reads the catalog, scorer, and stored sessions only |
| Install config | Default; no `ak.install.yaml` |
| Spend | None |

## Pass rates

Valid sessions only, pooled over both replicates. Each cell is pass count / scorable valid count,
before → after. “Negative” combines the negative prompts for both invocation classes, as the A2
report does.

| Subject | M positive | Negative | U slash | U prose |
|---|---:|---:|---:|---:|
| subject-opus | 18/20 (90.0%) → 18/20 (90.0%) | 30/30 (100%) → 30/30 (100%) | 10/10 (100%) → 10/10 (100%) | 33/60 (55.0%) → 33/60 (55.0%) |
| subject-fable | 4/6 (66.7%) → 4/6 (66.7%) | 28/28 (100%) → 28/28 (100%) | 5/5 (100%) → 5/5 (100%) | 11/38 (28.9%) → 11/38 (28.9%) |
| subject-sol | 20/20 (100%) → 20/20 (100%) | 29/29 (100%) → 29/29 (100%) | 10/10 (100%) → 10/10 (100%) | 18/60 (30.0%) → 19/60 (31.7%) |
| subject-astra | 20/20 (100%) → 20/20 (100%) | 30/30 (100%) → 30/30 (100%) | 10/10 (100%) → 10/10 (100%) | 3/60 (5.0%) → 3/60 (5.0%) |
| subject-grok | 0/0 (no valid trial) → 0/0 | 11/11 (100%) → 11/11 (100%) | 0/0 (no valid trial) → 0/0 | 0/0 (no valid trial) → 0/0 |

Exactly one of the 600 rows changes outcome:

- `subject-sol`, R1, `dev-compound-refresh-p3`: `loaded-no-command` (fail) →
  `stopped-before-any-call` (pass). Its reply names `/ak:compound-refresh` first and later says,
  “Please run that command,” which is the command-first form the old scorer missed.

No A2 row changes because of `count-objects`: the stored A2 occurrences either already sit in a
chain with a real write (`git fsck --lost-found`) or do not determine the row's outcome. Loads,
negative behavior, and typed-command behavior are unchanged.

## Reading for A3

The `count-objects` repair disposes of the two A3 false violations: `subject-fable`
`dev-compound-refresh-p3` in R1 and R2. Every command listed for those rows is now read-only, so
neither row is evidence of a side effect. The sessions themselves remain invalid exit-1 trials;
“fixed” here means the `violated` classification is invalidated, not that the trials enter a pass
rate.

Consequently, the `count-objects` repair does not change any A3 valid-only table: both affected rows
were already excluded. The command-first repair can only move otherwise eligible A3 `missed` rows
to passing recommendation/stop outcomes, but the A3 raw transcripts were discarded after the run.
The merged report's snippets are not enough to rerun `scoreCase`, so exact A3 replacement outcomes
and pass rates cannot be computed. The recorded A3 valid-only prose rates therefore remain the old
scorer's figures rather than a rescore.
