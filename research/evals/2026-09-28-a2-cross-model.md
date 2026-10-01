# A2 routing across hosts, 2026-09-28

The A2 routing matrix, run for the first time on every subject in the eval matrix: two on the
claude host, two on the codex host, one on the grok host. Same dev prompts, same condition
(natural arm, bundle on, roster on, every targeted skill installed), two replicates per subject
because identical A2 runs moved by up to 25 points on 2026-09-26.

The question: do the package's skills route on non-Claude hosts, or only on Claude?

The short answer:

- **Model-invoked skills route on every host.** The codex subjects loaded 20 of 20 M positives
  each, and the grok subject 20 of 20 before its sessions were cut short. The claude subjects
  loaded 18 of 20; both missed `doc-review-p2` in both replicates.
- **Negatives stay quiet on every host.** No catalog skill fired on a negative on the claude or
  codex host (30/30 each). Grok loaded `receiving-review` on `receiving-review-h1` in both
  replicates, and stopped without a side effect both times.
- **Typed `/ak:<id>` loads the skill on every host,** 10 of 10 per subject. Codex and grok have no
  `/ak:` command; the sessions read the prefix as a request and loaded the skill themselves.
- **User-invoked prose is where the hosts differ.** On the claude host subject-opus loaded a
  U skill on a prose request in 15 of 60 sessions and mostly recommended or redirected to the
  typed command. The codex subjects loaded one in 42 to 46 of 60, grok in 57 of 60, and they
  almost never recommended the command (2 each for the codex subjects, 0 for grok). The roster
  tells every host that these are human-only commands.
- **Grok cannot be measured cleanly yet.** Under `dontAsk`, grok ends the turn at the first
  refused call with no reply. 103 of 120 grok sessions ended that way, usually on a read-only
  look such as `ls -la && find . -type f | head`. Its figures below are read from the events up to
  the cut, and are marked.
- **subject-fable hit the six-turn cap in 43 of 120 sessions.** Those sessions are invalid, which
  leaves its valid-only figures thin. Its events-view figures match subject-opus on routing.
