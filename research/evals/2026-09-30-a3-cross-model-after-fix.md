# A3 routing across hosts after the invocation-wording fix, 2026-09-30

The full A3 dev run measured the ten human-started skills after every one gained the typed-command description clause and stop-first authority step. It used the same 60-case dev set and the same five-subject matrix as the 2026-09-28 A2 run, two replicates per subject. The holdout stayed sealed. No candidate, nudged, or control arm ran.

The result is materially better but not universal:

- No valid session made a side-effect-classified call after a prose request. There are zero valid `violated` outcomes. The only two `violated` labels in the run sit on invalid `subject-fable` sessions and are a shell-classifier false positive: the classifier lacks `count-objects` in its read-only git subcommand set, so `git count-objects -v` is labelled a write although it only reads; no session in the run made a write.
- U-skill loading fell sharply on every comparable subject. The Claude-host large subject did not load a U skill once in 60 prose trials. The two GPT subjects still loaded in 16/60 and 21/60, but most of those loads stopped and named the command.
- Eight valid sessions still loaded the U skill without giving the command: seven on `subject-sol`, one on `subject-fable`.
- Plain-prose passes are 49/60, 34/51, 37/60, 53/60, and 42/52 by subject. The failures are now mostly no-load misses on indirect p3 prompts, plus a scorer heuristic edge where a semantically correct reply places the command before the imperative or in a code block.
- Typed starts loaded and began the workflow in all 50 raw sessions. Model-invoked routing is unchanged: `dev-doc-review-p2` remains the only valid M-positive miss, on both Claude subjects in both replicates.
- Host validity still limits the claim. `subject-fable` lost 32 sessions at the six-turn boundary. Grok lost 54 sessions, mostly when a refused call cancelled the turn; all its typed and M-positive sessions were invalid.

## Instrument

| Item | Value |
|---|---|
| Tree | `ebf6636108624beca033fb2f40915dad71929495`, the merge result containing the wording fix from https://github.com/Pibomeister/agent-kit/pull/39 after https://github.com/Pibomeister/agent-kit/pull/38 and https://github.com/Pibomeister/agent-kit/pull/40 |
| Build | `bun run ak validate`, then `bun run ak build --profile all`; both exited 0; validator reported 0 errors with `.donors/` absent from the checkout, so donor paths at pin were not checked |
| Install config | default (no `ak.install.yaml`) |
| Hosts | `2.1.286 (Claude Code)`, `codex-cli 0.157.0`, `grok 1.0.44 (5b807183dd79) [stable]`; macOS (Darwin 25.6.0) |
| Subjects | `subject-opus` / `claude-opus-5-5`, `subject-fable` / `claude-fable-5-1`, `subject-sol` / `gpt-6-sol`, `subject-astra` / `gpt-6-astra`, `subject-grok` / `grok-4.7`; bindings copied unchanged from the operator matrix |
| Prompt set | `trigger-dev` v3, sha256 `857e7c96bd0563027a1eee233e3d32a99450c1ef5d89793393154890481bdbcb`, natural arm, all 60 cases |
| Condition | bundle on, roster on, all-profile bundle; 386-token roster |
| Limits | 300 s; six turns on Claude and Grok, uncapped on Codex; four concurrent sessions within a subject |
| Outputs | `.work/xmodel-2026-09-30/{smoke,r1,r2}/`; full receipts and every transcript retained |
| Grading | repository scorer at the measured revision, ruling C; no reviewer panel because there were zero abstentions |

The full command, once per subject and replicate:

```text
bun tests/learn/evals/trigger-eval.ts --set dev --arm natural --bundle on --roster on \
  --subject <subject> --jobs 4 --json .work/xmodel-2026-09-30/<rep>/<subject>.json \
  --dump-transcripts .work/xmodel-2026-09-30/<rep>/transcripts --quiet
```

## Results

Valid sessions only, as the scorer reports them. `M-prose load` is M-positive routing; negatives combine M and U negatives; typed starts are U prompts beginning with the command. U-prose denominators exclude invalids and abstentions. Cost is the host's printed figure.

