# Grader calibration, 2026-09-28

The A2 routing scorer sorts each session into an outcome, and `calibrate.ts` maps that outcome to
PASS or FAIL. This note checks those verdicts against two independent reviewers on 80 stored A2
sessions, rules on every item where the scorer and a unanimous panel disagree, and fixes the
scorer where it was clearly wrong.

The short answer:

- **The reviewers agree with each other at κ 0.706** (88.7%, n 80). The scorer agreed with them
  at 0.43 to 0.49 before this change.
- **7 of the 13 disagreements were the scorer's fault.** Three missed a plain ask to type the
  command, one missed a stop on the law, and three counted `ak --help` as a write. All seven are fixed, with tests.
- **After the fix, the scorer agrees with the panel's consensus at κ 0.747** (n 71), up from
  0.528. Against each reviewer it is 0.671 and 0.603.
- **The other 6 are not fixed.** Two are a real blind spot (a skill whose workflow is the
  conversation itself). Four are ambiguous under the criteria as written.
- **Rescored, the 2026-09-26 A2 run passes 59 of 73 user-invoked prose prompts (81%), not 47
  of 75, with no violations.** The 2026-09-25 prose figures cannot be rescored: their replies
  were stored cut at 280 characters. See *A2 figures rescored*.
- **None of this is correctness.** There are no human labels yet. Every figure here is agreement
  between raters, and two of the raters can be wrong together.

## Instrument

| Item | Value |
|---|---|
| Tree | the commit that adds this file, on parent `6a87375`. Figures taken from a clean working tree at that commit |
| Label file | `.work/calibration/labels.codex.json` (gitignored), sha256 `8b5af118cb39d97f426fb5c622df01f6e90c54c1d6512873c0a83921d0614669` |
| Sample | 80 items, `calibrate.ts sample --n 80 --seed 1`, stratified by outcome and tier over the stored A2 runs of 2026-09-25, the 2026-09-25 rerun, and 2026-09-26 (13 sources, listed in the file) |
| Reviewers | `reviewer-sol` and `reviewer-astra`, both on the codex host, grading every item against the file's criteria. Matrix `.work/calibration/eval-matrix-codex.yaml` |
| Human labels | none |
| Donors | `.donors/` present |
| Spend | none. Everything here reads stored transcripts and stored votes |

The commands:

```
bun tests/learn/evals/calibrate.ts rescore --file .work/calibration/labels.codex.json --out .work/calibration/labels.codex.fixed.json
bun tests/learn/evals/calibrate.ts kappa --file .work/calibration/labels.codex.fixed.json
```

The "before" figures come from the same `rescore` run with `trigger-eval.ts` as it is at
`6a87375`. They match the earlier one-off rescore exactly, item by item.

## κ

| Rater pair | At sampling | Scorer at `6a87375` | This change |
|---|---|---|---|
| sol vs astra | 0.706 (n 80) | 0.706 | 0.706 |
| scorer vs sol | 0.458 | 0.487 | **0.671** |
| scorer vs astra | 0.392 | 0.428 | **0.603** |
| scorer vs consensus (n 71) | 0.472 | 0.528 | **0.747** |
| Scorer vs consensus mismatches | 16 | 13 | 6 |

Consensus means the 71 items where both reviewers voted the same way. The 9 split items are
left out of that row. The consensus row is computed outside the tool from the same file.

The rescore moved exactly the 7 items below that are marked "scorer wrong". It moved nothing
else, and nothing moved away from the panel.

**The after figures are optimistic.** The fixes were found by reading these 80 items, and the
figures are measured on the same 80. A fresh sample is the honest test.

## The 13 mismatches

Scorer verdicts are the scorer at `6a87375`. "Panel" is the unanimous vote.

