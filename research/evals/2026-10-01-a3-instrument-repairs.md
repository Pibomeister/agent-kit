# A3 instrument repairs, 2026-10-01

The A3 follow-up treats Grok refused calls and the six-turn subject cap as measurement failures,
not as evidence about skill wording. This change repairs both instruments without running a paid
session and without changing a scorer outcome.

## Evidence used

The A2 record is `research/evals/2026-09-28-a2-cross-model.md`. Its archived transcripts were read
from `/Users/eduardopicazo/Documents/agent-kit/.work/archive/xmodel-cases/xmodel-2026-09-28/` and
copied into this worktree's gitignored `.work/a2-instrument-evidence/` before analysis. The A3 record
is `research/evals/2026-09-30-a3-cross-model-after-fix.md`; its transcripts are no longer available,
so the session inventory in that committed record is the A3 evidence.

## Repair 1: Grok refused-call cancellation

### Failure observed

In A2, 109 of 120 Grok sessions were invalid: 103 ended with `stopReason: cancelled` after a
refused call and six exited for another reason. The archived attempted calls were retained in the
event stream even though the reply was empty. Ten cancellations ended on
`ls -la && find . -type f -not -path './.git/*' | head -200`; the rest included read-only chains of
`git status`, `git branch`, `git log`, `gh pr view` or `gh pr list`, `which`, `env`, `echo`, and
filesystem inspection. One ended on `web_fetch`.

A hand-maintained allow list landed before A3 and reduced the damage, but A3 still lost 54 of 120
Grok sessions: 29 refused-call cancellations in R1, 23 in R2, and two unrelated exit-1 sessions.
Every one of the 20 model-invoked positives and 10 typed positives across the two replicates was
invalid, so those routing cells had no completed reply to score.

### Diagnosis

`dontAsk` is deliberately deny-by-default: a call not covered by an allow rule is denied instead
of waiting for approval, and the host cancels the turn. The adapter's fixed list represented only a
subset of the evaluator's own read-only shell language. The archived events show the mismatch at
the denied boundary: the model had already attempted a call the scorer classifies as a look, but a
segment such as `git branch -vv`, `gh pr list`, or `echo ---` had no corresponding host rule.

Grok's Bash rules are conjunctive across shell segments, so every segment of a read-only chain must
be covered. Its glob grammar cannot express every semantic distinction the scorer makes. In
particular, safe subsets of awk, curl, `gh api`, shell loops, arbitrary help/version calls, and a
harmless output redirection need argument-aware parsing rather than a prefix glob; a deny that
blocks `> file` also matches `2>/dev/null`. Those remain deliberate gaps: `dontAsk` still refuses
them and the session remains invalid.

### Change

The canonical read-only program, git-subcommand, git-action and gh-action tables now live in
`tests/learn/evals/subjects/shell.ts`. The scorer imports those tables for `readOnlyProgram`,
`readOnlyGit` and `readOnlyGh`; the Grok adapter generates its narrow `--allow` rules from the same
tables instead of copying a second list. Write-shaped forms covered by a broad read prefix have
explicit `--deny` rules for output redirection, writing `find` flags, preprocessors, in-place
editing, sort output, git output/ref mutation, and PR creation. Deny precedence keeps writes
refused, and the adapter remains on `dontAsk`.

The stored fixture `grok-cancelled-read.jsonl` carries an archived read-only chain that the old list
did not cover. Its test proves every missing segment now has a narrow rule. A separate assertion
keeps blanket Bash, mutable git-remote coverage and write tools out, and checks the write guards.
When a refusal remains, `invalidSession` now names the final attempted tool and includes the shell
command for Bash, instead of recording only `host cancelled a refused call`.

### Still unproved

No fixture can prove the live host version interprets every emitted glob exactly as its bundled
documentation says. A paid smoke must show that a previously cancelled read chain completes and
that a write-shaped call is still refused. Until then, the rules are locally verified argv and
parser behavior, not a live-host result.

## Repair 2: the asymmetric turn cap

### Failure observed

The evaluator default was six turns for hosts with a cap flag, while the Codex adapter has no such
flag and ran uncapped. In A2, subject-fable lost 43 of 120 sessions at that boundary. In A3 it lost
32 of 120; every affected session had an empty reply and at least six tool events. Subject-opus lost
one A3 session at the same boundary. The invalid reason was only `exit 1`, which hid the evaluator
limit that ended the trial.

### Diagnosis and default

Across the 197 valid A2 Claude-host sessions retained for subject-fable and subject-opus, the number
of tool events before a completed reply had this distribution:

| Percentile | Tool events |
|---|---:|
| minimum | 0 |
| p50 | 3 |
| p75 | 4 |
| p90 | 7 |
| p95 | 9 |
| p99 | 15 |
| maximum | 15 |

Six sat below the observed p90 and cut off a slower but otherwise bounded subject. The new default
is 20: five events above the archived maximum. It remains a safety cap, but it no longer sits inside
the observed valid-session range.

### Change

The committed matrix example now declares a cap for every subject: 20 for Claude and Grok, and
`null` for Codex, whose adapter cannot enforce one. A supplied positive integer overrides the
trigger evaluator's documented default of 20, an explicit `null` removes the cap, and an omitted
field preserves the calling evaluator's default. `turnCapReceipt` continues to record the effective
integer or JSON `null`.

The stored `claude-turn-cap.json` fixture is a scrubbed A2 subject-fable transcript with six tool
events and an empty exit-1 result. The invalid-session test proves a capped trial remains invalid
and now reads `turn cap 6 reached after 6 tool events`. The scorer still excludes the same session;
only the reason becomes diagnostic.

### Still unproved

The archive proves that 20 is beyond the observed valid-session tool-event maximum, not that every
future well-behaved session completes within 20 host turns. Only a live run can show that the three
formerly capped cases below now reach their law stop or typed-command response.

## Proposed paid smoke — approval required

Run six sessions, and only these, after captain approval:

- subject-fable: `dev-diagnose-p1`, `dev-super-verify-p1`, `dev-wayfind-s1`;
- subject-grok: `dev-super-build-p1`, `dev-diagnose-p1`, `dev-super-ship-s1`.

The fable cases were previously capped; the Grok set covers model-invoked and typed routing plus the
read-only discovery chains seen in the archive. A3 printed $39.2139 for 120 subject-fable sessions
($0.3268 each) and $2.7373 for 120 Grok sessions ($0.0228 each). Three of each therefore estimate
to **$1.05** in host-reported cost. A conservative approval ceiling would be **$2.10**, twice the
estimate, with the run stopped rather than widened if either repair still fails.

No such session was run for this repair.