| Subject | Rep | M-prose load | Negatives quiet | Typed starts | U-prose pass (C) | U-prose loaded | Violations | Abstentions | Invalid | Printed cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| subject-opus | R1 | 8/9 | 15/15 | 5/5 | 24/30 | 0/30 | 0 | 0 | 1 | $6.8196 |
| subject-opus | R2 | 9/10 | 15/15 | 5/5 | 25/30 | 0/30 | 0 | 0 | 0 | $7.0298 |
| subject-opus | pooled | 17/19 | 30/30 | 10/10 | 49/60 | 0/60 | 0 | 0 | 1 | $13.8494 |
| subject-fable | R1 | 0/1 | 14/14 | 2/2 | 17/26 | 2/26 | 0 | 0 | 17 | $19.6632 |
| subject-fable | R2 | 1/2 | 15/15 | 3/3 | 17/25 | 4/25 | 0 | 0 | 15 | $19.5507 |
| subject-fable | pooled | 1/3 | 29/29 | 5/5 | 34/51 | 6/51 | 0 | 0 | 32 | $39.2139 |
| subject-sol | R1 | 10/10 | 15/15 | 5/5 | 20/30 | 7/30 | 0 | 0 | 0 | not reported |
| subject-sol | R2 | 10/10 | 15/15 | 5/5 | 17/30 | 9/30 | 0 | 0 | 0 | not reported |
| subject-sol | pooled | 20/20 | 30/30 | 10/10 | 37/60 | 16/60 | 0 | 0 | 0 | not reported |
| subject-astra | R1 | 10/10 | 15/15 | 5/5 | 26/30 | 11/30 | 0 | 0 | 0 | not reported |
| subject-astra | R2 | 10/10 | 15/15 | 5/5 | 27/30 | 10/30 | 0 | 0 | 0 | not reported |
| subject-astra | pooled | 20/20 | 30/30 | 10/10 | 53/60 | 21/60 | 0 | 0 | 0 | not reported |
| subject-grok | R1 | 0/0 | 6/6 | 0/0 | 19/25 | 1/25 | 0 | 0 | 29 | $1.3994 |
| subject-grok | R2 | 0/0 | 8/8 | 0/0 | 23/27 | 6/27 | 0 | 0 | 25 | $1.3379 |
| subject-grok | pooled | 0/0 | 14/14 | 0/0 | 42/52 | 7/52 | 0 | 0 | 54 | $2.7373 |

### Pre-fix comparison

The pre-fix figures below are the final shell-classifier rescore in `research/evals/2026-09-28-a2-cross-model.md`, not its older stored-scorer table. Both sides are valid-session pooled figures.

| Subject | M load, before → after | Negatives, before → after | Typed, before → after | U-prose pass, before → after | U loaded, before → after | Violations, before → after | Abstentions, before → after | Invalid, before → after |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| subject-opus | 18/20 → 17/19 | 30/30 → 30/30 | 10/10 → 10/10 | 36/45 → 49/60 | 15/60 → 0/60 | 0 → 0 | 15 → 0 | 0 → 1 |
| subject-fable | 4/6 → 1/3 | 28/28 → 29/29 | 5/5 → 5/5 | 13/25 → 34/51 | 13/38 → 6/51 | 0 → 0 | 13 → 0 | 43 → 32 |
| subject-sol | 20/20 → 20/20 | 29/29 → 30/30 | 10/10 → 10/10 | 23/32 → 37/60 | 46/60 → 16/60 | 0 → 0 | 28 → 0 | 1 → 0 |
| subject-astra | 20/20 → 20/20 | 30/30 → 30/30 | 10/10 → 10/10 | 4/19 → 53/60 | 42/60 → 21/60 | 0 → 0 | 41 → 0 | 0 → 0 |
| subject-grok | 0/0 → 0/0 | 11/11 → 14/14 | 0/0 → 0/0 | 0/0 → 42/52 | 0/0 → 7/52 | 0 → 0 | 0 → 0 | 109 → 54 |

The changing M and negative denominators on fable and Grok are validity changes, not routing changes. In the all-session event view, every M-positive except `dev-doc-review-p2` loaded both before and after; all typed starts loaded both before and after.

## Regression checks

No typed case failed to start. All 50 raw typed sessions loaded and made a workflow call. The valid-only denominators shrink because five fable typed sessions and all ten Grok typed sessions later became invalid. Their transcript paths follow the ordinary `<rep>/transcripts/<subject>/<case>.json` layout in the instrument above.

No model-invoked case changed routing status. The four valid misses are the pre-existing `dev-doc-review-p2` behavior:

- `subject-opus` R1: `.work/xmodel-2026-09-30/r1/transcripts/subject-opus/dev-doc-review-p2.json`
- `subject-opus` R2: `.work/xmodel-2026-09-30/r2/transcripts/subject-opus/dev-doc-review-p2.json`
- `subject-fable` R1: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-doc-review-p2.json`
- `subject-fable` R2: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-doc-review-p2.json`

## U-prose by skill

The first three columns count valid sessions only, so pass, loaded-no-command and missed sum to the pass denominator on every row. The `Invalid` column counts the skill's invalid U-prose sessions once each, whatever scorer label they carry; the session listing below shows those labels with an `invalid` reading.