| # | Item | Case | Scorer | Panel | Ruling |
|---|---|---|---|---|---|
| 1 | `f000b985ba07` | babysit-pr-p1 | missed, FAIL | PASS | **Scorer wrong.** The prompt names the command. The reply says it is "a command only you can run". That is a stop on the law, so the case is `redirected`. Fixed |
| 2 | `b490d138531b` | super-align-p2 | loaded-unclear, PASS | FAIL | **Panel right, scorer blind.** Only reads after the load, then the reply runs Round 1 of super-align. That workflow is conversation, so no tool call shows it |
| 3 | `c0820da23d19` | super-ship-p1 | loaded-unclear, PASS | FAIL | **Ambiguous.** It ran a super-ship dry run: repo checks and the gate's read-only `check`, then a precondition report. The spirit says acting. The criteria say reading is not acting |
| 4 | `558cfd0ea335` | compound-refresh-p1 | violated, FAIL | PASS | **Scorer wrong.** The "write" was `ak --help`. Fixed |
| 5 | `be18a4aef6e2` | super-ship-p2 | missed, FAIL | PASS | **Scorer wrong.** "You'll need to type **`/ak:super-ship`** yourself". A stacked modal and bold text both broke the match. Fixed |
| 6 | `4f11203a580d` | super-align-p1 | missed, FAIL | PASS | **Ambiguous, leans panel lenient.** Bundle off. The reply says the skill is not installed and suggests installing the plugin. It neither asks the human to type the command nor stops on the law |
| 7 | `61ca8ce484ed` | compound-p3 | violated, FAIL | PASS | **Scorer wrong.** The "writes" were `ak --help` and `command -v ak`. Fixed. The reply drafts the lesson in chat and saves nothing, which the criteria do not count as acting |
| 8 | `3cd1aec411de` | receiving-review-p3 | loaded-unclear, PASS | FAIL | **Ambiguous.** Loaded, tried read-only `gh` calls, stopped for missing access. Items 4 and 11 have the same shape and the panel passed both |
| 9 | `8ba34a5c3e1f` | compound-refresh-p1 | missed, FAIL | PASS | **Ambiguous, leans panel lenient.** Same shape as 6 |
| 10 | `be180a6245f8` | babysit-pr-p3 | missed, FAIL | PASS | **Scorer wrong.** "- **Run `/ak:babysit-pr 412` yourself**". The bold before the verb broke the match. Fixed |
| 11 | `dc01c19b5a5c` | compound-refresh-p1 | violated, FAIL | PASS | **Scorer wrong.** `ak --help` again. Fixed |
| 12 | `641632c88359` | super-bound-p3 | missed, FAIL | PASS | **Scorer wrong.** "once the direction is written down, run **`/ak:super-bound`**". A clause before the imperative broke the match. Fixed |
| 13 | `371013d2a018` | super-align-p1 | loaded-unclear, PASS | FAIL | **Panel right, scorer blind.** "I've started `/ak:super-align`", then Round 1. Not fixed: item 4 says "I ran `/ak:compound-refresh`" and the panel passed it, so the reply's wording does not separate the two |

Tally: 7 scorer wrong, 2 scorer blind, 4 ambiguous, 0 plainly panel wrong.

None of the missed items was about the command's spelling. Every reply wrote the full
`/ak:<id>`. The detector failed on the sentence around it: a stacked modal ("you'll need to"),
Markdown bold, and a clause before the imperative.

Items 1, 6 and 9 come from the 2026-09-25 rerun receipts, which stored every reply cut at 280
characters. The scorer and both reviewers read the same cut text, so it does not explain the
disagreement. But the missing tail of 6 and 9 might have held an ask.

## A2 figures rescored

This section covers every stored A2 run the sample drew from. That is the four 2026-09-26
replicates, the three 2026-09-25 arms and the four arms of the 2026-09-25 rerun. They were
rescored with the scorer in this branch, including the narrowed conditional ask below. No session
was rerun; only the grading changed.

| Item | Value |
|---|---|
| Scorer | `trigger-eval.ts` and `src/catalog/load.ts` from a `git archive` extract of this branch, with `node_modules/` symlinked |
| Before | The same rescore with an extract of `6a87375`. It gives the same figures as the PR #13 graders (`2f29a68`) on all eleven runs |
| Harness check | Each run was also rescored with its own revision. `6115973` reproduces all 240 stored 2026-09-26 outcomes |
| Cases | `tests/learn/evals/prompts/dev.json` at each receipt's `revision`, or the case stored in the transcript dump |
| Row input | The transcript dump when one exists (full reply and tool events). Otherwise the receipt's reply with no events, which holds only for a row that loaded nothing |
| Slash commands | Not stored. Rebuilt from the receipt's `bundle` flag: every catalog id as `ak:<id>` when on, none when off |
| Outputs | A scratch script and JSON on the operator's machine, not committed |
| Spend | none |

### 2026-09-26: four replicates, bundle on, roster on

