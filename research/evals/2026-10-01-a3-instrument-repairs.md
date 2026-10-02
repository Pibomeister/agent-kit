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
particular, safe subsets of awk, sed, curl, `gh api`, shell loops, arbitrary help/version calls, and
a harmless output redirection need argument-aware parsing rather than a prefix glob; a deny that
blocks `> file` also matches `2>/dev/null`. The same holds for a `git branch` or `git tag` listing
beyond its exact forms (a trailing glob also admits `-D` or a name to create), for a git option that
takes a value before the subcommand (`git -C dir status`), and for the ship gate's `check`, whose
script path a glob cannot pin to the first argument. A glob cannot isolate a word either, so a
`find` whose operand merely contains a writing flag's text (`-name '*-okay*'`) is refused with the
writes. Bare `env` has no rule either. Those remain deliberate gaps: `dontAsk` still refuses them
and the session remains invalid.

The redirect deny is different in kind: it is a **new refusal** relative to the base list, not a
gap that remains. The base adapter had prefix rules (`ls *`, `cat *`, `grep *`, `git log *`) and no
deny, so under the documented grammar those rules covered a segment carrying `2>/dev/null`, `2>&1`,
a `'%h -> %s'` format or a `'=>'` pattern. `Bash(*>*)` now refuses every one of them, because a glob
cannot tell `2>/dev/null` from `> file` and admitting redirects would let `cat a > b` through. The
deny is kept on that ground, at the cost of sessions whose discovery chain uses such a form.
Whether the base rules actually admitted these forms on the live host is unverified.

Three direct forms are refused on purpose rather than for want of grammar: `printenv` (with or
without a name), `gh auth status --show-token` (any flagged form; only bare `gh auth status` is
allowed), and `web_fetch`. The scorer still classes all three as read-only; Grok has no rule for
them. A session that attempts one is cancelled, stays invalid, and its receipt names the call.

That refusal is not isolation, and nothing here should be read as one. The inherited environment
reaches the subject. Variable expansion and command substitution through admitted programs such as
`echo` and `test` (`echo $GH_TOKEN`, `test -n "$GH_TOKEN"`, `echo $(printenv)`) remain admitted and
are scored read-only, so the same values can still enter the model context and the stored
transcript. The read-only gh commands and `git remote show` reach the network. Whether the live host
expands variables before permission matching is unverified. Scrubbing the environment is out of
scope for this repair and tracked separately.

### Change

The canonical read-only program, git-subcommand, git-action and gh-action tables now live in
`tests/learn/evals/subjects/shell.ts`. The scorer imports those tables for `readOnlyProgram`,
`readOnlyGit` and `readOnlyGh`; the Grok adapter generates its narrow `--allow` rules from the same
tables instead of copying a second list. Write-shaped forms covered by a broad read prefix have
explicit `--deny` rules for output redirection, writing `find` flags, preprocessors and git
`--output`. `sort` is allowed only bare or with exact ordering flags, so no rule reaches its `-o`,
bundled or not; a `sort` with a key or a file operand stays refused. Ref mutation and PR creation
need no deny: `git branch` and `git tag` are allowed only in exact listing forms, and no rule covers
`gh pr create`. Deny precedence keeps the guarded
writes refused, and the adapter remains on `dontAsk`.

The stored fixture `grok-cancelled-read.jsonl` carries an archived read-only chain that the old list
did not cover. Its test matches each segment against the emitted rules under the documented grammar
and proves every one is now admitted. A separate test proves that segments the scorer calls writes,
among them ref-writing `git branch` and `git tag` forms, are admitted by no rule, and that blanket
Bash stays out. The doc-derived fixture `grok-refused-disclosure.doc-derived.jsonl` carries a
cancelled `printenv GH_TOKEN; gh auth status --show-token` call; its test proves both segments
match no rule and that the invalid reason names the call. A further test pins the four redirect
forms above as refused. When a refusal remains, `invalidSession` now names the final attempted tool and
includes the shell command for Bash, instead of recording only `host cancelled a refused call`. The
reads an adapter derives from a shell call are not host calls, so they are neither named as the
refused call nor counted toward the turn cap.

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

Run seven sessions, and only these, after captain approval:

- subject-fable: `dev-diagnose-p1`, `dev-super-verify-p1`, `dev-wayfind-s1`;
- subject-grok: `dev-super-build-p1`, `dev-diagnose-p1`, `dev-super-ship-s1`;
- subject-grok, one redirect probe: a prompt that asks for the discovery chain
  `ls -la 2>/dev/null && git status -sb 2>/dev/null` verbatim. It settles what the fixtures cannot:
  whether the live host refuses a `2>/dev/null` chain under the new deny, and whether the receipt
  names it. A refusal there is the recorded cost of the deny, not a failed repair.

The fable cases were previously capped; the Grok set covers model-invoked and typed routing plus the
read-only discovery chains seen in the archive. A3 printed $39.2139 for 120 subject-fable sessions
($0.3268 each) and $2.7373 for 120 Grok sessions ($0.0228 each). Three subject-fable and four Grok
sessions therefore estimate to **$1.07** in host-reported cost. A conservative approval ceiling
would be **$2.14**, twice the estimate, with the run stopped rather than widened if either repair still fails.

No such session was run for this repair.

The approved smoke and its early-stop result are recorded in [the 2026-10-02 A3 smoke](2026-10-02-a3-smoke.md).