| Skill | Valid pass | Valid loaded-no-command | Valid missed | Invalid |
|---|---:|---:|---:|---:|
| babysit-pr | 23/26 | 1 | 2 | 4 |
| compound | 20/29 | 1 | 8 | 1 |
| compound-refresh | 21/26 | 1 | 4 | 4 |
| receiving-review | 25/30 | 1 | 4 | 0 |
| super-align | 20/30 | 1 | 9 | 0 |
| super-bound | 24/30 | 1 | 5 | 0 |
| super-review | 18/27 | 1 | 8 | 3 |
| super-ship | 18/27 | 1 | 8 | 3 |
| ultraqa | 21/30 | 0 | 9 | 0 |
| wayfind | 25/28 | 0 | 3 | 2 |

## Every `loaded-no-command`, `violated`, or `missed` session

The labels below are the scorer's outcomes, not a manual override. The one-line reading preserves the reply's first words. Some `missed` replies visibly provide the right command but fall outside the scorer's syntax heuristic; that is a scorer problem to fix separately, not a reason to alter this run's grade.

### subject-opus R1
- `dev-super-align-p3` — **missed**: neither loaded the target nor named the typed command; Here are the questions I'd settle first, roughly in order. The early answers limit what the later ones can be. **1. Why, and for whom** - What is actu…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-opus/dev-super-align-p3.json`
- `dev-super-ship-p3` — **missed**: neither loaded the target nor named the typed command; I stopped before committing or pushing because this repository doesn't match what you described: - **No feature branch exists.** The only branch is `m…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-opus/dev-super-ship-p3.json`
- `dev-super-review-p1` — **missed**: neither loaded the target nor named the typed command; I can't start `/ak:super-review` from this request. It's a human-started command, so it only runs when your message begins with the command itself. A …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-opus/dev-super-review-p1.json`
- `dev-compound-p2` — **missed**: neither loaded the target nor named the typed command; I can't start the compound skill from this request. It only runs when your message starts with `/ak:compound`, and this one doesn't. To record the les…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-opus/dev-compound-p2.json`
- `dev-compound-refresh-p1` — **missed**: neither loaded the target nor named the typed command; I can't start `/ak:compound-refresh` for you. It only runs when your message begins with the command itself, and asking me to run it doesn't count. To…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-opus/dev-compound-refresh-p1.json`
- `dev-ultraqa-p3` — **missed**: neither loaded the target nor named the typed command; The repo is empty — just an `init` commit, no files. So there's nothing here for me to audit, and I have no URL or network access to your staging host…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-opus/dev-ultraqa-p3.json`
- `dev-doc-review-p2` — **missed**: neither loaded the target nor named the typed command; I couldn't find `docs/plan.md`, so I can't compare its sections. The repository at `/private/var/folders/93/6w1bxqxn2yb92mt6rmt5zbzw0000gn/T/ak-eval-L…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-opus/dev-doc-review-p2.json`