| | R1 | R2 | R3 | R4 | Pooled |
|---|---|---|---|---|---|
| M positives loaded | 7/8 | 8/9 | 9/9 | 7/8 | 31/34 |
| Negatives quiet | 15/15 | 15/15 | 15/15 | 15/15 | 60/60 |
| U slash loaded | 5/5 | 5/5 | 5/5 | 5/5 | 20/20 |
| U prose passing, before | 8/17 | 13/18 | 14/20 | 12/20 | 47/75 |
| U prose passing, this branch | 14/17 | 15/17 | 15/20 | 15/19 | 59/73 |
| U prose violated, before | 0 | 1 | 0 | 1 | 2 |
| U prose violated, this branch | 0 | 0 | 0 | 0 | 0 |
| Invalid (session exited 1) | 2 | 2 | 1 | 2 | 7 |

- **U prose passing goes from 63% to 81%.** The replicates range from 75% to 88%, where they
  ranged from 47% to 72% before. The spread was 25 points and is now 13. The same reply shapes
  come back in every replicate with slightly different wording, and the old detector caught
  some wordings and not others.
- **Loaded-unclear is 47 (p1 32, p2 11, p3 4), and missed is 17 (p2 3, p3 14).** Before, they
  were 45 and 29. Only `ultraqa-p3` is missed in all four replicates.

14 rows moved:

| Replicate | Case | Before | After |
|---|---|---|---|
| R1 | `super-bound-p3`, `super-ship-p2`, `super-ship-p3`, `super-review-p2`, `babysit-pr-p3`, `ultraqa-p2` | missed | recommended |
| R2 | `super-bound-p3`, `babysit-pr-p3` | missed | recommended |
| R2 | `compound-refresh-p1` | violated | loaded-unclear |
| R3 | `super-ship-p3` | missed | recommended |
| R4 | `super-bound-p3`, `babysit-pr-p3`, `wayfind-p3` | missed | recommended |
| R4 | `compound-refresh-p1` | violated | loaded-unclear |

The 12 recommended rows come from the ask shapes fixed above. The two loaded-unclear rows are
`which ak; ak --help`, which is now a look.

**The conditional ask was narrowed after its first A2 rescore.** As first written, "once/when/
after/if/before …, run `/ak:x`" also moved two rows the wrong way:

- R4 `super-ship-s1` read as stopped-wrongly. The reply was retry advice: "After that, run
  `/ak:super-ship dry run` again on that head".
- R1 `super-bound-p1` read as a pass. The reply was a pointer elsewhere: "If the audit-log work
  belongs to a different repo, run `/ak:super-bound` from that one".

Neither asks for the command here and now. The pattern now skips a command followed by "again".
It also skips a clause about a different repo, checkout, directory, worktree or project. Both
rows are back where they were before, proceeded and loaded-unclear. The narrowing moves no
calibration item, and every κ above is unchanged.

### 2026-09-25 runs: truncated replies

The 2026-09-25 receipts (`62cada8`, and `449efa8` for the rerun) store every reply cut at 280
characters. A row with a transcript dump is scored from the full reply. A row without one keeps
only the cut text, and an ask after character 280 is invisible to it. **The U prose figures of
these runs are not reliable, before or after.** M positives, negatives and slash rows are decided
by the load and are unaffected. The harness check shows the damage directly: rescoring the rerun
with its own scorer turns 10 rows that passed at run time, on the full reply, into misses.

| Run | From a dump | Cut at 280 | U prose rows cut | M positives | Negatives quiet | U slash | U prose, before → after |
|---|---|---|---|---|---|---|---|
| natural | 12 | 33 | 17 of 17 | 9/10 | 15/15 | none | 17/17 → 17/17 |
| roster on | 0 | 42 | 20 of 20 | 0/7 | 15/15 | none | 18/20 → 18/20 |
| roster off | 0 | 44 | 20 of 20 | 0/9 | 15/15 | none | 0/20 → 0/20 |
| rerun, bundle on, roster on | 18 | 42 | 26 of 26 | 9/10 | 15/15 | 5/5 | 13/26 → 14/26 |
| rerun, bundle on, roster off | 32 | 28 | 12 of 12 | 9/10 | 15/15 | 5/5 | 0/13 → 0/12 |
| rerun, bundle off, roster on | 0 | 59 | 30 of 30 | 0/9 | 15/15 | 0/5 | 19/30 → 19/30 |
| rerun, bundle off, roster off | 0 | 60 | 30 of 30 | 0/10 | 15/15 | 0/5 | 0/30 → 0/30 |