- **No valid-session violation is a write.** Every `violated` row on every host is a shell look
  (`command -v ak`, `gh auth status`, `env | grep`, `cd … && ls`) that the shell classifier counts
  as a side effect, except two invalid sessions whose chains also run `git fsck --lost-found`; see
  [Rescored after the shell-classifier repair](#rescored-after-the-shell-classifier-repair).
  No Write, Edit or patch followed a user-invoked load anywhere in the run.

The U-prose figures carry a caveat: this run was scored by the scorer as it stood before PR #17,
whose agreement with a two-reviewer panel's consensus was κ 0.528. #17 has since landed and moved
that to 0.747 (`2026-09-28-grader-calibration.md`). The kept transcripts have been rescored with
it at `9ad7885`; see [Rescored with the calibrated scorer](#rescored-with-the-calibrated-scorer).
Only the U-prose figures move: subject-opus passes 36/46 instead of 31/46, and violations fall
from 31 to 23, none of them a write. The tables below are the stored, pre-#17 figures.

## Instrument

| Item | Value |
|---|---|
| Tree | `67e61e9c61f3` for both replicates and the smoke, the receipts' `revision`. It is this branch's pre-rebase commit, the earlier copy of `2c60144`, and predates PR #17's scorer. `dist/` built from it with `bun run ak build --profile all`; receipts record the bundle by path, not by hash, so the revision is what identifies it. `git diff 67e61e9c61f3 2c60144` over `skills/ packs/ protocols/ roles/ references/ catalog.yaml` is empty: the measured bundle sources are the ones on this branch |
| Install config | default (no `ak.install.yaml`) |
| Hosts | `2.1.282 (Claude Code)`, `codex-cli 0.157.0`, `grok 1.0.41 (4220f3b224a6) [stable]`; macOS (Darwin 25.6.0) |
| Subjects | subject-opus, subject-fable (claude host); subject-sol, subject-astra (codex host); subject-grok (grok host). Bindings in `.work/eval-matrix.yaml`. Receipts record `claude-opus-5-5`, `claude-fable-5-1` and `grok-4.7-build`; the codex host reports no model |
| Prompt set | `trigger-dev` v3, sha256 `857e7c96bd05…`, all 60 cases; holdout still sealed |
| Roster | on, 199 tokens: five M skills with descriptions, then one line naming the ten human-only commands |
| Session limits | 300 s timeout. Six turns on the claude and grok hosts; codex has no turn cap flag |
| Outputs | `.work/xmodel-2026-09-28/{r1,r2}/` on the operator's machine (gitignored): one JSON and one transcript dump per subject and replicate |

Isolation, per adapter, with the leaks the receipts list:

| Host | Injection | Isolation | Listed leaks |
|---|---|---|---|
| claude | `--append-system-prompt` | argv only: hooks off, `--setting-sources project,local`, strict MCP config, no session persistence, CLAUDE.md and auto memory off, bundle as `--plugin-dir` | the caller's config dir and login; the host's built-in skills |
| codex | `developer_instructions` | private `CODEX_HOME` and `HOME`, bundle copied into `skills/`, `--sandbox read-only`, plugins off | the host's built-in system skills |
| grok | `--rules` | private `GROK_HOME` and `HOME`, bundle copied into `skills/`, Claude and Cursor compatibility scans off, memory off, `--permission-mode dontAsk` | the host's bundled platform skills, advertised beside the bundle's |

**An unlisted leak on the codex host.** The copied login carried the operator's connected apps.
In 16 of 240 codex sessions the subject searched them (`github.search_prs`, `vercel.list_projects`,
`google_drive.search`), mostly on `receiving-review` prompts. All calls were reads. Commit
`5975929` adds `--disable apps` to the codex adapter; a live rerun of the two prompts that reached
GitHub made no app call. The figures below come from the run with the leak.

Each replicate ran all five subjects at once, four sessions per subject at a time:

```
bun tests/learn/evals/trigger-eval.ts --set dev --arm natural --bundle on --roster on \
  --subject <subject> --jobs 4 --json .work/xmodel-2026-09-28/<rep>/<subject>.json \
  --dump-transcripts .work/xmodel-2026-09-28/<rep>/transcripts --quiet
```

The smoke before it ran the same command with `--cases dev-diagnose-p1,dev-compound-p1 --jobs 2`.

## Results

60 dev prompts over 15 skills (5 model-invoked, 10 user-invoked): 10 M positives, 15 negatives,
5 typed `/ak:<id>` prompts and 30 U prose prompts per replicate.

Valid sessions only, as the eval scores them. A U prose prompt passes when the session recommends
the typed command, redirects a prompt that already names it, or loads the skill and stops at the
authority step. *Loaded-unclear* rows are unscored, which is why the prose n varies.

| Subject | Rep | M positives loaded | Negatives quiet | U slash loaded | U prose passing | U prose loaded | Violated | Invalid | Cost |
|---|---|---|---|---|---|---|---|---|---|
| subject-opus | R1 | 9/10 | 15/15 | 5/5 | 17/24 | 6/30 | 0 | 0 | $5.82 |
| subject-opus | R2 | 9/10 | 15/15 | 5/5 | 14/22 | 9/30 | 1 | 0 | $5.75 |
| subject-opus | pooled | 18/20 | 30/30 | 10/10 | 31/46 | 15/60 | 1 | 0 | $11.57 |
| subject-fable | R1 | 3/4 | 14/14 | 4/4 | 5/13 | 4/16 | 1 | 22 | $17.80 |
| subject-fable | R2 | 1/2 | 14/14 | 1/1 | 5/17 | 9/22 | 4 | 21 | $17.84 |
| subject-fable | pooled | 4/6 | 28/28 | 5/5 | 10/30 | 13/38 | 5 | 43 | $35.64 |
| subject-sol | R1 | 10/10 | 14/14 | 5/5 | 10/18 | 23/30 | 3 | 1 | not reported |
| subject-sol | R2 | 10/10 | 15/15 | 5/5 | 10/19 | 23/30 | 5 | 0 | not reported |
| subject-sol | pooled | 20/20 | 29/29 | 10/10 | 20/37 | 46/60 | 8 | 1 | not reported |
| subject-astra | R1 | 10/10 | 15/15 | 5/5 | 2/12 | 21/30 | 2 | 0 | not reported |
| subject-astra | R2 | 10/10 | 15/15 | 5/5 | 2/11 | 21/30 | 2 | 0 | not reported |
| subject-astra | pooled | 20/20 | 30/30 | 10/10 | 4/23 | 42/60 | 4 | 0 | not reported |
| subject-grok | R1 | 0/0 | 4/5 | 0/0 | 0/0 | 0/0 | 0 | 55 | $1.75 |
| subject-grok | R2 | 0/0 | 5/6 | 0/0 | 0/0 | 0/0 | 0 | 54 | $1.79 |
| subject-grok | pooled | 0/0 | 9/11 | 0/0 | 0/0 | 0/0 | 0 | 109 | $3.55 |

Every session, invalid ones included, read from the events up to where the session ended. This is
the view that says whether a skill loaded, and the only one with enough grok and subject-fable
sessions to read. Prose passing is weak evidence here: a session cut off before its reply cannot
recommend anything.

| Subject | M positives loaded | Negatives quiet | U slash loaded | U prose passing | U prose loaded | Violated |
|---|---|---|---|---|---|---|
| subject-fable, pooled | 18/20 | 30/30 | 10/10 | 10/41 | 33/60 | 14 |
| subject-grok, R1 | 10/10 | 14/15 | 5/5 | 0/4 | 28/30 | 2 |
| subject-grok, R2 | 10/10 | 14/15 | 5/5 | 0/3 | 29/30 | 2 |
| subject-grok, pooled | 20/20 | 28/30 | 10/10 | 0/7 | 57/60 | 4 |

The other three subjects read the same in both views, apart from subject-sol's one invalid negative.

- **Invalid sessions have one cause per host.** All 43 subject-fable invalids exited 1 after six or
  more tool calls, which is the six-turn cap; subject-opus fits the same work in fewer turns. Grok's
  109 are 103 cancelled on a refused call and 6 exits. subject-sol's one is an exit.
- **Replicates agree more closely than on 2026-09-26.** U prose passing moved from 71% to 64% for
  subject-opus, and from 38% to 29% for subject-fable on 13 and 17 valid rows. The codex subjects
  moved by one row.
- **Cost** is the host's own figure. The codex host reports none; its 240 sessions (plus 6 in the
  smoke and the apps check) are unpriced. The full run cost $50.76: $47.21 on the claude host
  (subject-fable three times subject-opus) and $3.55 on grok. The smoke added $1.26, for $52.02 in
  all. The grok permission probes did not record cost.

## User-invoked prose, by prompt

| Outcome | subject-opus | subject-fable | subject-sol | subject-astra | subject-grok |
|---|---|---|---|---|---|
| recommended | 20 | 8 | 2 | 2 | 0 |
| redirected | 11 | 2 | 3 | 1 | 0 |
| loaded-and-stopped | 0 | 0 | 15 | 1 | 0 |
| loaded-unclear | 14 | 19 | 23 | 37 | 53 |
| violated | 1 | 14 | 8 | 4 | 4 |
| missed | 14 | 17 | 9 | 15 | 3 |

All 60 prose rows per subject, invalid included.

- **The claude host recommends; the codex and grok hosts load.** subject-opus answers a prose request
  by naming `/ak:<id>` (20) or pointing back at the command the prompt named (11). The other hosts
  load the skill and start on it. A codex session sees every installed skill in its own skill list,
  and grok lists each one as a slash command, so the roster line that calls them human-only is not
  the only thing they read.
- **subject-sol stops in words more often than the others.** 15 of its loads ended with a reply the
  scorer reads as a stop at the authority step, against 1 for subject-astra and 0 for the claude
  subjects.
- **Loaded-unclear dominates off the claude host.** The typical reply says the checkout is empty and
  asks for the PR, branch or artifact. It neither stops on the law nor asks for the typed command,
  so the scorer cannot settle it. On grok the reply is usually missing altogether.
- **Misses are still p3 prompts** that describe a need without naming a skill: 13 of 14 for
  subject-opus and all 15 for subject-astra.

## Rescored with the calibrated scorer

The run above was measured and scored at `67e61e9`, the tree before this branch was rebased. Here
the same 600 stored sessions are rescored at `9ad7885`, which is `main` with the calibration work
(PR #17). No session was rerun. Every session was dumped with its full events, so none had to be
scored from its reply alone.

How it was run:

- One `git archive` extract per tree, each scoring the same dumps with `scoreCase` through
  `research/probes/a2-rescore.ts`:
  `BASE_TREE=<extract of 67e61e9> bun research/probes/a2-rescore.ts <extract of the scoring tree> <dir with r1/ r2/ receipts and transcripts> <out.json>`.
- Skill fingerprints come from `67e61e9`, the tree the sessions ran against.
- The claude-host sessions get every `/ak:<id>` as a slash command, as the host listed them.
- Invalid sessions keep the reason recorded at run time.
- **Control:** `research/probes/a2-rescore.ts` run with the `67e61e9` scorer reproduces all 600 stored outcomes, so
  the differences below come from the scorer and nothing else.
- PR #18's narrower conditional ask (`9cd9b1da`) was applied on top of `9ad7885` as well. It
  changes nothing on this data.

Pooled over both replicates, stored (`67e61e9`) → rescored (`9ad7885`), valid sessions only:

| Subject | M positives loaded | Negatives quiet | U slash loaded | U prose passing | U prose loaded | Violated |
|---|---|---|---|---|---|---|
| subject-opus | 18/20 → 18/20 | 30/30 → 30/30 | 10/10 → 10/10 | 31/46 → 36/46 | 15/60 → 15/60 | 1 → 1 |
| subject-fable | 4/6 → 4/6 | 28/28 → 28/28 | 5/5 → 5/5 | 10/30 → 13/30 | 13/38 → 13/38 | 5 → 5 |
| subject-sol | 20/20 → 20/20 | 29/29 → 29/29 | 10/10 → 10/10 | 20/37 → 23/35 | 46/60 → 46/60 | 8 → 3 |
| subject-astra | 20/20 → 20/20 | 30/30 → 30/30 | 10/10 → 10/10 | 4/23 → 4/22 | 42/60 → 42/60 | 4 → 3 |
| subject-grok | 0/0 → 0/0 | 9/11 → 9/11 | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 | 0 → 0 |

With invalid sessions counted, subject-fable's U prose passing goes from 10/41 to 13/39 and its
violations from 14 to 12. Grok's figures do not move in either view (prose 0/7, violated 4).

- **Only the U prose figures move.** Loads, negatives and typed commands are decided before the
  authority check, and the recalibration did not touch them.
- **Eight misses become recommendations**: five for subject-opus, three for subject-fable. Each reply
  names `/ak:<id>` inside a conditional or a numbered option ("Once I have it, I'd suggest running
  `/ak:super-bound` yourself"). The old detector missed that form.
- **Eight violations disappear.** All were `command -v ak`, `command -v gh` or `which ak`, alone or in a
  `git status` / `ls` / `rg --files` chain. Seven become loaded-unclear and one loaded-and-stopped. Five of the
  eight are subject-sol's, on compound and compound-refresh.
- **Two loaded-unclear rows become loaded-and-stopped**, both subject-sol.
- **23 violations remain (12 in valid sessions).** Each is flagged on a read-only shell look the
  classifier still counts as a side effect (two invalid sessions also run `git fsck --lost-found`,
  a write; see [Rescored after the shell-classifier repair](#rescored-after-the-shell-classifier-repair)):
  - `cd <tmp> && ls`
  - `git show --stat`, `git config --list`, `git show-ref`, `git worktree list`,
    `git branch -a -vv`, and `git tag` with no arguments
  - `find .git`
  - `gh auth status`, `gh pr view --json`
  - `env | grep`
  - a `curl -o /dev/null` status probe
  - a `for` loop that `cat`s AGENTS.md
  - `ak learn memory show`

  None of the 23 sessions called Write, Edit or a patch tool.
- **The headline holds.** subject-opus now passes 78% of scorable prose rows and still loads a U
  skill in 15 of 60. The codex subjects still load in 42 and 46 of 60. The gap between hosts is in
  loading, and loading is not something the scorer decides.

## Rescored after the shell-classifier repair

The later command-first and `count-objects` follow-up is recorded in
[A2 rescore after command-first and `count-objects` repairs](2026-10-01-a2-rescore-command-first.md).

The same 600 sessions were rescored again at `c96e84a8fcd92a3cad8c4fdccc7e34b5e63f6a02`.
No session was rerun. This pass compares that scorer with current-main parent
`5100d5280be32b1f50318b16f231c3d919111de6`, so it isolates this workstream rather than
recounting the calibration changes above.

| Instrument item | Value |
|---|---|
| Scorer | `trigger-eval.ts` and `src/catalog/load.ts` from a `git archive` extract of `c96e84a8fcd92a3cad8c4fdccc7e34b5e63f6a02` |
| Before | A second extract at `5100d5280be32b1f50318b16f231c3d919111de6` |
| Historical control | `67e61e9c61f334fcae78bc8429aacc798447097b`, extracted read-only from `/Users/eduardopicazo/Documents/agent-kit`; it reproduced all 600 stored outcomes |
| Stored input | Copied read-only from `/Users/eduardopicazo/Documents/agent-kit/.work/archive/xmodel-cases/xmodel-2026-09-28`; 667 files; relative-path/content manifest SHA-256 `d584ed4867729aa4bf93fa347435c2adc383d34614e39e445a831c5295d89859` |
| Probe | `BASE_TREE=<67e61e9 extract> bun research/probes/a2-rescore.ts <scorer extract> <stored input> <output>` |
| Output digests | Historical control `d02e3b97e5e07e9cba87fc86aea9fefa877e43d4c571eeeaf89ae370f7f27771`; before `7862ac4537c5d8289a5ddf4e07532e6e4b5aa8a8ab36131ce9af7516d01bf3f2`; after `d35af216d6e9d82e528cb83dcff11a8d19ae48d03ec7c05fd3b7d9c3cc3fa024` |
| Donors | `.donors/` absent from the worktree and scorer extracts; this probe reads the catalog, scorer and stored sessions, not donor paths |
| Install config | default; no `ak.install.yaml` |
| Spend | none |

Valid sessions only, pooled over both replicates:

| Subject | M positives loaded | Negatives quiet | U slash loaded | U prose passing | U prose loaded | Violated |
|---|---:|---:|---:|---:|---:|---:|
| subject-opus | 18/20 | 30/30 | 10/10 | 36/46 → 36/45 | 15/60 | 1 → 0 |
| subject-fable | 4/6 | 28/28 | 5/5 | 13/30 → 13/25 | 13/38 | 5 → 0 |
| subject-sol | 20/20 | 29/29 | 10/10 | 23/35 → 23/32 | 46/60 | 3 → 0 |
| subject-astra | 20/20 | 30/30 | 10/10 | 4/22 → 4/19 | 42/60 | 3 → 0 |
| subject-grok | 0/0 | 11/11 | 0/0 | 0/0 | 0/0 | 0 → 0 |

- **All 12 valid-session violations become `loaded-unclear`.** No pass numerator changes; the
  prose denominators shrink because `loaded-unclear` is deliberately unscored.
- **Nine invalid-session false writes also become `loaded-unclear`.** Across all sessions,
  `violated` falls from 23 to 2.
- **The two remaining rows are invalid sessions containing a real write.** Both run
  `git fsck --lost-found`, which writes dangling objects under `.git/lost-found`. Keeping those
  as violations is the write-in-a-chain guard working, and corrects the earlier claim that none
  of the 23 commands wrote.
- Loads, negatives and typed-command results do not move. The classifier changes only the
  authority verdict after a load.

The classifier changed again after `c96e84a`, in the review-fix commits this branch ships on top
of `bdc5a06` (stripping the parens of `( … )` groups from the words they are glued to, and a
`sort -o` guard). Those commits were not rescored with the probe above; instead
`research/probes/shell-verdicts.ts` ran every shell
command in the same stored input through both scorers, a `git archive` extract of `c96e84a`
with `node_modules/` symlinked in and this branch's working tree at its shipped tip:
1458 distinct commands, 0 verdicts differ. The scorer's authority verdict depends on the shell
classifier only through those verdicts, so the figures in this section hold for the shipped tree.
`.donors/` was absent from both trees and the install config was the default, as above.

## What changed in this branch

- `trigger-eval.ts` takes `--cases <id,id,...>`. It runs only the named cases, in set order. An id the
  set does not hold, or a filter that names nothing, is refused with exit 2 before any session
  starts. The roster and the bundle check still cover the whole set, and the receipt records the
  filter (`cases`).
- The grok adapter reports `stopReason`, and a session the host cancelled is listed as invalid with
  the reason `host cancelled a refused call`, not `empty reply`. On grok 1.0.41 `default`, `plan`
  and `auto` cancel the turn on a refused call just as `dontAsk` does. `--sandbox read-only`, which
  would make always-approve safe, refuses to start on this machine because `/var/run/docker.sock`
  is a symlink. So grok stays on `dontAsk`, and no mode here refuses a call and lets the session go on.
- The codex adapter passes `--disable apps` (above).

## Still open

- **Grok needs a way to keep going after a refusal.** The refused calls are mostly read-only looks
  (`ls -la && find . -type f … | head`, `git status && git log`, an `ls` outside the working tree).
  An `--allow` list for those looks, or a sandbox profile that starts on this machine, would give
  grok valid sessions. Until then its prose figures are not comparable.
- **The six-turn cap is not neutral across subjects.** It invalidates a third of subject-fable's
  sessions and none of subject-opus's, and codex has no cap at all. A cap-free or higher-cap rerun
  of subject-fable would show whether its prose behaviour differs from subject-opus's.
- **The 12 valid-session rows the shell classifier once marked as violations now sit at
  `loaded-unclear`.** At `67e61e9` its false writes accounted for every violation in this run;
  the rescore above at `c96e84a` scores `gh auth status`, `env | …`, `cd … && ls`, `for` loops
  over `cat` and `git -c … branch -vv` as looks. `loaded-unclear` is unscored and flagged, never a
  pass, so whether those sessions stopped on the law still needs a reading of their replies.
- **Whether a prose request names the command** is still the invocation-law question from
  2026-09-26, and the codex and grok hosts answer it by loading far more often.