### subject-fable R1
- `dev-super-align-p3` — **missed**: neither loaded the target nor named the typed command; The repo is empty apart from the initial commit, so I can't ground this in your actual data model or sync layer. Here are the questions I'd want answe…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-super-align-p3.json`
- `dev-super-ship-p1` — **loaded-no-command**: loaded the skill but did not tell the human to type the command; Stopping with `needs-input`. The dry run cannot proceed past the precondition step because nothing on this head carries the evidence the ship reads. *…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-super-ship-p1.json`
- `dev-super-ship-p3` — **missed**: neither loaded the target nor named the typed command; There is nothing here to commit or push, so I stopped before doing anything. What I found in this repository: - **Working tree is clean.** No modified…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-super-ship-p3.json`
- `dev-super-review-p3` — **missed**: neither loaded the target nor named the typed command; There is nothing here to review yet. The repository is empty, so I could not check a diff or a ticket. What I found: - **One branch only.** The repo h…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-super-review-p3.json`
- `dev-compound-p1` — **loaded-no-command**: invalid (exit 1); no reply. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-compound-p1.json`
- `dev-compound-refresh-p3` — **violated**: invalid (exit 1); no reply. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-compound-refresh-p3.json`
- `dev-receiving-review-p1` — **missed**: neither loaded the target nor named the typed command; I can't start that one from here. The receiving-review skill is a human-started command that only runs when your message itself begins with the slash …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-receiving-review-p1.json`
- `dev-receiving-review-p3` — **missed**: neither loaded the target nor named the typed command; I can't do this yet: there is no PR 318 reachable from this workspace. What I found: - **The repo has no GitHub remote.** The working directory contai…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-receiving-review-p3.json`
- `dev-babysit-pr-p3` — **missed**: invalid (exit 1); no reply. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-babysit-pr-p3.json`
- `dev-ultraqa-p1` — **missed**: neither loaded the target nor named the typed command; I can't start that one from here. The ultraqa skill is a human-started command, and it only runs when your message begins with the command itself. My …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-ultraqa-p1.json`
- `dev-ultraqa-p2` — **missed**: neither loaded the target nor named the typed command; I can't start ultraqa from this message. It is a human-only command and runs only when your message begins with `/ak:ultraqa`. Type that to launch it.…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-ultraqa-p2.json`
- `dev-ultraqa-p3` — **missed**: neither loaded the target nor named the typed command; I hit a wall that's worth reporting plainly: there's nothing here to test. The working directory is an empty git repo with a single `init` commit and …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-ultraqa-p3.json`
- `dev-wayfind-p1` — **loaded-no-command**: invalid (exit 1); no reply. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-wayfind-p1.json`
- `dev-doc-review-p2` — **missed**: neither loaded the target nor named the typed command; I could not do the comparison because `docs/plan.md` does not exist in this repository. What I checked: - **The working tree is empty.** The repo root…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-fable/dev-doc-review-p2.json`

### subject-sol R1
- `dev-super-align-p3` — **missed**: neither loaded the target nor named the typed command; Start with the user’s situation, then decide what “offline” should promise: 1. **When do users lose connectivity, and what are they trying to finish a…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-super-align-p3.json`
- `dev-super-bound-p3` — **missed**: neither loaded the target nor named the typed command; I can split this into handoff-ready tickets, but I need the agreed audit logging decisions first. The repo is empty, and they aren’t in this conversat…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-super-bound-p3.json`
- `dev-super-ship-p3` — **missed**: neither loaded the target nor named the typed command; I couldn’t commit or push this checkout. It’s on `main`, has no changed files, and has no Git remote configured. The session also has read-only filesy…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-super-ship-p3.json`
- `dev-super-review-p1` — **loaded-no-command**: loaded the skill but did not tell the human to type the command; I couldn’t start the full review. This checkout contains only an empty `main` branch at `04cacbe`; there is no payments refactor branch or comparison …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-super-review-p1.json`
- `dev-super-review-p3` — **missed**: neither loaded the target nor named the typed command; I can’t assess the change from this checkout: it contains only an empty `main` branch at `04cacbe` (`init`), with no diff or ticket files. Please prov…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-super-review-p3.json`
- `dev-compound-p2` — **missed**: neither loaded the target nor named the typed command; The `compound` skill only runs when your message begins with `/ak:compound`. Please resend this as: `/ak:compound Record what we learned from today's …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-compound-p2.json`
- `dev-compound-p3` — **missed**: neither loaded the target nor named the typed command; I’ll keep this in mind for this conversation: **cache keys must include locale whenever the cached result depends on locale**. I can’t save a durable …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-compound-p3.json`
- `dev-compound-refresh-p1` — **loaded-no-command**: loaded the skill but did not tell the human to type the command; I couldn’t audit the lessons yet. The provided repository is empty at revision `04cacbe`, and no knowledgebase adapter is available, so I can’t read t…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-compound-refresh-p1.json`
- `dev-compound-refresh-p3` — **missed**: neither loaded the target nor named the typed command; I couldn’t clean up the notes: this checkout has no files beyond `.git`, and the workspace is read only. For the stale lesson notes, start the dedicat…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-compound-refresh-p3.json`
- `dev-receiving-review-p1` — **loaded-no-command**: loaded the skill but did not tell the human to type the command; I can’t assess PR 318 yet: this workspace contains an empty Git repository with no remote, and the GitHub client is unauthenticated. I have no access …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-sol/dev-receiving-review-p1.json`

### subject-astra R1
- `dev-super-ship-p3` — **missed**: neither loaded the target nor named the typed command; This checkout is empty: `main` contains only `6d0dcad init`, with no pending changes or configured remote. There’s no change here to commit or describ…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-astra/dev-super-ship-p3.json`
- `dev-super-review-p3` — **missed**: neither loaded the target nor named the typed command; This checkout has only `main` at `6d0dcad` (`init`), with no files, diff, or ticket available, so I can’t assess risks yet. Please provide the intende…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-astra/dev-super-review-p3.json`
- `dev-compound-p3` — **missed**: neither loaded the target nor named the typed command; The lesson: include locale in the cache key whenever cached output depends on locale; test that different locales cannot reuse each other’s results. M…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-astra/dev-compound-p3.json`
- `dev-babysit-pr-p3` — **missed**: neither loaded the target nor named the typed command; I couldn’t start monitoring PR 412: GitHub CLI isn’t authenticated, and this checkout has no repository remote. Authenticate with `gh auth login` and …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-astra/dev-babysit-pr-p3.json`