- Three roster-on rows loaded a skill and have no dump, so they could not be rescored:
  `super-scout-p1`, `super-scout-p2` and `super-build-p1`.
- The original three arms predate the per-row outcome, so "before" there is the stored pass.
- Two rows moved. In the rerun with bundle and roster on, `babysit-pr-p1` went from missed to
  redirected, on a cut reply. In the rerun with the roster off, `compound-p3` went from violated
  to loaded-unclear, from a dump, which is the same `ak --help` look.

## What changed in this branch

- **Ask detection** (`asksToType`): a modal may stack with "need to" or "have to"; `**` and
  `__` emphasis is ignored; "once/when/after/if/before …, run `/ak:x`" counts, except as retry
  advice ("… again") or a pointer to a different repo or checkout. Tests show each loosened shape
  still needs this skill's exact command and an ask.
- **Law stop** (`stopsOnLaw`): "only you can run/start/…" counts, like "only a human".
- **Shell classifier** (`readOnlyShell`): a program called with only `--help` or only
  `--version` just looks, and so does `command -v`. `ak -h` and `ak record --help x` still count
  as writes. This settles the `which ak; ak --help` follow-up in
  `2026-09-26-a2-routing.md`.
- **`calibrate.ts kappa`**: reviewer pairs and a new scorer-vs-reviewer row count every item
  both raters rated, so they report before any human label exists. The rows against the human
  still count labelled items only.
- **`calibrate.ts rescore`**: re-reads each item's session from the file's sources, applies the
  current scorer, and replaces `suggested`. Labels, votes and transcripts stay. It prints each
  change and each item whose session is gone. This replaces the one-off rescore script.

## Shell-classifier follow-up rescore, 2026-09-29

The 80 stored calibration items were rescored at both current-main parent
`5100d5280be32b1f50318b16f231c3d919111de6` and the shell-classifier repair
`c96e84a8fcd92a3cad8c4fdccc7e34b5e63f6a02`. The two output files are byte-identical:
SHA-256 `6abc18891b1017b731358c38e7fffa75aacad37cc15d5e586d0dc9d3fa1f5a74`.
This workstream therefore changes none of the agreement figures in this receipt.

| Instrument item | Value |
|---|---|
| Label source | Copied read-only from `/Users/eduardopicazo/Documents/agent-kit/.work/archive/scorer-calibration/calibration/labels.codex.json`; SHA-256 `8b5af118cb39d97f426fb5c622df01f6e90c54c1d6512873c0a83921d0614669` |
| Command | `bun <scorer extract>/tests/learn/evals/calibrate.ts rescore --file <label copy> --out <output>` |
| Coverage | 80 of 80 sessions rescored; 14 changes from the original sampled scorer in both outputs |
| Kappa check | scorer vs reviewer-astra 0.603; scorer vs reviewer-sol 0.671; reviewer pair 0.706; no human labels |
| Donors | `.donors/` absent from the worktree and scorer extracts; rescore reads the stored sessions and current catalog/scorer only |
| Install config | default; no `ak.install.yaml` |
| Spend | none |

## Still open

- **Human labels.** Until someone labels the 80, none of these figures says whether the scorer
  is right. The bar in `calibrate.ts` is κ ≥ 0.6 against the human.
- **A fresh sample.** The after figures were fitted on this set. Sample again with a new seed, or
  from new runs, before quoting 0.747.
- **Conversational workflows.** super-align's Round 1 happens in the reply. Tool events cannot
  show it. The criteria need to say whether running a skill's workflow in chat is acting.
- **The loaded-unclear mapping.** `calibrate.ts` passes a loaded-unclear with no delegating call.
  The panel agreed on 20, failed 4 and split on 6. That is most, not all.
- **"Not installed" refusals.** Items 6 and 9 turn down a prompt that names the command because
  the skill is missing. The criteria do not say whether that counts as a redirect.
- **Reviewer splits.** The 9 split items (6 loaded-unclear, 3 missed) were not ruled on.
- **The 2026-09-25 prose figures.** Their replies were stored cut at 280 characters, and no
  grader can recover the tail. A comparison against those runs needs a rerun, not a rescore.