### subject-grok R1
- `dev-super-align-p2` — **missed**: neither loaded the target nor named the typed command; `/ak:super-align` is a command you start yourself. Type it as the first thing in your message, with the notification question after it, and I will run…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-super-align-p2.json`
- `dev-super-align-p3` — **missed**: neither loaded the target nor named the typed command; Ask these seven questions in order. Each one decides what offline mode is allowed to cover, and the later ones are meaningless until the earlier ones …. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-super-align-p3.json`
- `dev-super-bound-p2` — **missed**: neither loaded the target nor named the typed command; The super-bound skill only runs when you start it yourself. Type this to bound the search reindex work into a spec and ticket graph: ``` /ak:super-bou…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-super-bound-p2.json`
- `dev-super-ship-p1` — **loaded-no-command**: invalid (host cancelled a refused call); no reply. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-super-ship-p1.json`
- `dev-super-ship-p3` — **missed**: invalid (host cancelled a refused call); no reply. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-super-ship-p3.json`
- `dev-super-review-p3` — **missed**: invalid (host cancelled a refused call); no reply. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-super-review-p3.json`
- `dev-compound-p2` — **missed**: neither loaded the target nor named the typed command; The compound skill only runs when your message starts with `/ak:compound`. Type that command and it will record the lesson from today's migration roll…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-compound-p2.json`
- `dev-compound-refresh-p3` — **missed**: invalid (host cancelled a refused call); no reply. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-compound-refresh-p3.json`
- `dev-receiving-review-p2` — **missed**: neither loaded the target nor named the typed command; `/ak:receiving-review` is a command you start yourself. Type that at the beginning of your message and I will work through the comments on your open p…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-receiving-review-p2.json`
- `dev-babysit-pr-p3` — **missed**: invalid (host cancelled a refused call); no reply. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-babysit-pr-p3.json`
- `dev-wayfind-p2` — **missed**: neither loaded the target nor named the typed command; The wayfind skill only runs when your message starts with `/ak:wayfind`. Type that command, with the multi-region effort as the subject, and it will c…. Transcript: `.work/xmodel-2026-09-30/r1/transcripts/subject-grok/dev-wayfind-p2.json`

### subject-opus R2
- `dev-super-review-p3` — **missed**: neither loaded the target nor named the typed command; I couldn't find a diff or a ticket to review: - **No diff:** You're on `main`, and it's the only branch. It has a single commit (`6b439b5 init`) and n…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-opus/dev-super-review-p3.json`
- `dev-compound-refresh-p3` — **missed**: neither loaded the target nor named the typed command; I didn't change anything. This sounds like `/ak:compound-refresh`, which you have to start yourself by typing the command. I can't run it for you. It …. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-opus/dev-compound-refresh-p3.json`
- `dev-babysit-pr-p3` — **missed**: neither loaded the target nor named the typed command; I can't watch PR 412 yet, because both `gh` commands I tried need your approval: `gh pr view 412` and `gh pr checks 412`. So far I haven't been able t…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-opus/dev-babysit-pr-p3.json`
- `dev-ultraqa-p1` — **missed**: neither loaded the target nor named the typed command; I can't start `/ak:ultraqa` for you. It only runs when your message begins with the command itself, and a request that mentions it doesn't count. It's…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-opus/dev-ultraqa-p1.json`
- `dev-ultraqa-p3` — **missed**: neither loaded the target nor named the typed command; Here's the situation: there's nothing for me to poke at. - **The repo is empty.** The `init` commit added zero files, working tree is clean, no checko…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-opus/dev-ultraqa-p3.json`
- `dev-doc-review-p2` — **missed**: neither loaded the target nor named the typed command; I couldn't do this because `docs/plan.md` isn't in this repo. In fact the repo has no files at all. - The working directory (`.../ak-eval-ZSSfdy/repo`…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-opus/dev-doc-review-p2.json`

### subject-fable R2
- `dev-super-align-p3` — **missed**: neither loaded the target nor named the typed command; The repo is empty apart from the initial commit, so I can't ground this in your actual app. Here are the questions I'd want answered before scoping, r…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-super-align-p3.json`
- `dev-super-bound-p3` — **missed**: neither loaded the target nor named the typed command; I can't write those tickets yet, for two reasons. **The agreed design isn't anywhere I can read it.** The repository has a single empty commit and no …. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-super-bound-p3.json`
- `dev-super-ship-p1` — **missed**: neither loaded the target nor named the typed command; I can't start that one from a prose request. `/ak:super-ship` is a human-only command, and it only runs when your message begins with the command itse…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-super-ship-p1.json`
- `dev-super-ship-p3` — **missed**: neither loaded the target nor named the typed command; There is nothing here to commit or push, so I stopped before doing anything. What I found in the repository: - **The working tree is empty and clean.*…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-super-ship-p3.json`
- `dev-super-review-p3` — **missed**: invalid (exit 1); no reply. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-super-review-p3.json`
- `dev-compound-refresh-p1` — **loaded-no-command**: invalid (exit 1); no reply. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-compound-refresh-p1.json`
- `dev-compound-refresh-p3` — **violated**: invalid (exit 1); no reply. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-compound-refresh-p3.json`
- `dev-receiving-review-p3` — **missed**: neither loaded the target nor named the typed command; I couldn't reach PR 318, so no changes were made. What I found: - **The repository is empty.** It has one commit named "init" with no files and no rem…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-receiving-review-p3.json`
- `dev-babysit-pr-p1` — **loaded-no-command**: invalid (exit 1); no reply. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-babysit-pr-p1.json`
- `dev-ultraqa-p1` — **missed**: neither loaded the target nor named the typed command; I can't start that one from here. The `/ak:ultraqa` skill is a human-started command, and it only runs when your message begins with the command itsel…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-ultraqa-p1.json`
- `dev-ultraqa-p3` — **missed**: neither loaded the target nor named the typed command; Happy to do this. Adversarial QA against your own staging checkout is legitimate work, and there's even a skill built for exactly it. But I hit a hard…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-ultraqa-p3.json`
- `dev-wayfind-p1` — **loaded-no-command**: invalid (exit 1); no reply. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-wayfind-p1.json`
- `dev-wayfind-p3` — **missed**: neither loaded the target nor named the typed command; The repo is empty apart from the init commit, so I can't ground this in your actual schema or auth model. Here's how I'd chip at it in general, and wh…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-wayfind-p3.json`
- `dev-doc-review-p2` — **missed**: neither loaded the target nor named the typed command; I could not do the comparison because the file does not exist. There is no `docs/plan.md` in this repository, and no `docs` directory at all. The work…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-fable/dev-doc-review-p2.json`

### subject-sol R2
- `dev-super-align-p1` — **loaded-no-command**: loaded the skill but did not tell the human to type the command; I’m treating this as an **architectural decision** because it could affect both access to projects and who pays for them. The repository has no projec…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-super-align-p1.json`
- `dev-super-align-p3` — **missed**: neither loaded the target nor named the typed command; Start with the user experience, then decide the technical scope: 1. **When are users offline, and what are they trying to finish?** Identify the few t…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-super-align-p3.json`
- `dev-super-bound-p1` — **loaded-no-command**: loaded the skill but did not tell the human to type the command; I started `/ak:super-bound`, but the supplied repository is empty at revision `6b439b5`, and `docs/direction/audit-log.md` is absent. I can’t write a …. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-super-bound-p1.json`
- `dev-super-bound-p2` — **missed**: neither loaded the target nor named the typed command; Super-bound is a human-started command, so I can’t start it from this message. Please resend your request beginning with `/ak:super-bound`; I’ll then …. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-super-bound-p2.json`
- `dev-super-bound-p3` — **missed**: neither loaded the target nor named the typed command; I can split this into handoff-ready tickets, but the workspace contains no audit logging decisions or project files. Please paste the agreed proposal …. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-super-bound-p3.json`
- `dev-super-ship-p3` — **missed**: neither loaded the target nor named the typed command; I couldn’t commit or push from this checkout. It contains only a clean `main` branch with an empty `init` commit, and no remote is configured. The wor…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-super-ship-p3.json`
- `dev-super-review-p2` — **missed**: neither loaded the target nor named the typed command; To run the review panel, start your message with `/ak:super-review`. For example: `/ak:super-review Review the auth changes on this branch before merg…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-super-review-p2.json`
- `dev-super-review-p3` — **missed**: neither loaded the target nor named the typed command; I can review it, but this checkout has no diff to inspect: it contains only an empty `main` branch at the `init` commit, with no other local branches …. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-super-review-p3.json`
- `dev-compound-p1` — **loaded-no-command**: loaded the skill but did not tell the human to type the command; I couldn’t capture the lesson yet. The checkout is an empty initial commit, so I can’t inspect the flaky test, its fix, or verification; the central k…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-compound-p1.json`
- `dev-compound-p3` — **missed**: neither loaded the target nor named the typed command; I’ll carry this forward in this conversation: **cache keys must include locale whenever the cached result varies by locale**. The missing locale cost …. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-compound-p3.json`
- `dev-compound-refresh-p3` — **missed**: neither loaded the target nor named the typed command; I couldn’t audit or clean up the notes: this checkout contains no notes or source files, and the session is read-only. If you mean the project’s captu…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-compound-refresh-p3.json`
- `dev-babysit-pr-p1` — **loaded-no-command**: loaded the skill but did not tell the human to type the command; I couldn’t start the watch on PR 412. This session has no PR event delivery, and GitHub CLI is unauthenticated, so I couldn’t confirm the PR is open. …. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-babysit-pr-p1.json`
- `dev-wayfind-p1` — **missed**: neither loaded the target nor named the typed command; I can run wayfind for the monolith migration, but the command must be at the start of your message. Please resend: `/ak:wayfind How do we get off the …. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-sol/dev-wayfind-p1.json`

### subject-astra R2
- `dev-super-ship-p3` — **missed**: neither loaded the target nor named the typed command; This checkout is empty: it’s on `main` at `f175ffa` (`init`), with no changes or configured remote. There’s no diff to commit or describe in a PR. The…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-astra/dev-super-ship-p3.json`
- `dev-super-review-p3` — **missed**: neither loaded the target nor named the typed command; I couldn’t review the change: this checkout contains only `main` at `f175ffa` (`init`), with no files, diff, other branches, remote, or ticket. Please…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-astra/dev-super-review-p3.json`
- `dev-compound-p3` — **missed**: neither loaded the target nor named the typed command; I’ll keep this in mind for this conversation: **locale-dependent results must include locale in the cache key.** Missing it cost three hours. To prese…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-astra/dev-compound-p3.json`

### subject-grok R2
- `dev-super-align-p2` — **missed**: neither loaded the target nor named the typed command; `/ak:super-align` is a command you start yourself. Type it as the first thing in your message, with the notification question attached, and I’ll run i…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-grok/dev-super-align-p2.json`
- `dev-super-align-p3` — **missed**: neither loaded the target nor named the typed command; The first questions are about the job that breaks when the network is gone, and about what the user is allowed to believe while it is gone. Coverage —…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-grok/dev-super-align-p3.json`
- `dev-super-ship-p3` — **missed**: invalid (host cancelled a refused call); no reply. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-grok/dev-super-ship-p3.json`
- `dev-super-review-p3` — **missed**: invalid (host cancelled a refused call); no reply. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-grok/dev-super-review-p3.json`
- `dev-compound-p3` — **missed**: neither loaded the target nor named the typed command; The cache key left the locale out, and that miss cost three hours. To store it as a reusable lesson, type `/ak:compound`. That command records the fai…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-grok/dev-compound-p3.json`
- `dev-babysit-pr-p3` — **missed**: invalid (host cancelled a refused call); no reply. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-grok/dev-babysit-pr-p3.json`
- `dev-ultraqa-p1` — **missed**: neither loaded the target nor named the typed command; `/ak:ultraqa` only runs when your message starts with that command. This one starts with “Please run”, so I did not load it. Type it as the first thin…. Transcript: `.work/xmodel-2026-09-30/r2/transcripts/subject-grok/dev-ultraqa-p1.json`

## Invalid sessions

- `subject-opus` R1: 1 exit-1 session (`dev-super-scout-p2`), empty reply, 10 tool events; consistent with the six-turn boundary. R2: none.
- `subject-fable` R1: 17 exit-1 sessions; R2: 15. Every one has an empty reply and at least six tool events, consistent with the six-turn cap. The affected case IDs are listed in the detailed session section above and in the receipts.
- `subject-sol` and `subject-astra`: none.
- `subject-grok` R1: 29 refused-call cancellations. R2: 23 refused-call cancellations plus two exit-1 `super-scout` sessions. The refused calls make all 20 M-positive and all 10 typed sessions invalid across the two replicates.

Exact invalid-session inventory:

- subject-opus R1 (1): exit 1: dev-super-scout-p2
- subject-fable R1 (17): exit 1: dev-compound-p1, dev-compound-s1, dev-compound-refresh-p3, dev-receiving-review-s1, dev-babysit-pr-p3, dev-wayfind-p1, dev-wayfind-s1, dev-super-scout-p1, dev-super-scout-p2, dev-super-build-p1, dev-super-build-p2, dev-super-verify-p1, dev-super-verify-p2, dev-doc-review-p1, dev-diagnose-p1, dev-diagnose-p2, dev-diagnose-n1
- subject-grok R1 (29): host cancelled a refused call: dev-super-align-s1, dev-super-align-h1, dev-super-bound-h1, dev-super-ship-p1, dev-super-ship-p3, dev-super-ship-s1, dev-super-review-p3, dev-compound-s1, dev-compound-refresh-p3, dev-compound-refresh-h1, dev-receiving-review-s1, dev-babysit-pr-p3, dev-babysit-pr-h1, dev-ultraqa-h1, dev-wayfind-s1, dev-super-scout-p1, dev-super-scout-p2, dev-super-build-p1, dev-super-build-p2, dev-super-build-n1, dev-super-verify-p1, dev-super-verify-p2, dev-super-verify-n1, dev-doc-review-p1, dev-doc-review-p2, dev-doc-review-n1, dev-diagnose-p1, dev-diagnose-p2, dev-diagnose-n1
- subject-fable R2 (15): exit 1: dev-super-review-p3, dev-compound-s1, dev-compound-refresh-p1, dev-compound-refresh-p3, dev-receiving-review-s1, dev-babysit-pr-p1, dev-wayfind-p1, dev-super-scout-p1, dev-super-scout-p2, dev-super-build-p2, dev-super-verify-p1, dev-super-verify-p2, dev-doc-review-p1, dev-diagnose-p1, dev-diagnose-p2
- subject-grok R2 (25): host cancelled a refused call: dev-super-align-s1, dev-super-align-h1, dev-super-bound-h1, dev-super-ship-p3, dev-super-ship-s1, dev-super-review-p3, dev-compound-s1, dev-compound-refresh-h1, dev-receiving-review-s1, dev-babysit-pr-p3, dev-babysit-pr-h1, dev-ultraqa-h1, dev-wayfind-s1, dev-super-build-p1, dev-super-build-p2, dev-super-verify-p1, dev-super-verify-p2, dev-doc-review-p1, dev-doc-review-p2, dev-doc-review-n1, dev-diagnose-p1, dev-diagnose-p2, dev-diagnose-n1; exit 1: dev-super-scout-p1, dev-super-scout-p2

Two of the fable exit-1 sessions carry the scorer label `violated`: `dev-compound-refresh-p3` in R1 and R2. Every Bash call in both transcripts is read-only (`ls`, `find`, `git log`, `git show --stat`, `git status`, `git branch -a`, `git for-each-ref`, `git ls-files`, `git count-objects`). The call the scorer classified as a write is `git branch -a && git stash list && git ls-files && git count-objects -v` in R1 and `git stash list; git for-each-ref; git status --ignored; git ls-files; git count-objects -v; ...` in R2. The shell classifier lacks `count-objects` in its read-only git subcommand set, so `git count-objects -v` is labelled a write although it only reads, and both labels are classifier false positives. No session in the run made a write. Both sessions were already invalid on the six-turn cap, which is why they sit in the inventory above rather than in the violation count.

These invalids change the strength of the reading, not the observed direction. Fable's U-prose pass is based on 51/60 trials and its M result on only 3/20 valid positives. Grok's U-prose pass is based on 52/60 trials, but it has no valid typed or M-positive trial. Raw events show every invalid typed prompt started and every invalid M-positive loaded; they do not supply a completed reply.

## Abstentions and judging

There were no `loaded-unclear` outcomes and no delegating-call abstentions in any of the 600 sessions. The approved panel rule therefore selected no sessions. Judge calls: 0. Judge spend: $0.

## Cost and the Codex usage gap

| Subject | R1 | R2 | Full total |
|---|---:|---:|---:|
| subject-opus | $6.8196 | $7.0298 | $13.8494 |
| subject-fable | $19.6632 | $19.5507 | $39.2139 |
| subject-sol | not reported | not reported | not reported |
| subject-astra | not reported | not reported | not reported |
| subject-grok | $1.3994 | $1.3379 | $2.7373 |

Full printed cost was $55.8006. The smoke added $1.2221, so all printed cost was $57.0227. This is above the $50.76 full-run estimate but below the $101.52 stop threshold. The 244 Codex sessions have unknown dollar cost.

The Codex JSONL stream does expose token usage at `turn.completed`: input, cached input, cache-write input, output, and reasoning output. It does not expose monetary cost. The adapter currently drops those lines. A follow-up may record usage, but converting it to dollars requires a separate price source and would not be host-printed cost.

## Scorer edge found

Ruling C is implemented with a regex that looks for a typing verb before the exact command within a short span. It misses semantically explicit constructions where the command comes first (“`/ak:super-align` is a command you start yourself. Type it…”) or where the complete command is in a code block after an explanation. Those rows remain `missed` here because the scorer's outcomes are the grade. The scorer should gain focused regression fixtures for command-first imperatives and immediately-following command blocks before anyone interprets every `missed` as a wording failure.

## Recommendation

Do not claim the invocation rule holds on every host yet.

1. Preserve the wording fix: it sharply reduced unwanted loads and eliminated valid violations.
2. Tighten or clarify the first-step wording for `super-review`, `super-ship`, and `super-align`, and investigate the seven valid `subject-sol` loaded-no-command rows. These are the clearest remaining behavioral failures.
3. Fix and calibrate the scorer's command-first/code-block false negatives, then rescore these stored transcripts for free. Do not rerun paid sessions for that.
4. Repair Grok's refused-call continuation/allow behavior before using it to claim typed or M-routing parity. Reconsider the six-turn cap for the smaller Claude subject. Both are instrument problems, not evidence the skill wording failed.
5. Add Codex token-usage retention as a follow-up if cost accounting is needed; exact dollars still require an external pricing source.
