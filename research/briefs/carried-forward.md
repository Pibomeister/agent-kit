# Carried forward — obligations that must reach a later batch

Written because the obligations below existed only in messages and in the team lead's context,
which is the same defect found in §12.2 on 2026-09-19: a durable obligation recorded in a handback
leaves no trace in the tracked tree, so a resolved obligation and a forgotten one are
indistinguishable to anyone reading the repo. `.omc/` is gitignored and no handback has ever been
committed. This file is tracked; that is the whole point of it.

**How to use it.** Each entry names the batch that must carry it and the reason it cannot be
re-derived from the contract. When a brief is written for one of these batches, the entry is copied
into that brief and **deleted here in the same commit**. An entry left standing after its batch has
landed is a defect, not a record — the same retirement discipline `d664d00` applied to §10's
disclosure paragraphs.

---

## Batch 3 — landed, review in flight

Six entries at `05a431d`: skills `super-align`, `super-bound`, `wayfind`, `doc-review` and
references `codebase-design`, `domain-modeling`. An independent reviewer is seated against the
artifacts and writes `research/reviews/batch-03-define.md`.

Two things it produced that outlived it. Its contract defect against §7 is **ruled and retired** at
`57ea582` — `evals/` is now in `SCAN_DIRS`, and §7 names both symbols that decide whether a tree is
scanned rather than the one that cannot answer. Its four over-target bodies (168, 175, 168, 188
against a 150-line target) are the reviewer's to judge, not a finding on their own; four of four is
a norm to test, not four accidents.

Carried to batch 4 and already written into its brief: write a relative reference once per line,
because the packager's two-spelling defect (`1afe016`) is unrepaired and raises `links.broken-bundle`
against the author's source line for a file the packager itself wrote.

## Batch 5 — review-ship

**Two practices belong in this brief, not in `AUTHORING.md`** — both govern how lanes talk to each
other rather than how bodies are written.

*A correction you send to a teammate is checked by rebuilding the measurement, not by re-reading what
you sent.* Re-reading finds a claim consistent with itself, because it was consistent when written —
the same instrument under both hypotheses, pointed at your own output. Re-deriving runs a different
instrument against the world. Proposed by `provmap` after they caught and retracted their own
incorrect correction of another lane.

*Sweep for the figure; do not repair the surface you were handed.* The transcript line count was
reported wrong on one surface. Sweeping for it found two more, one of which was **enforcing**:
`schemas/common.schema.json` `$defs.g_locator` ended `226[0-4]`, rejecting `G:L2265` — the
transcript's last line — while the description beside it stated the bound as `1..2264`. A wrong rule
plus wrong documentation of that rule is one defect with its own alibi: every instrument a confused
author reaches for confirms the error, and they renumber a correct citation down to fit. Latent, like
the `arch` trap, and the same shape — a rule that has never fired, waiting for the first person to do
the correct thing.

**§6.2 is an input to this brief, not background.** Two rows of
`provenance/conversation-map.yaml` settle here rather than earlier, and the brief must say so
explicitly or the writer will treat them as already dispositioned. Confirmed with `provmap`.

**The implementer-approval-context sentence is flagged "ruled elsewhere."** The brief must carry the
flag so the writer does not re-derive the ruling or, worse, restate it in narrower terms — the
failure mode that produced F-1 and F-2 in batch 2.

**The batch-5 checkpoint gates on arch §10 scenarios 1, 3, 4, 6, 7, 8, 10, 18, 20.** Scenarios **7
and 20 have no ruling** in `policies/resolved-conflicts.yaml`. That is a gap to close before the
checkpoint runs, not at it: a checkpoint gating on a scenario with no ruling has nothing to check the
behaviour against.

**`super-ship` is dry-run only at the checkpoint.** The PR payload is generated locally and nothing
is pushed. This is a constraint from the implementation plan, not a suggestion.

**Three verification rules belong in this brief, and they are one family.** Each was found by an
agent being wrong about their own instrument, which is why they are worth stating rather than
assuming:

- **The population check.** Name the population the check owns, then verify every member reaches a
  term in the output. Replaces the counterfactual form, which requires naming the hypothesis — and
  the hypothesis that catches you is the one you did not think of. In `AUTHORING.md` §8 as of
  `9e8ca8e`. Predicts where to look: any check whose output is a tally rather than a list.
- **Reporting on the tree versus reporting on itself.** A gap in the tree is a fact the probe
  reports, and whether to gate on it is a per-probe call. A source the probe can no longer read is a
  fact about the probe, and every number underneath it is worthless — that exits non-zero
  unconditionally, in any probe, whatever its reporting half does.
- **The clause narrower than its rule.** Three separate findings in batch 2 were one defect: a
  clause whose population is narrower than the rule it cites, surviving because the narrower clause
  is the one a reader supplies unprompted. The instruction that generalises is not "check the
  citations" but "name the population the cited rule owns, then check the citing sentence reaches
  every member."

**A clean validate is evidence about the instruments, not about the tree.** The 29-body row-2 sweep
changed no `ak validate` output at all — 0 errors, 4 warnings, 49 notes before and after — because
nothing enforced §12.2's mandated rows. A handback saying a check came back clean owes a second
sentence saying what that check could not have seen. §8 requires this as of `9e8ca8e`.

## Batch 6 — packs and references

**Make `tsc --noEmit` a gate at this boundary, with the `v0.1.0` tag** — not before. Deliberately
not inside a batch: measured 2026-09-19, `bunx tsc --noEmit` exits **1** with **30 errors, all
`TS7006` in a single untracked `tests/sideeffects.test.ts`** belonging to a lane mid-flight. That is
the attribution problem the timing rule exists for, observed rather than predicted. **Pinning is a
separate question and is not deferred** — see the open commission.

Until it gates, the standing rule is that an invariant expressed as a type must also have a test,
because the two instruments are blind in complementary directions on the same fact.
`DOCUMENT_REFERENCE` is a runtime regex and `DocumentKeyword` is a declaration — one fact on two
surfaces with no link between them:

| mutation | `tsc --noEmit` | the runtime test |
|---|---|---|
| widen the regex, leave the type | exit 0 — blind | 2 fail |
| widen the type, leave the regex | exit 1, TS2741 | 0 fail — blind |

Neither instrument substitutes for the other, and a fact carried on two unlinked surfaces is §5's
rule appearing inside `src/`.

**Three retroactive edits land with this batch**, each touching a body authored in an earlier,
now-closed batch:

| Body | Authored in |
|---|---|
| `super-build` | batch 4 |
| `super-review` | batch 5 |
| `doc-review` | batch 3 |

These are cross-batch edits, which §12.2's backward-reach paragraph normally routes to the earlier
batch's fix cycle. Batches 3, 4 and 5 will be closed and out of cycles by then, so the routing the
paragraph specifies will not exist. Decide the mechanism when the brief is written; do not let the
writer improvise it.

**`references/prose-quality` arrives in this batch** and batch 3's `doc-review` names it as a
backticked path with no `./` prefix — deliberately not a link, so it does not break while the pack is
absent. Batch 6 converts it to a real link. See `research/briefs/batch-03-define.md` for why that
spelling was chosen; `src/util/links.ts` is what makes the distinction real.

**`v0.1.0` is tagged at the end of this batch.** The plan's "useful first operational release" is
reached here.

## Unrouted — reaches backwards into a closed batch

**`doc-review/feasibility` / `plan-review/architect`** is an unresolved candidate pair in §12.2's
table. Both seats are `status: authored`; `plan-review/architect` was authored in batch 1, which is
closed and out of fix cycles. §12.2 says leaving a candidate unresolved is not an option and routes
backward-reaching pairs to the earlier batch's fix cycle — a cycle that no longer exists. Routed to
`authoring` as a contract-level question on 2026-09-19; it has no owner until that is answered.

The sibling pair, `doc-review/design-lens` / `code-review/frontend-races`, is entirely within batch 2
and is in that batch's cycle-2 fix.

## Open commissions — lanes holding work that is not in any batch

Recorded because a commission that lives only in a message has exactly the defect this file exists
to fix: an issued one and a completed one are indistinguishable to anyone reading the repo. Each
entry is deleted when its lane reports and the result lands.

**The §8 sweep — `sweep-reviewer`, four findings edited and landed, three members still owed.**
Findings 1–4 are discharged and verified at `82b663f`: §12.2's doubled "verbatim" and the live
`BUDGETED` gate described as hypothetical, both at `2e3b091` — "hypothetical" now occurs zero times
in the file; §11's six hand-checks at `1b28463`; and §1, which owned the length rule while naming no
symbol, now names `budget.skill-over-target` and `budget.skill-over-cap` at its first statement of
it. **§10's register half, §12.1 and §12.5 are declared-not-cleared** — the sweep is not discharged
until they are reached, and reporting them unaudited rather than implying a clean population is the
reason the rest of the result can be trusted.

An expectation of mine was falsified in the process and the correction matters more than the finding:
I said a section overstating its enforcement gets caught the first time someone relies on it. It does
not. **Overstatement is caught when reliance fails, and reliance on an over-strong claim fails
silently, because the gate still passes.** §12.2's "verbatim" was relied on from `ed81a69` by a
writer, two reviewers and me, and caught by none of us.

**Original commission, for the record —** §8 requires
naming the population a check owns, then verifying every member reaches a term in the output.
`authoring` applied it to §9, found §9 understating its own gate, fixed it at `d5b8c9c`, and asked
that the remaining sections be swept **by someone other than them** — §8 is theirs and they had
twice found what they were primed to find. Deriving the population is the first half of the job;
the twelve section headings are not it. The defect shape is a section whose prose describes a
weaker obligation than what it governs actually enforces, which reads as conservative rather than
wrong and so is never audited for. Reports to the lead; `authoring` owns the edits.

**The phantom-reference sweep — `personas`.** Both known instances are already handled: `arch §`
fixed at `5d5e1dc`, `scratchpad/gen.ts` disclosed in place at `tests/fixtures/restatement-cases.ts`.
Neither was found by looking; both were tripped over, and the population was never enumerated, so
"no known instances" describes what we happened to hit rather than the tree. The interesting cell
is a reference both invisible to `src/util/links.ts` (backticked, no `./` prefix) **and**
non-existent — neither the link check nor a grep covers it, and both known instances lived there.
Three buckets, not two: broken, disclosed-but-unfixed, and right-by-accident. The third is green
today, which is why nothing finds it.

**The construct census beyond `policies/` — `policies`, authorized.** Stays with the lane that
built the instrument; a second lane re-deriving the method would yield two censuses agreeing for
reasons neither could state.

**Block-sequence `rulings:` must leave its current state — `policies` + `cli`.** Zero instances at
every depth, still supported, and both tests that exercised it were written in that form and both
were broken. Every green run proves the fixture agrees with the parser, which a fixture written
against the parser does by construction. Two exits: produce a real instance (better, if a document
genuinely wants the form) or drop support so it fails loudly instead of misparsing. **A third
synthetic fixture is not an exit** — it adds no information about whether the parser is right.

**Gate the typecheck now — `cli`, ruling reversed at `76e57ba`.** The pin landed at `b06c73a` and
verifies three ways: `tsc --version` 7.0.2, `--noEmit` exits 0, `--listFiles` shows 72 `.ts` files
including every in-flight untracked one, and a planted `const x: number = "nope"` reports TS2322.
All three legs — it runs, it has a population, and it can fail. The gate was deferred to batch 6
because `tsc` was exiting 1 with thirty `TS7006` errors; that condition is gone, so the deferral
expires with it. A gate added to a clean tree costs one line. A gate added at batch 6 first has to
clean up whatever batches 4 and 5 accumulated unchecked, arriving exactly when the checkpoint and
the `v0.1.0` tag compete for the same attention. Open question inside it: `research/probes/
denylist-reach.ts` is outside `tsc`'s file set because `tsconfig.json` scopes to `src/` and
`tests/` — defensible as a choice, not as an unnoticed glob.

**The two-surface inventory — `provmap`, list only, do not fix.** The original framing of this
commission was wrong and is corrected here rather than quietly dropped: the claim was that this
repository has no typechecker and every annotation in `src/` is therefore documentation. It is
reachable via `bunx` and it runs. What is true is narrower and more useful — a fact carried on both
a runtime surface and a type surface is enforced by neither instrument alone, because each is blind
to the mutation the other catches. Enumerate those pairs in `src/`: regex-plus-union, parsed-shape-
plus-interface, catalog-key-plus-`Record`. Some will want a test, some a type, some both, and
`DOCUMENT_FILE`'s index check is the case no `tsc` run would ever produce, because it asserts a
relationship between a mapping and a resource rather than a shape.

**Falsifying the mandated-rows gate — `sweep-reviewer`, queued behind the §8 sweep, and a third
case added at `76e57ba`: a row carrying both required fragments and the citation that then states
the opposite of an unchecked clause.** The two existing cases both test whether the gate notices
*less* text than the ruling; nothing measures whether it can tell a compliant row from an inverted
one, which is the worse failure. The live proof that inversion happens is `ba02021`, where
AUTHORING.md's own §12 contradicted `required-lane-failure-is-unavailable` on the exact clause row 2
does not check. First case is
a body whose row is correct in words but rewrapped.

**The batch-5 checkpoint fixture repo — `schemas`, commissioned.** The plan's checkpoint drives one
bounded change end to end in a throwaway git repo, and the repo does not exist. Nothing in the batch
structure produces it: `tests/fixtures/{valid,invalid}` are validator fixtures, and every
"checkpoint" occurrence in `policies/` is the supervisor-checkpoint sense from `authority-defaults`,
a different concept sharing a word. Batch 5 hands straight into it, so it is the thing standing
between the catalog and its first evidence that the spine works.

It went to `schemas` because the fixture is mostly artifacts bound by contracts that lane wrote — an
approved ticket under `ticket.schema.json`, a seeded bug findable as a `finding.schema.json` whose
`fingerprint` is not line-number-derived, receipts that can say `inconclusive` distinctly from
`not-run`, review artifacts separating comparison base, reviewed head and last verified head. A
schema that cannot express what the slice needs is the most valuable thing the commission can
return, and now is far cheaper than during the checkpoint.

**The constraint the commission leads with: build it so the checkpoint can fail.** A seeded bug a
`super-scout` pass hands over directly proves nothing about the review seat that then "finds" it. If
every path through the fixture ends in closure, scenario 3 is untestable on it; if no required lane
can be made unavailable, scenario 4 is; if the bug does not sit in a caller the change leaves
untouched, scenario 8 is. A fixture that cannot produce a failing checkpoint is an instrument
returning the same answer under both hypotheses, which is the one thing a checkpoint may not be.

Two boundaries carried with it. `super-ship` is **dry-run only** and the fixture has no remote it
could push to — if any part of the slice appears to need one, that is a report, not an addition. And
the lane that builds the fixture does not drive the slice through it, which is the same
self-approval rule the catalog is written against.

## Needs an owner — not yet commissioned

**`scratchpad/gen.ts` was never committed.** `tests/fixtures/restatement-cases.ts` says to
regenerate against a revision and commit the diff; that instruction cannot be followed. The header
discloses this honestly and states what remains reproducible without the generator, so this is a
debt rather than a defect. Whoever restores it inherits one specific obligation the header names:
`invocation-lesson-publish-ship-clause` was **re-scored by hand** when YAML citation scope narrowed
from the file to the mapping, by running the same scan the generator would have run. That one
number is to be verified, not trusted.

## Firstmate integration — obligations on work that is not built

Landed with `adapters/firstmate/` and ADR-0002. Each entry is blocked on a dependency, not on this
batch, and each names what must change when the dependency lands.

**Knowledgebase evidence.** `ak firstmate preflight` and `bind` refuse `--evidence kb` outright,
because no knowledgebase exists and the adapter supplies no `kb-write`. When the knowledgebase adapter
is built, `checkEvidence` in `src/firstmate/checks.ts` must call its readiness check instead of
refusing, and the mock-forces-dry-run rule in `schemas/firstmate-binding.schema.json` stays. Until
then every Firstmate task under agent-kit is a dry run.

**Runner-validated grants.** The binding names a charter by hash and nothing checks a sensitive action
against it; super-ship's charter gate is the only control. When the runner exists, the binding's
`charter` is what it validates against, and `ak firstmate bind` should refuse a charter the runner
rejects.

**Cross-task child budgets.** `child_budget.charged_to` names the parent run, and nothing totals spend
across relaunches, because there is no run ledger. A relaunched worker starts a fresh count.

**Autopilot's independent judgments.** CONTRACT.md §2 says Firstmate dispatches them as separate
agents. Nothing in patch 0001 does that yet; it is a supervisor instruction in `AGENTS.md` text only.

**The child guard on hosts other than Claude Code.** It relies on `agent_id` in PreToolUse input,
observed on Claude Code 2.1.281. A host upgrade that drops the field makes the guard a no-op; re-run
the probe recorded in ADR-0002 after each host upgrade. Codex has no equivalent hook, and the rule is
prose there.

**A live run.** No Firstmate + worker + subagent run has been performed. The first one is its own
batch: a scratch Firstmate home at `a5d78f8` with patch 0001, the sample fixture project, a mock
evidence store and dry-run delivery, with the transcript kept as the receipt.

## Standing traps — not batch-scoped

**`plan` and `arch` are two spellings of one document.** The architecture document is
`research/sources/engineering-skills-repo-plan.md`, 676 lines, registered in
`provenance/upstream.lock.yaml` as local source id `plan` and anchored by digest. The locator
grammar accepts both `plan §N` (255 rows use it) and `arch §N` (no row uses it). The file's
`-repo-plan` suffix is why two names grew for one file.

The *implementation* plan is a third document, is not in this tree, and `plan §N` does not mean it.
`policies/resolved-conflicts.yaml` uses `plan:` for the architecture document's sections, so reading
`plan` as the implementation plan misreads 255 rows.

**Nothing enforced §12.2's mandated verbatim rows** until the gate commissioned on 2026-09-19. The
narrowed row survived in 29 bodies from `ed81a69` through a writer, two reviewers and every
instrument in `src/`. If that gate is not in the tree when a later batch authors a role body, the
same failure is available again.

**Before commissioning work to close a gap, read every input the consumer receives.** Scenario 7 —
a one-line fix still gets a delta review — binds no row in `resolved-conflicts.yaml`, and the two
rulings nearest it govern panel composition and delta scope, neither of which answers it. Batch
writers do not receive the plan, so the reasoning went: the fact is not in the writer's inputs, the
nearest thing in them points the wrong way, commission a ruling. The fact was in the writer's
inputs. `research/dossiers/review-ship.md` pairs scenarios 1 and 7 in one sentence at its line 167
and grounds scenario 7 in plan §6.3 at line 1196 — the exact disambiguation the ruling would have
restated, in an input that had not been opened.

The commission was not sent, so this cost nothing but the time to check. It is the same class as
the absence-claim repaired at `7f159d8`: a search run against where the record was expected to live
rather than against the population of places it could live. Naming one input a fact ought to be in
is not declaring the set of inputs the consumer gets, and only the second is checkable. For a lead
about to commission seven more batches, the population is the brief's own inputs table.

**An extract is not the tree until you have shown it reproduces the tree's own figure.** Building
one by hand with `rsync -a --exclude '.git'` silently removes every donor clone's git directory,
because the pattern is unanchored and matches at any depth. The result validated at 101 errors
where the source tree had 0 — all of them `provenance.source-not-at-pin`, a check that was
answering honestly about a tree I had quietly made different. Anchor root-only excludes as
`/.git`, and make the extract print the source tree's figure before you read anything else from
it: `research/probes/validate-figure.sh` avoids the whole class by using `git archive` rather than
a copy, and is the right tool whenever the figure will be quoted.

The general form is worth more than the flag. A copy made to isolate a measurement is itself an
instrument, and an instrument nobody calibrated returns numbers that look exactly like results.

**Seven undercounts across three lanes in one day, and they are not one failure.** Each wants a
different guard, and the guards do not substitute for one another.

*Memory wants a sweep.* Four of the seven were someone enumerating their own material from
recollection — §5's "four places", `baca1d3`'s "two research documents", one absolute-path file
that was six, two derivations that were three. Every one was corrected by somebody else's search.
The fix is to sweep a written-down population rather than list what you remember putting there.

*A moving tree wants a revision.* Three were correct sweeps over a tree that changed underneath
them: `bun test` at 807 and then 829 hours apart, a `const lines` population at 12 and 13 within
the hour, a test total quoted twice by people who had each just insisted on a revision for a
validator figure. Conflating this with the first gets you a sweep with no date, which fails the
second way while looking like it has addressed the first.

*A reading that passed through anything but the file itself wants a second reading by a different
route.* This one defeats both guards above and is the reason it is worth naming separately.
`authoring` read a file via `f=$(git show ...)` and then `echo "$f" | grep -n`; zsh's builtin
`echo` interprets backslash escapes, the file is full of `\n` inside TypeScript string literals,
and 259 phantom lines appeared. They had a revision. The tree had not moved — the file is
byte-identical at both commits. They ran a command rather than trusting memory. Every guard was in
place and none applies, **because a revision names which subject was measured, not whether the
instrument altered it in transit.** Their counts survived and every line number beside them was
wrong, because splitting a line changes which line a match is on and not how many lines contain
one. A sweep reporting *which* rather than *how many* would have been wrong in every row.

*Before reaching for a second route, check whether you already have a second reading and never
compared it.* `provmap`'s addition, and it is the cheap half: a second route is expensive and will
not be done routinely, while both of the day's worst instances were two readings already in hand.
`authoring` had the correct line numbers earlier in the same session and reported different ones
without comparing. `provmap` had the enumerated site list in front of them and stated a tally that
contradicted it. The classification sweep survived a moving tree for the same reason — it kept
every member visible instead of collapsing them into a number.

Two of my own from the same afternoon, both in the third class, and one of them is a repeat of a
trap already written down on this page. In zsh, `git show $rev:AUTHORING.md` inside a loop reads
`$rev:A` as a parameter modifier and yields nothing; every size in the table came back `0 lines`
and the shape of the result — three identical zeroes — is the only thing that gave it away. I had
recorded that exact trap earlier the same day after it produced a vacuous diff, and reproduced it
anyway, which is the argument for a guard that does not depend on remembering. Braced as
`${rev}:AUTHORING.md` it is correct. And a grep for `eturn nothing`, written to catch both
capitalisations, cannot match `returns nothing` at all: the `s` falls inside the span. It returned
two hits, I read the absence of a third as a fact about the corpus, and reported a zero that
`sweep-reviewer` then had to correct out of a commit message. The population is three across two
spellings. **A pattern narrowed to catch a variant is a pattern that excludes the others, and the
report does not say which ones.**

**A validator figure taken from the working tree is a timestamp, not a measurement.** Five lanes
write to one tree; eleven commits landed in one afternoon inside stretches of two or three minutes.
Every figure disagreement between lanes so far — three in one day — was a faithful count of a
different tree. Quote figures from a revision: `research/probes/validate-figure.sh <sha>` prints the
sha, says whether `.donors/` was copied and deps installed, and prints the command to re-derive it.

Two corollaries the script now carries, both measured rather than reasoned. **A warning can appear
and vanish with nothing done to the text it names** — `rulings.uncited-restatement` scores windows
against term weights derived from the whole tree, so prose added anywhere moves every score; one row
appeared at `7f159d8` and was gone by `daef077` with the window byte-identical at all three
revisions and its ruling byte-identical too. So neither "it passed when I wrote it" nor "it stopped
warning" is a claim about that passage. **And the locator is the window's first line, with the claim
running forward from it** — reading it as a midpoint pulls earlier sentences into the window, and if
one of them concerns the named ruling the row reads as corroboration from a second instrument. That
nearly happened at `82b663f`, and a manufactured convergence is worse than none, because
corroboration is what stops the next person checking.

**`git log --author` cannot distinguish the lanes.** Every commit carries one identity. Authorship
lives in the commit message and the paths touched, both writer-controlled and neither checked; git
here records custody and nothing else. Anything routed by author silently returns the whole team.

**Truncating an output truncates the population, and nothing in the result says so.** `git status
--short --branch | head -3` returned the branch line and two modified files and dropped the two `??`
rows beneath it. I read the shorter list as the tree and was one step from reporting that another
lane's untracked work had disappeared — a claim about someone else's files, from a pipe I wrote
myself. The tell is that the truncation is invisible at the point of reading: `head` succeeds, the
output is well-formed, and the missing rows leave no mark. This is the third member of the family
`carried-forward` already names — the narrowed grep pattern, the zsh `$rev:path` parameter modifier,
and now a pipe that discards the tail. Each one produces a clean, plausible, short answer. **Do not
put a length limit on a command whose output you are about to treat as a population.** Count first,
then limit for display if the count warrants it.

**A report names a line; the defect is rarely one line wide.** `d3bfacb` converted the absolute path
in the `G:Lx-Ly` bullet of `research/dossiers/protocols.md` because that is the line §5 named. The
`plan §x` bullet directly above it, in the same list, carried the same absolute path and survived
the repair. A grep over the
whole tracked tree then closed it: five occurrences, four lines, three files — and note that a line
count reads 4 where an occurrence count reads 5, because one line carried two. Repaired at
`7a83f25`. **When a report hands you a locator, the first move is to measure the population that
locator is an instance of.** The locator tells you a defect exists; it does not tell you how many.
It is also where the locator's own bound matters — a line-based count and an occurrence-based count
are different populations, and neither is wrong.

**The plan's own placeholder gate is green partly because a fifth of its subject does not exist.**
Verification step 4 is `rg -n "TODO|TBD|lorem|placeholder" skills protocols roles packs references`,
and it returns nothing today. Counting the files under each of those five directories says why that
is weaker than it reads: `skills` 13, `protocols` 8, `roles` 29, `references` 4, and **`packs` 0** —
all eight packs are batch 6 and none is authored. A scan of an empty directory is clean in exactly
the way a scan of good content is clean, and the command prints no term for the difference. The same
holds for `skills` until batch 10 lands. So this gate is not evidence until the catalog is complete,
and reading a green run of it mid-catalogue as a fact about the catalogue is the same error as
reading `evals.uncovered-scenarios` as a fact about the skill a checkpoint exercises. **Run a
population count beside any scan whose subject is still being created.** A gate over a directory
tree is an assertion about the tree's contents and quietly becomes an assertion about nothing.

**In the corrupted-reading class, the dangerous member is the one that stays well-formed.** From
`provmap`, who reproduced `authoring`'s `echo "$f"` corruption exactly — all four locators, 1079
lines against 1338 — and then hit a *second* zsh artifact inside the command verifying the first:
`"$R:tests/..."` read `:t` as a history modifier and produced `8ea...ests/provenance.test.ts`, which
git refused. Two shell artifacts, one command apart. **One failed loudly and one produced a file
that parsed, read as TypeScript, and had citable line numbers.** Only the first is self-reporting.
The second is worse precisely because everything downstream of it works: a corrupted reading that
still parses yields quotations, line numbers and diffs, all of them false and none of them
malformed. This is what rules out care as the guard — care is exactly what both lanes had, and it
caught the loud one. The guard is a second reading by a different route, which is the third of the
three guards and the reason it is worth its cost.

**A check whose subject is absent and a check whose authority is absent are different events, and
`ak validate` prints one word for both.** From `sweep-reviewer`, found by attacking the
mandated-rows gate's authority rather than its subject. `.donors` absent is a check that looked and
found nothing: its subject is gone, empty is the correct answer, and `validate-figure.sh` documents
it as a legitimate skip. A reworded `**Mandatory, verbatim in every role body:**` anchor is
different in kind — the subject is entirely present, 29 bodies sit there uncompared, and the check
was *given* nothing to compare them against. Measured: gutted row with the anchor intact exits 1 and
blocks; gutted row with the anchor reworded exits 0 with `1 check skipped`. **The tree is strictly
worse and the exit code is strictly better.** The distinction is already in the contract for
returns — `ba02021` put it there this morning — and the validator does not yet observe it for its
own checks. The generalising fix is a term in the summary line for which kind of skip occurred; the
narrow one is making this check block. Note what makes it sting: the check enforcing *a required
lane that is unavailable blocks approval* reports itself unavailable and does not block. It is the
one rule it does not apply to itself.

**A contract's claim that a rule is enforced is not checked by asking whether the rule exists.**
From `batch4-writer`, who found that §11's first half tells a writer the ten required `SKILL.md`
headings, their order, insertions between them and the anti-rationalization table are "Decided by
the commands above. Read these when one of them reports, not before" -- and that nothing in `src/`
performs any of the four for a skill. `src/validation/bodies.ts` seated its sections check over
`["protocols", "roles"]`; `SKILL_SECTIONS` occurred zero times in the tree. The comment on `checkSections`'s own
`noInsertions` parameter calls the law "§3's insertion law, which §12.1 inherits for protocols and
§12.2 does not impose on roles": the kind that inherits it is seated, the kind that declines it is
seated, and the kind it was written for is not.

**Closed at `f3d7b9b`**, which put `"skills"` into that array and gave `SKILL_SECTIONS` a
definition. The finding held at `030ec70`, where the loop sat at line 1135 -- the number this entry
carried, under a path it did not name.

The part worth carrying is the gate I nearly routed. §11's first half names 14 rule ids. I
extracted all 14 and checked them against every id emitted anywhere in `src/`. **All 14 are
emitted, including the four that are the defect** -- they are emitted for protocols and for roles.
§11 is "Before handing a skill back", so every claim in it is a claim about a skill body, and an
existence check reads green on exactly the bullets that are false. The working gate is coverage,
not existence: one minimal mutated body per claimed id, asserting *that id appears* rather than
that the run fails. Two properties belong in the rule rather than in whoever implements it -- a
case violating two rules proves neither, because either id satisfies the assertion; and a mutated
body in a corpus this size will fail for some reason, so watching the exit code is an instrument
returning the same answer under both hypotheses.

Population, measured because the defect invites the opposite assumption: all five authored bodies
-- `doc-review`, `super-align`, `super-bound`, `super-scout`, `wayfind` -- carry all ten headings,
at `##`, in order, as an exact prefix, no duplicates, seven-row table under `## Hard gates`. The
corpus is clean, and it is clean because five writers hand-verified instead of trusting the report
§11 promised. **A gap that has not yet produced a defect has not been shown to be harmless; it has
been shown to be outrun by care.**

**Read whether a section already rules on a question before routing a ruling about it.** I sent
`authoring` a ruling that §10 guards only deletion-outruns-gate, that the reverse direction is
worse, and that it is invisible per-lane. The first clause is true. The second is backwards, and
this contract already says so in its own words: *a section understating its enforcement makes a
reader redo work the gate already did; a section overstating it makes a reader skip work nothing
does*, and the second does not surface, because reliance on an over-strong claim fails silently --
the gate still passes, so nothing reports and the writer who trusted the word is never
contradicted. A stale disclosure outliving its gate is the understating direction: the lesser one,
and self-correcting the first time a writer watches the gate fire. §10's existing retirement rule
guards the worse direction and needs no companion.

What produced the error is the third guard, in the one place it is easiest to skip: the reading
passed through my own summary of my own earlier conclusion rather than through §10. A second
reading by a different route is cheapest and least likely to be taken when the first reading was
your own. The real gap this misrouting was pointing at is in §11 rather than §10 -- §10's
disclosures are negative claims and its retirement rule reaches them; §11's first half is a list of
*positive* enforcement claims maintained by hand, separately from the enforcement, and nothing
reaches it. It is a structural generator of the direction the doctrine says to assume is
under-found, and it has now generated one.

**A name is not a reading, and the grader that settles a case is rarely the first one.** My own
correction at `57f4280` claimed scenario 18 read green on the wrong loop: that
`doc-review/third-round-does-not-run` caps *review rounds*, that scenario 18 is the third *fix
cycle*, and that it therefore belongs to `super-build`/`super-verify`. All three clauses were
wrong. `two-fix-cycles-then-stop` carries `scenario: 18` and rules *at most two fix-and-verify
cycles after the first pass*; its `binds.skills` are `super-review`, `ultraqa`, `autopilot` and
`babysit-pr`, and batch 4's dossier independently rules that scenario 18 is the pass-2 cap rather
than the per-ticket implementer loop. The case supplies a prompt in which two rounds have already
happened, and its **second** grader says *the cap is two fix rounds and no configuration buys a
third*.

What I read was the directory name and the first grader's *"No third review round is run"*. Both
say **round**; the ruling says **cycle**; the second grader says **fix rounds**. The whole error
fits between the first grader and the second. Two carried lessons meet here and neither caught it:
a report names a line and the defect is rarely one line wide -- this time there was no defect at
all -- and a test for an ordering has to supply input in which the ordering can arise, which is the
property that made the case correct and which I did not check for before calling it wrong.

The residual claim, after re-reading, is real but narrower and differently shaped: the ruling does
not bind `doc-review`, and the checkpoint slice runs `super-review`, so the corpus is covered by a
case hanging off a skill the ruling has nothing to do with. The global `Set<number>` is satisfied
and the slice is not. **A wrong diagnosis of a real gap is more expensive than no diagnosis**,
because it sends the next writer to repair something correct: the brief had told batch 5 to take
the answer rather than the task.

Rows 1, 3 and 20 were re-read by the same route and hold, and row 20 came back stronger than it was
filed -- all five of its cases are knowledgebase or tracker writes read back before writing, while
the gate is a commit or PR action. That is a different side-effect class, not merely a different
skill, and the difference matters: a knowledgebase record can be read back, a pushed PR cannot, and
the checkpoint's `super-ship` step is dry-run, so the fixture has to prove nothing was pushed
without ever pushing.

**`git add <path> && git commit` is not scoped to that path, and this tree has four lanes staging
into it.** I committed `AGENTS.md` at `021bc47` and took twenty files of another lane's in-flight
checkpoint fixture with it, because `git commit` with no pathspec commits the whole index and
`schemas` had staged work in the shared tree. The snapshot that went in was incoherent -- two
runnable check files renamed, neither the materializer that restores them nor the harness that
reads them included -- and since `bun test` collects `*.test.ts` anywhere in the tree, including
under `tests/fixtures/`, it put 6 failures and 1 unhandled error into a suite that was otherwise
green. `schemas` found it and landed the rest of the change at `f23b81d`. **Use the pathspec form
-- `git commit <path> -F -` -- which commits the named paths from the working tree and leaves every
other staged entry staged.** `git status --short` before committing shows the index; reading it is
the guard, and truncating it is the trap already recorded above.

The reason it is worth a paragraph rather than a note: nothing in the repo could have caught it. The
commit was green at the moment I made it, the files I did not intend to ship were another lane's
correct work-in-progress, and the damage was a *fixture* breaking the suite that collects it --
which is a failure mode with no owner, because the lane that wrote the fixture had not finished it
and the lane that shipped it had not read it.

**The verification convention manufactured a false red, and the gate it fired on is the one that
had already been deferred for reading red.** `mktemp -d` on macOS returns a path under
`/var/folders`, and `/var` is a symlink to `/private/var`, so the extract has two names.
`tests/typecheck.test.ts` asks `tsc --listFiles` which files it checked and keeps the ones prefixed
by the repo root; `tsc` prints the resolved name, the prefix never matches, the checked set reads
empty, and the population assertion reports every file in `src/` and `tests/` as untypechecked.
Measured on one revision: **916 pass 0 fail extracted under `/Users`, 1 fail extracted under
`/var`.** I was one step from reporting HEAD red.

This is the day's pattern inverted and worth holding beside it. Every other instance has been an
instrument returning the same answer under both hypotheses -- a false green, silent, found only by
mutation. This one is loud, and its danger is different in kind: the test's own header records that
this gate was deferred once because `tsc` was red over an in-flight file and *a gate that starts red
is a gate people learn to skip*. A convention that makes it red for every lane but its author would
have taught the whole team to skip it, and the skipping would have looked like judgement rather than
a bug. **A false red does not corrupt a reading; it corrupts the reader's disposition toward the
instrument**, which outlasts the revision that caused it. Fixed at `e0d7ce4` in
`research/probes/validate-figure.sh`, which is the copy lanes take, rather than in each copy.

**`git ls-files` reads the index, so a count taken with it is a count of no revision at all.** This
is the third distinct shape of provenance failure found today and the only one a revision label
cannot repair. `sweep-reviewer` re-enumerated the eval corpus and got 42 cases and 11 scenarios
against a tree that held 33 and 8, because nine `super-build` cases were staged and uncommitted;
they caught it themselves. The three shapes, theirs:

| shape | what fixes it |
|---|---|
| a count goes stale | attach a revision |
| provenance attached to the wrong measurement | attach it to the act it covers |
| a count of the index reported as a count of the tree | **nothing a label can do** |

`sweep-reviewer`'s general form is better than the table and belongs first: **the error is temporal
and every provenance instrument in this repo is spatial.** `validate-figure.sh` pins a revision, a
`git archive` extract pins a tree, `ls-tree` pins a snapshot -- all three answer *which tree*, and
all three presuppose the measurement was of a tree. A count of the index is of no tree, so it passes
through each instrument intact and comes out labelled.

`provmap` went to reproduce the divergence and **could not**, because `ff82f1a` had committed the
staged cases two commits earlier: 33 at `0f59f5c`, 33 at `021bc47`, 42 at `f23b81d`. The retracted
figures became the true ones, and the retraction went stale in the same motion. `provmap` first
called that self-correcting; `sweep-reviewer` corrected them and the correction is the durable part.
**The index is not a wrong number, it is a preview of the tree** -- it survives every plausibility
check, it matches what a colleague is about to commit, and on the branch where that lane commits it
becomes true. Had the lane amended, split or abandoned, it would have stayed false permanently with
**no correction event at all**, because nothing here ever compares a quoted figure against a tree.
Both branches are indistinguishable at measurement time and only one ever emits a signal, so the
method is unaudited either way. It was caught on the lucky branch, which is the branch where
catching it is hardest to motivate.

The remedy, and the guard is narrower than the one we nearly wrote down: **anything quoted comes
from `git ls-tree -r <rev>`; if `ls-files` is used anyway it owes a `git diff --cached`, and if
bytes are also read off disk it owes a `git diff --name-only` for those paths.** The second clause
is `sweep-reviewer`'s and it closes a hole in the first: their actual method was a hybrid, names
from the index via `ls-files` and bytes from the working tree via `grep`, and `diff --cached` is
silent on an unstaged edit. **The guard's scope has to match the measurement's scope** -- guard the
index if names came from it, guard the working tree for those paths if bytes came off disk.
`sweep-reviewer` proposed `git status --porcelain` and `provmap` tested it across four states
rather than reasoning about it -- the divergence is index-versus-HEAD, so `diff --cached`
corresponds to it exactly while `status --porcelain` also fires on unstaged edits and untracked
files. Measured in this repo just now: `ls-tree` 42, `ls-files` 42, **`diff --cached` 0,
`status --porcelain` 38.** The proposed guard would have fired thirty-eight times with the defect
absent, and with four lanes writing here it is never empty. That is §10's own *an unperformable gate
gets turned off*, arriving as a property of a guard before it was written.

One line of `sweep-reviewer`'s covers all four of today's shapes including the two shell artifacts
below, and should lead any future version of this page: **provenance attaches to an act, not to a
paragraph.** `7b20b26` headed a paragraph and described one act inside it; *verified rather than
inferred* covered two adjacent acts and was true of one; the index count carried a revision label
describing a different act than the one performed.

**Any measurement that can return zero owes a positive control proving the instrument had a
subject.** Two clean zeroes today, in different registers, neither of which errored. `sweep-reviewer`
supported *nothing executes a case* with `grep -rn "graders|expected_outcome|max_turns|prompt|execution" src/`
-- BRE, so the pipes are literal and it searched for one long literal string that cannot occur. It
exited 1 by construction, under the sentence *"Verified rather than inferred."* `provmap` reran it
with `-E`, got nine matches, and confirmed the conclusion by a different route: `caseDoc["tags"]` in
`scenarioTags`, in `src/validation/evals.ts`, is the only key access on a parsed case. The conclusion was right and
its evidence never supported it. Then `sweep-reviewer`, auditing themselves against `git show`, wrote
`A=$(git show $R:AUTHORING.md)`; zsh parsed `$R:A` as its absolute-path modifier, git errored, `$A`
came out empty, and the three greps that followed returned `0`, `0`, `0` -- the exact shape of their
own findings being falsified, indistinguishable from a true negative. They caught it only because
they already expected a different answer, which is not a method.

The register is what makes this worth its own rule rather than a note under the shell traps. A
malformed *command* errors and the error is loud. A malformed *pattern* exits cleanly, because *no
lines matched* is the honest answer to the question actually asked -- just not the question intended.
Nothing distinguishes *searched and absent* from *searched for the wrong thing*, and absence is
what these searches are usually run to establish. One `wc -l` on the extract before grepping it, or
one pattern known to match, kills both of today's artifacts at the point of measurement rather than
at the point where someone happens to know the answer. It is the same move as `diff --cached` above,
applied to a failure that is not spatial at all.

**Correction to the sentence above, landed the same hour and falsified by measurement.** I wrote
that a `wc -l` on the extract kills both artifacts. It does not, and `provmap` built the case that
shows why. Every mangled path today exited 128 *because the mangled name happened not to exist*. In
a throwaway repo with both `evals/x/case.yaml` and `vals/x/case.yaml` present, `git show
$R:evals/x/case.yaml` degrades to `git show vals/x/case.yaml` -- **exit 0**, a commit header and a
diff for a different file, 273 bytes captured. The byte-count control *passes*. The grep for the
wrong file's content returns 1 and the grep for what you wanted returns 0, which reads as a clean
true negative.

So: **a positive control proves the instrument had a subject; it cannot prove it had the right
one.** What survives is the *discriminating* control -- a sentinel expected in the intended file and
absent from the plausible wrong ones. `provmap`'s working version was `scannedFiles 0 /
CONTRACT-DEFECTS 4 / schema_version 2`: it worked because the second and third are specific to
`AUTHORING.md`, so a wrong subject drives them to zero alongside the finding and the undiscriminating
`0 0 0` becomes a discriminating `0 4 2`. `sanity: 145223 bytes` would have passed on the wrong file.
**A count proves something was read; only a sentinel proves the right thing was read.**

**And one instance where the rule was applied and held, which belongs here beside the ones where it
was not.** team-lead's first load-check of the eval corpus printed `0 failures`. Its build step had
failed, so the grep ran on empty output -- the same shape as the two above, arriving in a third
register. They caught it by asking the run for the number of cases *loaded* as well as the number
that failed. That is the positive control this rule asks for, and it discriminates as well: a run
with no subject drives both terms to zero together, so `0 failed` is a clean result only next to a
load count that is not also zero. The figure that eventually stood, **87 of 87 shipped cases failed
to load**, is the one that arrived with its denominator attached.

**A failure count with no load count beside it is the numerator of a fraction nobody wrote down.**
It generalises past greps: every pass/fail total in this repository has a silent denominator, and
the totals are quoted without it by default. `ak validate: 0 errors` is the same sentence in a tree
of 104 cases and a tree of none.

Two mechanical notes that cost more than they look. **Quoting does not help and braces do.**
`$R:AUTHORING.md` and `"$R:AUTHORING.md"` expand identically under zsh's `:A` absolute-path
modifier -- both to `…/0c785b8UTHORING.md` -- while `"${R}:AUTHORING.md"` is correct. So a reviewer
who spots the shell risk and adds quotes has changed nothing and now believes it is handled. And
capturing stderr does not rescue it either: with `2>&1` the variable holds git's fatal message and
the following greps still return clean zeros, because the error text does not contain the patterns.
`provmap` censused all 27 top-level tracked paths against `$R:<path>`: **14 corrupt, 13 safe**, with
every directory a lane works in -- `src`, `skills`, `schemas`, `tests`, `roles`, `evals`,
`adapters`, `catalog.yaml`, `AUTHORING.md`, `AGENTS.md` -- in the corrupt column, and the safe set
an accident of which letters happen to be zsh modifiers rather than anything anyone chose.

`sweep-reviewer`'s unification is the shortest true statement of both halves of this page, and it is
why each of them was blind to the other's error: **a control must have the same extension as the
hypothesis it guards.** There are exactly two ways to miss. `git status --porcelain` fires on states
that are not the defect -- too wide in the firing direction, a false alarm, and a guard that fires
every day is stepped over. `sanity: N bytes` passes on subjects that are not the right one -- too
wide in the passing direction, false assurance, and nobody looks again. The third live instance
today was neither shell nor prose but committed test code: `tests/typecheck.test.ts`'s population
check reported all 78 owned files as untypechecked whenever the suite was reached through a symlink,
because `spawnSync`'s `cwd` does not rewrite `PWD` and `tsc` builds `--listFiles` from `PWD`. Green
where the repository lives, red in every `mktemp -d` extract -- which is how every lane here
verifies anything. Its author had guarded the vacuous-pass direction with
`expect(owned.length).toBeGreaterThan(30)` and left the false-alarm direction open. **I made that
worse before I made it better:** at `e0d7ce4` I fixed the *convention*, making `validate-figure.sh`
extract under a resolved path, which routes around the trap for callers who copy that script and
leaves it armed for everyone else. The comparison itself is canonicalised at `09860e4`, with a
symlink regression control that is the only test in the file to fail when the canonicalisation is
removed.

**`git push origin HEAD:main` is a moving ref too, and I published another lane's commit ninety
minutes after being handed the report that names the defect.** `authoring` found it first: they ran
`git push origin main`, which publishes whatever the branch points at when it runs rather than the
commit they measured, and it carried an unrelated lane's `021bc47` along with their own. Their
stated remedy was *push the commit I measured by explicit refspec -- `git push origin <sha>:main` --
which fails rather than silently widening.* I accepted it, and then used `git push origin HEAD:main`
on my next two commits. The second one reported `3772d63..5d656af` where I had just committed
`8fa20df`: `authoring` had committed `5d656af` in the window between my `git commit` and my
`git push`, and I published it unreviewed and unasked. Additive, measured green afterwards, nothing
red went out -- and none of that was true because of anything I did.

The lesson is not about git. **A remedy stated as a syntax gets copied as a syntax.** The property
that makes the fix work is *the left-hand side names a commit that cannot move between measuring
and publishing*. `HEAD:main` is an explicit refspec, satisfies every word of the remedy as written,
and violates the property -- because `HEAD` is a name that moves for exactly the same reason `main`
does, in exactly the window the remedy exists to close. The form I copied was the visible half of a
fix whose working half was never in the syntax at all.

Two shapes follow, and the second is why this is on the standing page rather than in a commit
message. A remedy should be written so that its property is checkable on the copy: *the left-hand
side of the refspec is a literal 40-hex sha you pasted from the commit you measured* is longer than
`<sha>:main` and cannot be satisfied by `HEAD`. And the failure is silent in the family way -- the
push succeeds, the range line `A..B` is the only signal, and reading it requires already knowing
which commit you made. It is the positive-control rule above wearing different clothes: the
instrument reported truthfully and the reader had no subject to compare it against.

## A repair that needs history rewritten has a deadline, and on a shared branch it is always past

`97bd59b` is missing the `Co-Authored-By:` trailer `AGENTS.md` requires. `provmap` caught it
immediately and went to `git commit --amend`; another lane had committed `09860e4` on top in the
seconds between, so the amend correctly refused, and they stopped rather than rewrite history under
someone else's commit. That was the right call and the commit stays as it is: `97bd59b` is on
`origin/main`, five lanes have based work on it, and a force-push to repair a trailer would cost
this team the same divergence it paid for once today -- a larger defect than the one being fixed,
introduced by the fix.

**The rule is that attribution is repaired forward, never backward.** A missing trailer is a fact
about one commit; a rewritten shared branch is a fact about every clone of it. The asymmetry does
not depend on how small the trailer is, and it gets worse the longer the branch lives, so there is
no threshold at which the rewrite becomes worth it.

What generalises past trailers: **a repair whose only mechanism is rewriting history is available
for a window you do not control, and the window closes on another lane's schedule.** `--amend` is
not a repair with a cost, it is a repair with an expiry, and on a branch several lanes push to the
expiry is typically shorter than noticing. So a class of defect that can only be fixed by amending
must instead be prevented at commit time or accepted at read time -- there is no third state, and
planning to amend is planning on a race.

`git notes` was considered and rejected. It attaches to the commit without rewriting anything, which
is exactly the shape wanted, and it fails the test this page keeps applying to everything else: notes
do not push by default, almost nothing in the normal reading path displays them, and a record that
nothing reads is the same defect as a caveat published under the second signature of three. The
record belongs where lanes already grep, which is this file.

## The refspec remedy has now failed three times, each by reinstating a name that re-reads later

The third instance is the sharpest, because it happened while applying the rule written above, in the
commit that records the rule.

`authoring` hit it as `git push origin main`, where `main` resolves on the remote at push time. I hit
it as `git push origin HEAD:main`, where `HEAD` resolves locally at push time. Then I wrote *paste a
literal 40-hex sha from the commit you measured*, and reached for
`SHA=$(git rev-parse HEAD); git push origin "$SHA:main"` -- which is a substitution that re-reads
`HEAD` at substitution time. Between my `git commit` and that `rev-parse`, the `schemas` lane
committed `7db25a7`, so `$SHA` was their commit and not the `8a9272d` I had just made and measured.

Three spellings, each one an explicit refspec, each satisfying the remedy as written, and all three
defective for one reason: **the value must be frozen at the moment of measurement, and every spelling
that re-reads a name freezes it later than that.** Pasting is not a stylistic preference in the rule
above -- pasting *is* the freezing, and it is the only part of the remedy that does any work. A
substitution looks more rigorous than a pasted constant and is strictly weaker, which is why it was
the natural thing to reach for.

**The second defect in that command is the one worth carrying further.** I printed
`git log --oneline origin/main..$SHA` immediately before the push, in the same `&&` chain. It listed
all five commits truthfully, so nothing went out unlisted -- and it stopped nothing, because there is
no moment between a preview and an action joined by `&&` at which anyone can act on what the preview
said. I published `7db25a7` without having read it. It happened to be sound, commissioned work with
its trailer intact, and that was luck rather than process.

**A preview printed in the same command as the action it previews is not a checkpoint.** It is
narration with the authority of a check, and it is worse than no preview, because the output is
genuinely correct and reads afterwards like due diligence that was performed. A checkpoint requires
the command to end. This is the false-assurance direction of the control rule: the instrument
reported truthfully, on the right subject, and still could not fire, because firing was not something
its position in the pipeline allowed it to do.

## A working-tree figure is a timestamp, and a timestamp can usually be dated

`provmap` reported "full suite green at tip `09860e4`, 949 pass" from a `bun test` in the shared
dirty tree. `sweep-reviewer` could not reproduce it, got 943, and proposed catalog-derived tests as
the mechanism. `provmap` falsified that properly -- zero `test()` declarations inside loops over
`bySection`, against a positive control returning 19 with the catalog condition dropped -- and both
lanes then closed the thread with the cause recorded as **unrecoverable**, on the reasoning that the
working tree that produced 949 is gone.

The cause is recoverable and the evidence was already committed. Measured in a clean extract of
`09860e4`: 943 pass, 1786 expect() calls, 35 files, matching both lanes exactly. `0adc6dd` adds
exactly six net `test()` declarations and is the only commit in the window that adds any. 943 + 6 =
949, which is the tip reading. `cli` had those six tests uncommitted in the shared tree when
`provmap` measured, and `provmap` counted them.

**The method, which generalises past this instance.** An unreproducible working-tree count is not
unreproducible because the tree is gone. Uncommitted work is usually work in progress, and work in
progress usually lands, so the commit that lands it reconstructs the figure afterwards. The search
runs forward through history from the revision that was labelled, not backward into a tree state that
no longer exists. Two lanes went looking for the cause in the tree -- ephemeral, destroyed -- when it
was sitting in the history, which is durable and was already there. It is the dual of the shape on
this page above it: that error was temporal and every instrument aimed at it was spatial; here the
evidence was temporal and both searches were spatial.

So `§8`'s rule survives intact and gets a clause. A figure measured on a working tree is still a
timestamp and must not be quoted with a revision label. But a timestamp already quoted can usually be
dated, and dating it is worth more than recording the cause as unknown, because an unexplained gap
between two measurements leaves both under suspicion and this one exonerates all three.

**One note on the instrument that produced the six.** `git show <rev> -- 'tests/*' | grep -c
'^+.*\btest('` counts added lines, so a commit that only reindents a `test(` call reads as adding
one: `4c653fb`, which added a timeout and no test, scores `+1` under it. The count is an upper bound
and not a measurement. What settles it is that the arithmetic closes against an independently
observed total -- 943 at one end, 949 at the other, six between them -- so the over-count is visible
as soon as the figure is required to reconcile with something it did not produce. A count nothing has
to agree with is the one to distrust.

## A figure and the cause attached to it are two claims with different evidence

`authoring`'s, written here because it is an obligation on authors rather than a limit on a claim
`AUTHORING.md` already makes, and §8 takes limits while this page takes obligations.

The figure's evidence is the revision and the instrument. The cause's evidence is the
**constituents** -- the per-rule counts, the per-file lines, the members the total is a sum over --
and no amount of rigour about the first supplies the second. A figure quoted with a cause and
without the cause's evidence is a diagnosis wearing a measurement's credibility, and the interaction
runs the wrong way: carrying a correct revision label makes a wrong cause *harder* to doubt, so
complying with the figure rule raises the credibility of the diagnosis without touching its
correctness.

The operable form, and the clause that does the work:

> Before attaching a cause to a total, take the measurement that separates it from the other causes
> the same total has. **If you cannot name a second cause the total is consistent with, you have not
> looked for one.**

Both of the day's instances were reported by people who had a cause in hand and no competitor for
it, and in both the competitor was one command away and the totals were identical under it.

**The worked example is `provmap`'s and it is better than either confession.** The number 949 is
false at `09860e4` and true at `e152f88`. Nothing about the number distinguishes those two; only the
label does. A reader who learns the story and then mistrusts 949 on sight has drawn exactly the
wrong lesson and is as wrong as the person who first attached the label -- which is the sharpest
available statement of why the label carries information the figure cannot.

## A check must have a branch, and that is a fourth way to fail

`sweep-reviewer`'s, and it completes the set. The three failures above are all about the **reading**:
the wrong cases (extension), the wrong quantity (observable), the wrong subject (an exit-0
collision). The preview-in-a-pipeline defect has the right extension, the right observable and the
right subject, and still cannot work, because its reading is not wired to anything.

> An instrument whose output cannot change what happens next is not a check, however accurate it is.

So the four ways are **wrong cases, wrong quantity, wrong subject, no branch** -- and the fourth is
the only one where nothing about the measurement is wrong. `&&` is precisely the operator that
guarantees no branch, which is why `cmd --preview && cmd --do-it` is the canonical shape: a
checkpoint requires the command to end.

The connection worth keeping is that this is the procedural register of a property `AUTHORING.md`
already states: a wrong attribution that is copied *"reads as compliant and greps as consistent,"*
so the copies become evidence of each other. A truthful preview inside an `&&` chain
reads afterwards as review-then-act, and the transcript is indistinguishable from diligence that
actually occurred. Both defects are constituted by **how the record reads later** rather than by
anything wrong at the time, which is why neither is catchable by inspecting the output -- the output
is correct in both.

## Correction: "a literal sha" is not the property either

The refspec section above says *paste a literal 40-hex sha from the commit you measured*, and
`authoring` is right that this is still the syntax rather than the property. `$(git rev-parse HEAD)`
produces a literal 40-hex sha and fails identically -- it is a name, however sha-shaped its output.

> The property is **when the value was fixed, not what form it has**: fixed by your reading of it,
> before the measurement, and carried unchanged to the push.

That is the fourth spelling of this remedy in one day and the first one stated as a time rather than
as a shape. It is also the figure rule wearing procedural clothes, which neither of us noticed until
it was written down: a command substitution is correct, correctly formed and wrong about which
commit it names -- the label is true and does not describe what was published.

## `$?` after a pipeline measures the last command, so a gate can read another program's verdict

Measured while checking the packaging gate. The command was
`claude plugin validate dist/claude-code --strict 2>&1 | tail -20; echo "(exit $?)"`, and it printed

```
✘ Validation failed (--strict treats warnings as errors)
(exit 0)
```

The failure banner and the success code are both correct. `$?` after a pipeline is the *last*
command's status, so it reported `tail`, which had nothing to say about the bundle and succeeded at
not saying it. Re-run without the pipe, the validator exits 1.

This is the exit-0 collision in a third register. The first was a read resolving at the wrong file;
the second was a control reading the wrong quantity; this one is a **verdict** taken from the wrong
program. It is distinct from the branch failure above it, and the distinction matters: there *is* a
branch here, the check *did* fire, and the branch is wired to a status that belongs to something
else. So the four-axis set needs reading carefully -- a check can have the right cases, the right
quantity, the right subject and a real branch, and still be consuming another process's verdict at
the point where it decides.

**The operational form, because this one has a deadline.** Any gating command that ends up in a
script or a CI step must not sit in a pipeline. Capture the status first, format the output second:

```sh
claude plugin validate dist/claude-code --strict > "$OUT" 2>&1; status=$?
tail -20 "$OUT"
[ "$status" -eq 0 ] || exit 1
```

`set -o pipefail` fixes the specific case and is worth having, and it is not the rule, because it
fails the same test the refspec remedy kept failing: it is a spelling that has to be present, it is
absent by default in every shell anyone will copy this into, and its absence is silent. A gate whose
exit code measures `tail` passes forever, and it passes most convincingly on the day the thing it
guards starts failing.

Third time in one day that the author of an entry on this page walked into it while using the tool
the entry is about. That rate is not embarrassment, it is the measurement: these defects are not
caught by knowing about them.

---

## The two bundles differ in one file, and it is the one neither host reads

**Closed at `b46411f`; the code facts below are pinned to `4e45481`.** The packager reads
`packaging.hosts[]` now -- `const row = manifest.hosts[host]` in `src/packaging/plan.ts` selects the
row for the bundle being built --
so the dead `autonomy` read, the single reachable branch and the uniform `mode: manual` are history.
The entry is kept for the class it names, not for its description of the code.

`ak build` writes `dist/claude-code` and `dist/codex` and reports zero errors for both. A full
compare returns a single line:

```
$ diff -rq dist/claude-code dist/codex
Files dist/claude-code/.claude-plugin/ak.json and dist/codex/.claude-plugin/ak.json differ
```

`ak.json` is the build's own provenance, and it lives there because of `96f5291`: it was moved out
of the host manifest precisely *because* the host rejects fields it does not define. So it is, by
construction, the file the host ignores. Every file either host actually reads is byte-identical.
There is one bundle with two names.

What makes it worth an entry is the content of the file that differs. It records that the two hosts
are not alike -- claude-code `enforces: ["no-model-invocation"]`, codex `enforces: []` with the note
that no restriction is claimed. The package computes the capability difference correctly, writes it
down, and then emits the same artifact either way. `dist/codex/skills/super-align/SKILL.md` carries
`disable-model-invocation: true`, which is exactly the key its own sibling record says codex cannot
honour.

**The mechanism that should have acted on it is built, and disconnected one link before the end.**
In `src/packaging/plan.ts`, `const unenforceable = manifest.requiresEnforced.filter((r) =>
!capabilities.enforces.has(r))` derives it -- correct, and the ak.json proves it ran. The line
below, `const wantsAutonomous = manifest.autonomyModes.includes("autonomous")`, gates it, and
`wantsAutonomous` reads `manifest.autonomyModes`. `const autonomy = record(pick(raw, "autonomy"))`
in `src/packaging/manifest.ts` takes that from an `autonomy` key that `schemas/skill.schema.json`
cannot express:
the top level is `additionalProperties: false` and has no such property. So `unenforceable` is
computed and discarded, and the governing requirement -- *a host that cannot enforce a required
restriction exposes the skill in guided or manual mode rather than silently weakening the contract*
-- is precisely what does not happen.

This means the §4 entry and the codex-bundle finding are **one defect reported from two ends**, not
two findings. Which side is wrong is settled by shape rather than by counting sources. Eight skills
already write the declaration where §4 and the schema put it, `packaging.hosts[].{mode,unsupported}`,
once per adapter; `diagnose` asks for `autonomous` on claude-code with a four-item `unsupported`
list. The code reads a flat `autonomy.modes` with no adapter dimension at all. The disagreement is
not two spellings of one field. It is a field that can hold a per-host answer against a field that
cannot, and the requirement is per-host. The code loses on what it is able to represent, which is a
firmer reason than three-documents-against-one.

**And the safety direction is an accident.** Every skill lands on `manual` because an empty list
makes `wantsAutonomous` false, and `manual` is the falsy arm of the ternary. Nothing chose it. Had
the expression been written the other way round, the same dead read would have shipped every skill
claiming an autonomy nothing checks. A dead branch fails safe or unsafe by accident, because the
surviving value was not selected, only left. So "it currently fails closed" is not mitigation to
record next to this; it is a second thing to check, not a reassurance.

**The class, and its mirror.** Two defects fixed here this week were sites that *should agree and
had drifted* -- `fc8e6ef`, three places answering "which profile did this build install?" three ways.
This is the mirror: sites that *should differ and do not*. They look like opposites and they are the
same failure, because both are invisible for one reason -- nothing compares them. A build that emits
two adapters and never diffs them has the same blind spot as three call sites that never read each
other. Where two artifacts are supposed to differ, the check is a comparison, and its absence is why
a decorative second adapter can report zero errors for as long as anyone likes.

---

## `origin/main` is a cached answer, so "unpushed" is a claim with a timestamp on it

A lane reported that `946668c` was unpushed and that `origin/main` stood at `3282296`, and declined
to push it without a word from me. The decline was right. The premise was false: the commit was on
the remote before the message was written.

Asked rather than recalled:

```
$ git ls-remote origin main
946668c98c35fff9a54a154b5494444ae62834f1	refs/heads/main
```

`origin/main` is a remote-tracking ref -- a file under `.git/refs/remotes/`, with an mtime, holding
the answer the remote gave at the last fetch or push *from this clone*. Reading it does not ask the
remote anything. It is correct when written and silently stale afterwards, and nothing in the
reading says which.

**This is the refspec property from the other side of the wire, and that is why it belongs beside
it.** The refspec defect was a name that re-reads *later* than the moment you measured it, so the
push published something you never looked at. This is a name whose value was fixed *earlier* than
the moment you read it, so the report describes a remote that has since moved. Same root in both:
the name carries no time, and the reader supplies the wrong one. Fourth spelling of *when the value
was fixed, not what form it has* -- and the first where being stale, rather than fresh, is the
failure.

The gap that actually bit here is not between the ref and the remote. It is between **when you read
and when you speak**, which is the same gap as the working-tree figure two entries up: a measurement
taken at the top of a turn and reported at the bottom of it has aged by the length of the turn, and
on a tree several lanes write to, that is long enough. The mtime on the cached ref in this case was
*later* than the reading that produced the claim -- the push had landed and updated it mid-turn.

**Sharpened by the lane that was corrected, and their version is better than mine: it is not the
length of the turn, it is whether the subject has a name that stops moving.** In one message they
wrote that `docs/` occurs exactly twice in skill bodies *at `3282296`*, and that was true then, is
true now and will be true next week. In the same message they wrote that `origin/main` stood at a
value, and it was false before the paragraph ended. Same turn, same care, same lane. The whole
difference is that one measurement names a revision and the other names a ref. So the remedy is
narrower than "re-read before you speak", which would be exhausting and mostly wasted: a claim
naming a revision never needs re-reading, and a claim naming a ref needs `ls-remote` at the moment
of speaking however recently you looked. That also sorts a report into the figures a reader can
trust cheaply and the ones they cannot, which is the part that is actionable for someone else.

Remedy, and it is one word: `git fetch` before reading `origin/main`, or `git ls-remote origin main`
to ask instead of recall. Prefer the second when the claim is going in a message, because it has no
cache to be stale and the command names what it did.

**Correction, same day: the rule the decline rested on is not achievable here.** This is a shared
working tree with a shared `.git`, so local `main` is not anyone's private branch -- every lane's
commits interleave on one ref. Git pushes ancestors, so *any* lane's push publishes every lane's
committed work whether it means to or not. Demonstrated within the hour: a commit of mine sat on top
of another lane's unpushed commit, I prepared to publish both and disclose it, and before I could, a
third lane pushed and carried both. "I will not publish another lane's commit" is therefore a rule
about an outcome nobody in this tree controls. The achievable version is about *timing*: do not push
while another lane has unpushed work you have not been told is ready. The instinct was right and the
formulation was not, which is worth separating, because the instinct is the part that transfers.

**And this promotes the refspec property rather than shrinking it, which is the opposite of how the
correction reads.** The lane whose rule I corrected made the point and it is right. If ownership of
what gets published is unachievable, then *knowing the range before you push* is the only control
left anywhere in the mechanism -- and `HEAD:main` is precisely the spelling that removes it, because
the range is computed after the decision to push rather than before it. So these are two rules with
two jobs, not one rule told twice: the timing rule governs **whether** to push, and the refspec
property governs **whether you can know what you are pushing**. In a private clone the second is
hygiene. In a shared tree it is the entire control, because it is the only step at which anyone sees
the set.

**The part worth keeping is the decline, not the correction.** The lane's rule -- do not publish
another lane's commit on my own judgment of when it is ready -- held on a false premise and would
have held on a true one. A decision that is right for its reason survives its facts being wrong;
that is the difference between a rule and a lucky guess, and it is worth saying plainly to someone
who has just been told their measurement was stale.

---

## A test can prove a branch works and the branch still be unreachable, if the fixture skips the schema

**Closed at `b46411f`; the code facts below are pinned to `4e45481`.** No code reads `autonomy` any
more, and the fixture quoted below is gone from `tests/packaging.test.ts`. The entry's own census --
four occurrences of the key, one of them in the code that reads it and one in a fixture -- is a fair
example of why a count names a revision: at `22470e9` the occurrences that remain are this file and
two comments in `src/packaging/` recording the history, none in code that reads the key and none in
a fixture. The lesson about branch coverage and a gate upstream of the fixture is untouched by
that, which is why the entry stays.

The `autonomy` mechanism in `src/packaging/` is dead: `const autonomy = record(pick(raw,
"autonomy"))` in `manifest.ts` reads a key `schemas/skill.schema.json` cannot express, so the
`wantsAutonomous` ternary in `plan.ts` has one reachable branch and every skill ships
`mode: manual`. The obvious question is why a suite this thorough never said so. It is
not that the branch is untested. It is tested, and tested well:

```
tests/packaging.test.ts @ cd48f14, the fixture
  "id: beta\nversion: 0.1.0\ninvocation: M\nautonomy:\n  modes: [manual, guided, autonomous]\n  requires_enforced: [filesystem-sandbox]\n"
tests/packaging.test.ts @ cd48f14, the assertion
  expect(record.autonomy_rejected).toEqual([{ skill: "beta", unenforceable: ["filesystem-sandbox"] }])
```

That is a real assertion about a real degradation, and mutating the branch would kill it. It is also
the **only** `autonomy` block in the repository: `requires_enforced` occurs four times in the whole
tree, twice in prose describing the defect, once in the code that reads it, and once here. The
fixture is a hand-written YAML string. It never passes through the schema whose
`additionalProperties: false` is the reason no real manifest can carry the key.

So the coverage is genuine and says nothing about reachability. **Branch coverage obtained through a
fixture that constructs the input by hand cannot see a gate upstream of the fixture.** The test asks
"given this input, does the branch behave?" and the production question is "can this input exist?"
-- two claims with different evidence, in the same shape as the figure and its cause. Mutation
testing does not help, and would not have: mutate the branch, the test dies, the report reads 13 of
13 caught. All of it true, none of it about production.

The missing check names its own subject: **does any schema-valid input reach this branch?** For
anything gated by a schema, that is a different question from branch coverage, and only the first
one is about the shipped artifact.

**Where this bites next, concretely.** Connecting the reader is not a safe repair, because eight
manifests were filled in while nothing read them. Five declare `mode: autonomous` and one `guided`
on **codex**, whose `DEFAULTS` row in `src/packaging/hosts.ts` reads `enforces: []`. A fix that simply honours
the declared mode would ship four skills claiming autonomy on a host that enforces nothing --
strictly worse than today's accidental `manual`, and the exact "silently weakening the contract"
that arch §1.2/§1.3 forbids. Worse, `unsupported` as authored is prose, three sentences per block,
not capability identifiers, so it cannot be compared against `enforces` at all. The mechanism needs
a machine-readable statement of what the skill requires the host to enforce; what the manifests
carry today is the author's conclusion and the author's narrative, and neither is checkable.

Which is the general lesson, and it is the sharp edge of the dead-branch entry above. A dead branch
does not only fail safe or unsafe by accident. It also **accumulates unreviewed input** for as long
as it stays dead, because the authors filling the field get no feedback from a build that ignores
it. Connecting it turns every one of those declarations live in a single commit. The repair is
therefore two commits and not one: first make the field readable and report what it would have
emitted, then change what is emitted.

---

## A control can be anti-correlated with the property it guards

`rulings.binding-not-cited`, in `src/validation/rulings.ts`, reads, per ruling, "this skill binds
twelve rulings and this body cites nine", and reports the gap as an error naming both. It is a real
check and it closes the population by itself. One line is the whole of it:

```ts
if (text.includes(row.id)) continue;
```

Raw substring presence, anywhere in the file. Measured across four arms on one body: every
occurrence removed raises exactly one finding; restored, it is silent; the id present **only inside
an HTML comment** is silent; the id present **only inside a fenced code block** is silent. So it
verifies that a string is somewhere in a file, and the property it stands in for is that the body
*obeys the ruling*.

Batch 5 produced the two bodies that separate those:

- `skills/super-review/SKILL.md` **cites** `ci-repair-restricts-purpose-not-permission` and then
  drops the fourth term of the sequence the ruling states. At `0e68fdc` the line read *"re-enters
  diagnosis, a bounded patch and new verification -- not another pass of this skill,"* where the
  ruling names a fourth, affected delta review, and the appended clause contradicts it. It passes.
  **Closed at `07eca72`**, which restored the fourth term.
- `skills/babysit-pr/SKILL.md` was reported here as stating all four terms correctly and **not
  citing**, and as flagged for it. **Withdrawn.** At `0e68fdc`, its first revision, that body cites
  `ci-repair-restricts-purpose-not-permission` five times, two of them within three lines of the
  passage in question, and it has cited it at every revision since. There is no revision of that
  file at which the claim holds.

So one half survives, and it is the half that does not need the other: on a body where the proxy
and the property come apart, the check passed a body that cites a ruling and contradicts it.

**The heading overstates what now survives.** Anti-correlation needs both arms -- a body that
obeys and is flagged, and a body that disobeys and passes -- and only the second was ever observed.
The first rested on the withdrawn claim and goes with it. What is demonstrated is a control that is
silent in the direction that matters, which is weaker than anti-correlation and still enough to
retire the check as evidence of the property.

sweep-reviewer's form of the consequence, which says it better than the paragraph above and is
theirs:

> A control that was never a control means the section's evidence has only one arm. Every pass it
> has recorded since is consistent with its catching nothing, and no re-run can distinguish the
> two, because the runs that would have discriminated were never constructed.

The last clause is why this is not a measurement problem. Re-running the check produces more passes
of unknown value, and no quantity of them separates the hypotheses. The cases have to be built.

That is a third thing a proxy can do, past the two already on this page. A proxy can be silent where
the property fails, which is a hole. A proxy can decouple at the boundary, which is why fixtures
find it. And a proxy can *reward* the defect, which is worse than both, because a writer optimising
against the check is being trained toward it: the cheapest way to a green `binding-not-cited` is to
paste ids, and pasting the id while contradicting the ruling is exactly what the passing body did.
That does not require the check to catch an obedient body -- it needs only the one case, where the
id is present and the obligation is not. **Before trusting a control, construct the cases where the
proxy and the property disagree and check which way it points on each.** If you cannot construct
them, the control has not been tested, only run.

### The companion failure, which was mine

I routed a lane this evidence instruction: cite the clean `ak validate` run over
the `delta-scope-affected-behavior` gate line in `policies/invocation.yaml` rather than the
implementer's comment above the branch. The instinct
was right -- a comment is a belief about code -- and the substitute was not evidence at all. They
checked instead of complying: `rulings.uncited-restatement` fires **nowhere in the tree**, so a
clean run over that file is equally consistent with a check that never reaches `policies/`. Two
identical readings are not a control.

What they used instead is decisive: delete the citation and the run goes 2 errors to 3 with
`rulings.binding-not-cited` naming that file and that ruling; restore it and the run goes back. A
firing control proves the instrument had *a* subject. **A removal control proves it had *this*
subject** -- it is the only form that establishes the check was looking at your file rather than
succeeding somewhere else. I had spent the day telling people a clean run is not evidence, and then
handed one over as evidence inside the remedy for that exact mistake.

---

## When a rule has a canonical example, check the example against the rule

`AUTHORING.md` §5 says twice that a conversation capability is recorded with a `G:L` locator into
the transcript. The validator's grammar admits three forms, enumerated in the `has locator` error
message in `src/validation/provenance.ts`: `G:L` ranges, `plan §<section>` / `arch §<section>`
document references, and `amalgam <dest> + <dest>` seat pairs. Five live rows carry no `G:L` and a
clean extract validates at zero errors, so they are the contract rather than tolerated defects.

The diagnostic is what makes this worth an entry. §5:431-437 exists for one specific case -- a
conversation capability landing in a `provenance_origin: donor` entry -- and the clearest live
instance of that case, `guided-checkpoint-mode`, is recorded with `plan §9`. **The paragraph's own
exemplar contradicts the paragraph's spelling.** When the best instance of a rule in the tree
violates the wording, the wording is what is wrong, because the instance was written by someone
solving the real problem and the wording was written by someone describing it.

It is cheap, it is available at authoring time, and it needs no instrument: name the canonical
example of the rule you are about to write, then read it against what you wrote. Everything else on
this page needs a probe and a control. This one needs a grep and thirty seconds.

**And the narrowness came from further upstream than the section.** The implementation plan this
repository is built from -- the brief handed to this session, which is not in the tree -- says
capabilities absent upstream are recorded "`origin: conversation` with a `G:L` locator", phrasing
that assumed the transcript was the only non-donor source. It is not. The precedence order puts the
design document *above* the transcript, so a capability specified there and absent from the
transcript has no `G:L` to cite, and demanding one would force the fabrication the same section
forbids. That ordering is stated in the tree, in the `DOCUMENT_REFERENCE` comment in
`src/validation/provenance.ts`, as the grammar's own reason
for admitting document references: "a document reference is a stronger citation than a transcript
range, not a weaker one." The implementation generalised correctly and every copy of the prose
inherited the narrow form. Worth knowing that a contract can be wrong because the brief was wrong,
and that the code can be the thing that noticed.

---

## A short name that denotes three documents yields citations that always resolve

The sentence above said "the plan's own precedence table" until a lane went to check it and reported
the table does not exist. Both of us were right about our own referent. **In this repository `plan`
is a term of art meaning the architecture document**, because its path is
`research/sources/engineering-skills-repo-plan.md` and the `-repo-plan` suffix grew a second
spelling for it; `policies/resolved-conflicts.yaml` writes `plan: "§6.3, §11"` for that document's
sections. The implementation plan is a third document, not in the tree. So my citation sent a reader
to a file whose "Scope and source authority" section is about precedence *within* the transcript --
a real section, saying a different thing, reached by a name I used correctly in the conversation I
came from.

This is the wrong-subject register at the level of document names, and it is worse than a broken
citation in the specific way that matters: **a broken citation fails, and this one resolves.** Every
reader gets an answer. Nothing reports, nothing is skipped, no control can fire, because from the
instrument's side a resolved reference is indistinguishable from a right one. What it produces is
confident disagreement between people who have each read their own document carefully.

The repository had already written the warning down, in that same `DOCUMENT_REFERENCE` comment, in
the file that parses the name -- including the consequence in full: "anyone reading `plan` as the
implementation plan misreads every row that cites one." It had also already been bitten once and
recorded that too (the `DOCUMENT_FILE` comment below it): `arch` reached the plan's index through a
default, so `arch §5` matched the plan's §5 "and passed without either side establishing which
document had been named. It was right by accident." I made the documented mistake because the
documentation lives where the name is parsed, and I was citing prose.

Operable: **before citing a document by a short name, check what that name denotes in the tree that
will read the citation, not in the conversation that produced it.** One grep of the consumer. The
conversation you are in is exactly the context in which your own usage is unambiguous, which is why
this cannot be caught by re-reading what you wrote.

---

## The governing document is not the document in front of you

Three times in one day I stated a contract value from whatever file I happened to be reading rather
than from the file that governs the artifact, and all three resolved cleanly.

I ruled the plugin manifest's `author` to a literal I invented; `adapters/claude-code/CONTRACT.md`
already specified one, as `"author": { "name": "agent-kit maintainers" }`. I instructed that
claude-code's `plugin.json` be identity-only with no `skills` key; that row lives in
`adapters/codex/CONTRACT.md` §1 under a heading reading **"Verified (donor) at the pin"**,
describing `compound-engineering@05c42da`'s repository -- our own contract says at length that the
package enumerates every skill path explicitly, because the install set is profile-dependent. And I
cited "the plan's precedence table" when in this tree `plan` denotes the architecture document.

The common shape is not carelessness about sources. Each time I had a real document open, read it
correctly, and quoted it faithfully -- to answer a question it was not the authority for. A donor
table and a package contract look identical at the granularity of a row. **The failure is in the
step that selects which document to open, and that step leaves no trace in the output**: a wrong
quotation from the right file and a right quotation from the wrong file are indistinguishable
downstream, and only the second survives review, because it is correct about something.

Operable, and it is an ordering rather than a caution: **name the artifact first, open the contract
that governs that artifact, then quote.** Not "read the contracts" -- I had. The lane that avoids
this greps the contracts for the filename before choosing it, which is the same ordering expressed
as a command: let the artifact find its governing document instead of letting the document you are
reading suggest an artifact.

---

## A prohibition with no release mechanism is a queue that only grows

The rule was right: do not push while another lane has unpushed work you have not been told is
ready. It replaced a real failure. In a shared tree it also deadlocks, and a lane found the proof
before I did -- every lane commits to one local `main`, so a commit stops being independently
pushable the moment anyone commits after it, there is no refspec that publishes a descendant and
withholds its ancestor, and if everyone obeys while everyone has unpushed work then nobody may ever
publish. The rule forbids an action and contains nothing that restores it.

It released anyway, by me pushing first. So the outcome was decided by whichever lane moved fastest
rather than by anyone's judgment, which is the exact property the rule existed to remove. **A
prohibition that is impossible to satisfy is not obeyed and not broken; it is routed around by
whoever is least careful**, and its author never sees that happen because what they observe is the
queue.

The repair is a release mechanism, not a better prohibition: one named publisher, so "have you been
told it is ready" has exactly one person it can be asked of. And the readiness statement belongs in
the **commit message**, not in a report -- a report goes stale between the writing and the reading,
as three did today, while a message travels with the commit and is read at the moment of the
decision it informs.

**The general form: when you tighten a rule, check that the tightened rule still has a path to
"yes".** A rule with no reachable success state looks identical to a strict one right up until the
first time somebody needs to act.

---

## A record is not a control

Everything above is on this page. The refspec property is on this page -- stated correctly,
including the remedy, including a worked account of me violating it once already in this session.
Forty minutes after reading it I published another lane's commit through `HEAD:main` again, having
narrated the spelling as though *computing the range after the decision* were its virtue rather than
its diagnosis. I inverted the sign of my own entry while looking at it.

This page is a record. Reading it is not running it. The entries are written to be checkable, which
is not the same as being checked, and nothing in the act of writing one creates an occasion where it
fires.

So the third occurrence bought an instrument rather than a fourth paragraph: `tools/hooks/pre-push`,
installed in the shared `.git/hooks` and therefore covering every lane without anyone installing
anything. It refuses `main` and `HEAD:main` and admits `<sha>:main`, discriminating on what git
actually sends -- measured, because the sha form sends no stdin line at all rather than a line to
pattern-match. Controls both ways, and the negative control was **vacuous on its first run**: the
sha I chose was already the remote head, so nothing was pushed and the allow path never executed. A
control that passes without exercising the path it certifies is the anti-correlated control's
quieter sibling, and it took a second run with a sha two commits ahead to get a reading worth having.

The rule that follows is narrow and I would rather state it narrowly: **the second time you write
down the same finding, stop writing and build the check.** A recurrence is evidence the record does
not fire, and the record is the only remedy a recurrence tempts you to strengthen.

---

## A compression can change what kind of claim a sentence is

A review seat quoted the `Named rather than assumed` comment in `src/validation/provenance.ts` to
me inside quotation marks as *"'not conversation' is
not 'donor'"*. The source says:

> with three origins in the map, "not conversation" **no longer implies** "donor", and a message
> that guesses wrong sends the reader to check something the row does not say.

"No longer implies" is a claim about **inference**: you cannot conclude donor from not-conversation.
"Is not" is a claim about **fact**: it asserts that a not-conversation row is not a donor row, which
is false, since most of them are. The compression did not shorten the claim. It changed its
modality, from a prohibition on reasoning to an assertion about the world, and then dropped the
clause that said why anyone should care.

**I had been repeating the compressed version in my own rulings**, and it reached a ruling I issued.
It survived because it is approximately right, reads well, and resolves — the property every entry
on this page keeps circling. A quotation wrong in a checkable way gets caught. A quotation faithful
in gist and wrong in modality gets built on.

The seat's own diagnosis of where it happened is the part worth keeping: **the quote was correct in
their notes and got shortened on the way into report prose.** That step has nothing to check
against. Notes are taken with the source open; prose is written with the notes open; and the second
hop is where a seat's compression becomes indistinguishable from the source's words. The guard is
the one a different lane demonstrated the same day -- re-read the committed file rather than your
memory of what you wrote.

Operable, and narrow enough to follow: **inside quotation marks, paste; outside them, paraphrase and
say you are.** The hazard is not quoting too little. It is quoting a rendering.

---

## A control can be half of a pair and look like a whole one

The pre-push hook guarantees I publish the revision I measured. A lane read it and named what it
does not do: it **constrains the refspec, not the contents**. Nothing in it knows whether the thing
I measured was green. They then handed me the live instance -- two undeclared eval cases making the
tree red at the moment they wrote -- so that if I published on the strength of the hook alone, the
hook would have worked perfectly and the range would have been broken.

The two halves compose and neither is sufficient: **the hook makes the published sha equal the
inspected sha; only running the check at that sha makes the inspected sha green.** Before the hook
existed I had the second half and not the first, which is exactly how I published a red tip on a
green receipt taken at a different revision. Having now built the first half, the temptation is to
feel covered.

The general shape: a control answers one question, and the question it answers is easy to mistake
for the question you had. *Did I publish what I inspected* and *was what I inspected good* are two
questions, and a mechanism that answers the first with certainty is more likely to be over-read than
one that answers it weakly. Worth asking of any new check: **what is the failure this does not
touch, and is it the one I was actually worried about?**

---

## Nobody audits a document for being too modest

Every defect in this repository so far has been an artifact claiming more than it enforces: a NOTICE
pointing at files the bundle lacked, a contract asserting a parity check the tool did not perform,
manifests declaring autonomy on a host that enforces nothing. A review seat found the opposite.
`AUTHORING.md` §12.2 tells a writer the gate cannot distinguish a row that is present-but-shortened
from a row that is absent. Three arms show it emits **different rule ids** for exactly those two
states, comparing byte-for-byte against text read out of §12.2's own published block.

The contract understates its own gate, and that is worse than it sounds, because the document's job
is to tell writers what to supply. **An overclaim disappoints a reader who relies on it. An
underclaim teaches every reader to supply less than the gate requires** -- and then the gate catches
them, so the damage shows up as friction attributed to the gate rather than to the document.

It is also structurally invisible. We audit artifacts against reality in one direction, asking
whether the claim is supported. Nothing in that motion catches a claim that is *weaker* than the
evidence, because a weak claim is supported. Checking the other direction needs someone to run the
mechanism and notice it does more than advertised, which nobody is incentivised to do and no
validator will ever prompt.

---

## When the tree agrees with itself and your number disagrees, re-take the number

A seat piped `ak validate` through `tail -40`, grepped the captured file, and got one
`rulings.doctrine-unreachable` warning where the tree has two -- `CONTRACT-DEFECTS.md` sorts above
the tail window. They then spent real effort hunting the exemption mechanism that must be excluding
that file, reading the validator for an exclusion and parsing every `doctrine:` binding out of the
YAML, before doubting the measurement.

What was available before any of that, and needed no theory: **two independent statements in the
tree agreed with each other and disagreed with one fresh measurement.** §12.3 and
`policies/resolved-conflicts.yaml`'s own comment -- *"Two standing `doctrine-unreachable` warnings
are the correct state here, not zero"* -- both said two files. That configuration -- several settled
sources concurring, one new number dissenting -- is readable at a glance and says which side to
re-take first. It is not that the tree is always right. It is that re-running one command is cheaper
than theorising a mechanism, and the hunt for a mechanism is self-sustaining in a way the re-run is
not: every absence you find looks like evidence the mechanism is well hidden.

---

## The safety of an operation can live entirely outside the operation

A lane ran `git commit --amend` on its own most-recent commit. That is a normal, safe thing to do,
and it is the amend every agent performs a dozen times a day. It was unsafe this once because I had
published that commit in the interim -- and **nothing about that fact is visible from where the
amend is performed.** The lane sees its own commit, at the tip, with no marking. The amend succeeds.
The failure surfaces later, somewhere else, as a non-fast-forward rejection on my push, with no
trace connecting it back.

This is a different shape from the registers above. Those are all cases where the evidence was
present and misread. Here the evidence is not present at the site at all: the property that makes
the operation dangerous is held by another seat, established after the operation's subject was
created, and never propagated. **You cannot make the lane more careful, because there is nothing
there for care to act on.**

### The gate does not exist, and I checked before building the substitute

The obvious control is to refuse the amend. Measured here, it cannot be written:

| invocation | `prepare-commit-msg` `$2` | `$3` |
|---|---|---|
| `git commit -m X` | `message` | *(empty)* |
| `git commit --amend -m X` | `message` | *(empty)* |
| `git commit --amend` | `commit` | `HEAD` |

`-m` wins over `--amend` in the source argument, so the amend agents actually perform is
byte-identical to an ordinary commit at hook time. `GIT_REFLOG_ACTION` is unset in the hook
environment. No pre-commit-time signal distinguishes them, and `pre-commit` runs before git has
decided anything a hook could read.

The tempting move is to ship the gate anyway, since it does fire on `git commit --amend` with no
`-m`. That would be the anti-correlated control in its purest form: **a gate covering the path
nobody takes, reading in the tree as though the hole were closed.** The hole would then be harder to
find than if nothing had been built, because the file's existence answers the question.

So the control is `tools/hooks/post-commit`, and it repairs rather than reports -- `commit-tree` the
amended tree onto the published commit, `reset --soft` onto the result. It is placed after the
commit because that is the first moment the amend is unambiguous, not because detection is
preferable to prevention. The file says so, so that the next reader does not re-derive the table
above.

Two properties worth keeping. It reads `origin/main` from the remote-tracking ref rather than the
network, which is only sound because one seat publishes and publishes from this clone -- **a control
whose correctness rests on a social rule elsewhere in the system**, and which degrades to silence,
not to noise, if that rule lapses. And it tests *ancestry*, not parenthood: `--no-verify` skips
`pre-commit` and not `post-commit`, so the recorded head can be several commits stale, and a stale
head is still an ancestor. A parent test would read staleness as an amend and rebuild the branch
onto a commit it never left -- a control that manufactures the defect it exists to repair.

### The five controls, and which one carries the weight

Firing: amend a published commit, see the parent restored and the push accepted. Removal: an
unpublished amend, an ordinary commit, an amend on a side branch -- all silent. Those four leave one
question open, because each varies several things at once.

The fifth holds everything fixed. Same commit, same amend, same branch, same working tree; the only
difference is that a push happened in between. Silent before, fires after. **That is the
discriminator isolated to one variable**, and it is the only one of the five that proves the hook
keys on publication rather than on something correlated with it.

---

## `:r`, and why the zsh modifier family keeps arriving

Setting up those controls, `git push origin "${A}:refs/heads/main"` -- written `"$A:refs/..."` --
pushed to `8aec1142...2131abefs/heads/main`. `:r` is the modifier that strips an extension; `$A` has
no dot, so it returned the sha unchanged and the surviving `efs/heads/main` was appended. Fourth
member of the family in `research/probes/authoring-format.py`'s `show()` docstring, after `:e`, `:A`
and `:s`.

Two things it adds to that docstring. **It fired inside double quotes**, which is where the previous
three were met and where quoting intuition says expansion is already tamed. And it fired *on a
refspec* -- the construct the whole publication control is written in terms of. The remedy was
already in the tree, in a file I had read this session, written against exactly this.

The failure also landed the way that docstring predicts: loud on stderr, while the surrounding
script carried on and printed `published A=8aec114`, a confident line naming a commit that had not
been published. I read the confident line first. The docstring's formulation holds -- loud and quiet
are not properties of the trap but of where the failure lands relative to where the figure is read
-- and the practical consequence is narrower than "quote your variables": **a shell form that has
worked a hundred times tells you nothing about the next path written the same way**, because whether
the mangled name resolves is a property of the value, not of the code.

**Fifth member, and it is the one that produces a valid command.** sweep-reviewer wrote
`$r:schemas/case.schema.json` while building the blob table for the schema entry and got back
`7db25a7hema.json`. `:s` takes its delimiter from whatever character follows it, so a path whose own
slashes fall in the right places is itself a well-formed substitution: `s`, delimiter `c`, pattern
`hemas/`, replacement `ase.s`, trailing `hema.json`. **A path with the wrong letters after the colon
is not mangled by the shell -- it is read as an instruction to the shell**, and nothing about the
path looks like one.

Censused in zsh over ten paths a lane here actually types, as `"$r:<path>"` with `r` a sha:

    SILENT  schemas/case.schema.json            ->  7db25a7hema.json
    LOUD    src/validation/evals.ts             ->  bad substitution
    SILENT  src/validation/rulings.ts           ->  7db25a7
    SILENT  AUTHORING.md                        ->  <cwd>/7db25a7UTHORING.md
    SILENT  catalog.yaml                        ->  7db25a7atalog.yaml
    SAFE    policies/invocation.yaml            ->  7db25a7:policies/invocation.yaml
    SILENT  adapters/codex/CONTRACT.md          ->  <cwd>/7db25a7dapters/codex/CONTRACT.md
    SILENT  research/briefs/carried-forward.md  ->  7db25a7esearch/briefs/carried-forward.md
    LOUD    skills/super-verify/SKILL.md        ->  bad substitution
    SILENT  evals/<skill>/<case>/case.yaml      ->  vals/<skill>/<case>/case.yaml

Seven silent, two loud, one safe. Which one you get is decided entirely by the letters after the
colon -- whether a third occurrence of the accidental delimiter happens to exist -- and the writer
controls none of it. Quoting changes nothing; `${r}:<path>` is the only form that does.

**And the third row is worse than anything else on this page.** `src/validation/rulings.ts`
collapses to nothing at all, so `git show "$r:src/validation/rulings.ts"` becomes `git show 7db25a7`
-- a different command, entirely valid. Measured: **exit 0, 16305 bytes of commit content, and a
grep for `dischargedIn`, a real identifier in the file that was asked for, returns 0.** Every guard
built on this page passes it. The exit code is clean. The byte-count control passes handsomely, on
more bytes than the file has. And the zero has the exact shape of a true negative. Only a sentinel
known to be in *that file* separates it from a real reading -- the discriminating-control rule
arriving in a case where the instrument was never pointed at a file at all.

**Sixth member, caught by sweep-reviewer before it inverted a finding.** `$?` after a pipeline is
the *last element's*. They wrote `grep -rn 'prompt\.md' src/ | head -10`, read the status as grep's,
and got 0 from `head` -- which would have been reported as *the validator does know about
`prompt.md`*, the exact inverse of the truth, and load-bearing for the entry it was feeding. The
guard is not a better exit code: redirect to a file and count the lines, which is what the `0` in
that entry is.

**Seventh instance, and the page had already named the cure.** Verifying the schema state for the
entry below I wrote `git show "$r:schemas/case.schema.json"` in a loop over three revisions. zsh
took `:s` as the substitution modifier and git received `9b12366hema.json`. The command failed
loudly, so this one cost nothing -- but the paragraph three screens up says in as many words that
**quoting changes nothing and `${r}:<path>` is the only form that does**, and I typed the quoted
form. The rule was not vague, not buried, and not someone else's: it names the single working
syntax, and it was written on this page by me. Count it against the recurrence section below rather
than against zsh.

**Eighth, and this one is the dangerous shape of it.** schemas hit the same `:s` modifier building a
per-revision table, and their loop printed four rows reading `9b12366 allOf= enum=`. `git show`
failed loudly on stderr -- but **the row is report-shaped with empty fields, and an empty field
renders as a finding.** Redirect stderr, or read the tail of a background task, and you have a
well-formed four-row table asserting that no grader type has ever carried a conditional. Same family
as the receipt script printing zero bytes when the tree was red: **the failure mode of a loop is a
row of blanks, and blanks read as zero rather than as nothing.** A missing value and a measured
absence are the same glyph, and the loop is where they meet most often.

Three of these now sit together, and they divide by which of the shell's answers got taken for
yours. `:r` and `:s` answer about a **different path**. `set -e` inside `$( )` answers about a
**different scope**. `$?` after a pipeline answers about a **different command**. In each the exit
code is clean, the output is plausible, and the sentence that comes out is about something nobody
ran. **An exit code is a claim about the last thing the shell did, and the last thing the shell did
is not always the thing you wrote.**

---

## Three artifacts said "the same rule as markdown" and one of them decided

`rulings.uncited-restatement` reported five claims in `skills/*/skill.yaml` as uncited while every
one of them carried its citation two lines up. I had told two lanes to leave those warnings standing
and carried the item to the tooling lane as mine, on the stated ground that *the check splits per
physical line and cannot be satisfied by placement.* That ground was wrong. The sentence splitter is
block-aware and always was.

What was actually true is narrower and only visible in `citationScope`. The markdown branch widens a
window to its enclosing paragraph, so a citation in the first sentence covers the rest. The YAML
branch took the window's own lines and nothing else. Those are the same rule for exactly one shape:
a claim short enough to sit beside its citation on one physical line. Every `skill.yaml` in the tree
writes the other shape.

The failure is not that someone implemented the wrong rule. It is that **three artifacts stated the
right rule and none of them tested it**:

- the code comment -- *"a scalar that names its ruling in the sentence is attributed by the same rule
  markdown uses"*
- the test name -- *"a citation inline in the scalar clears it, as it does in markdown"*
- the test body -- a single-line YAML scalar, which is **the one input that passes under any scope at
  all**, including the broken one

The example does not merely fail to cover the case. It cannot distinguish the implementations. A
reader auditing this check finds the principle stated twice and demonstrated once, and the
demonstration is vacuous in the precise sense: it would pass with the widening removed. This is the
canonical-example heuristic arriving from the other side -- I have been checking examples against
rules; here the rule was right in all three places it was written down, and only the example decided
anything.

### A warning nobody can clear is a warning everybody learns to ignore

The cost was not the four false reports. It was the fifth line. The second `hard_gates` item in
`skills/super-ship/skill.yaml` -- *"Each sensitive action needs an explicit charter entry a human
approved up front"* -- was a real uncited restatement of the charter ruling, which is the
hash-binding defect already routed to batch 5. **Closed at `b18a418`**, which added the citation. It
sat in the same list as four reports I had instructed two lanes in writing to disregard.

**I issued the suppression myself, in two messages, with a wrong mechanism attached.** A class that
cannot be cleared by doing the right thing does not stay quarantined to its false members; it takes
the true ones with it, and the instruction to ignore it is what does the taking. The remedy is not to
lower the threshold or to annotate the exceptions. It is that a warning class with no reachable clean
state is a defect in the check, to be fixed or withdrawn, and never to be handed to writers as
something to live with.

Fixed by widening YAML scope to the enclosing sequence item -- the structural analogue of markdown's
paragraph -- which is safe for the reason paragraph scope is safe: the scope is searched for the
*specific* candidate ruling's id, so naming ruling A never attributes a restatement of ruling B.
Widening cannot launder a citation. Five reports became one, the one is true, and a control that
strips a citation from a real file in a scratch extract brings the detection back, so the check still
fires on the shape it exists for.

---

## I wrote the check, then answered the question with a grep

I reported that release scenario 6 was uncovered across the whole `evals/` tree, gave the figure
that supported it -- twelve other scenarios found, six absent -- and routed it to two lanes. One of
them built an eval case on that premise.

It was covered. `super-build` has had two cases for it since batch 4, and `ff82f1a` says so in its
commit message in plain words: *"Scenario 6 is two of them."* The tree tags scenarios in two
spellings, `scenario-6` and `scenario-06`, and my pattern matched only the first.

That is register №1, wrong cases, which I wrote. But the sharper fact is what sat beside it the
whole time. `ak validate` emits `evals.uncovered-scenarios` on every run, reading the *number* and
not the spelling -- `Number("06")` is 6 -- and it had been printing `release scenarios no case tags:
2, 16, 17, 22, 24` for days. Scenario 6 was never in that list. **I had built the instrument for
exactly this question and then answered the question by hand.**

The note even disclaims precisely what I went on to commission: *"the 19 scenarios absent from the
list above are tagged, not tested."* The half of the audit I asked for was the half the instrument
says it does not cover, which is the right half to ask for -- and I would have known that from the
output rather than from reconstructing it afterwards.

### Twelve hits is a firing control

The ad-hoc grep felt safe because it returned a lot. Twelve scenarios is unmistakably an instrument
with a subject. It is not evidence that it had *this* subject, and a pattern excluding an entire
spelling produces output indistinguishable from a pattern that found everything there was. **The
number of hits is never the control. Deliberately removing a case known to be present is.** One
`grep -c scenario-06` would have closed it, and so would reading the validator.

So the rule, and it is narrower and more useful than "check your regex": **where the tree already
contains a check for the question you are about to answer, the check is the answer.** An ad-hoc
measurement standing beside a live check is not corroboration. It is a second instrument, with no
controls, no population statement and no revision, competing with one that has all three -- and when
they disagree, the reflex is to believe the one you just ran, because you can see how it works.

### And the writers were following the contract

The four padded files are not sloppiness. `AUTHORING.md` specified `scenario-NN` -- two digits, in
the notation itself -- and demonstrated `scenario-04`, and both batch briefs instructed the padded
form. The canonical-example heuristic again: the notation was ambiguous, the example resolved it,
and every writer followed the example. Meanwhile plan §10, `RELEASE_SCENARIOS`, the validator's own
messages and twenty-odd case files used the other form. Nothing was broken, and nothing would ever
have broken, which is why it survived: **a split vocabulary costs nothing until somebody reads the
corpus with a tool that is not the check.**

Canonical is the unpadded form now, stated in §12 with the reason, and
`evals.scenario-tag-noncanonical` keeps it that way. `research/probes/scenario-coverage.py` had
already recorded the same shape in its docstring -- *"three spellings are already in use"* -- about a
different index, months of attention apart, and neither of us generalised it until it cost
something.

---

## The five scenarios nothing tags, and who owns them

`ak validate` reports these on every run and will keep reporting them, so this is not a second
record of the fact -- it is the one thing the check cannot know, which is who is in a position to
close each one.

| # | Scenario | Owner |
|---|---|---|
| 2 | A feature missing behavioral coverage triggers the testing lens | `super-review`, **batch 5** -- in reach now |
| 16 | Autopilot disagreement yields one escalation, not repeated internal debate | `autopilot`, batch 10 |
| 17 | A missing supervisor is not replaced by the implementer | `autopilot`, batch 10 |
| 22 | A source merge activates KB coordination without bypassing KB checks | `compound` / KB adapter, batch 8 |
| 24 | Rolling back a skill leaves its supporting knowledge history intact | `deprecate`, batch 9 |

Only 2 is reachable in the batch now open, and it is the one at risk: 16, 17, 22 and 24 belong to
batches that have not been written and will meet this table when their briefs are, while 2 belongs
to a batch that is closing. None of the five is in the checkpoint's gated nine, so nothing stops at
the checkpoint for them -- which is exactly why 2 is worth naming now rather than at the Phase 5
release gate, where it would arrive as a catalog-wide coverage failure with no batch left that owns
it.

Scenario 2 landed at `c532706` while this table was being written, so the row above is the record
of a gap rather than a live one. The other four stand.

## I asked for a control the contract makes impossible to pass

The batch-5 checkpoint gates on nine release scenarios, and I asked sweep-reviewer the question that
sounded like the right one: for each, would the case fail against a body with its hard gate removed?
The answer came back no, nine times out of nine, with a table.

Nine identical answers should have been read before the finding was. `AUTHORING.md` defines
`## Hard gates`, and §3.1 immediately **requires** an anti-rationalization table underneath it whose
rows cite the same ruling ids; the required-sections list puts the same rules in `## Not for`,
`## Limits` and `## Stop conditions` as well. The contract mandates that every gate be stated two or
more times. So deleting one copy tests a property this contract deliberately does not have, and the
uniform negative is a fact about my question, not about nine cases.

The general form, which is the part worth carrying: **a control that returns the same verdict for
every member of a population is reporting on the question, not the population.** Independent
subjects that agree perfectly agree for a reason, and the reason is usually upstream of all of them.
Before believing such a result, find the thing they have in common -- here, one sentence in the
contract that every body obeys.

What makes this different from the vacuous control, which it resembles: a vacuous control passes
without exercising its path. This one exercised its path nine times and the path could not have led
anywhere else. The check ran. The question had no discriminating power.

The repair is not to delete carriers, and saying so is urgent, because the natural reading of "this
rule appears five times" is drift to be tidied. A gate is not the binding statement of a rule --
several sections bind -- it is the **guarantee of completeness**: a reader who reads only
`## Hard gates` has the whole stop-list. Which inverts the defect I went looking for. It is not a
gate with too many echoes. It is **a rule that stops the skill and is not in `## Hard gates` at
all**, and there are four: scenarios 1, 7, 8 and 9. Scenario 8's rule has two carriers in the whole
body, no gate and one case.

And the corpus never certified any of this. `evals.uncovered-scenarios` says so in its own message
text -- tagged, not tested -- so "gated scenario" was a name claiming something no check performs.
The name is retired.

## A figure that cannot name a revision is not stale, it is not a measurement of this repository

provmap found this in the §4 entry and the distinction is exact enough to be a rule. A count taken
from `dist/claude-code/skills/` names whoever last ran the packager, and `AGENTS.md`'s `dist/` row says it is
*"Generated by `ak build`. Never hand-edited, never committed"*. There is no commit at which that number was true.

That is a different fault from decay, and it needs a different remedy. A stale figure is repaired by
naming the revision it was true at; this one has no such revision, so the repair is to re-state the
claim over something tracked -- 18 of 26 host blocks declare a mode the packager cannot emit -- and
delete the original rather than date it.

The tell is available before the measurement is taken: ask "true at which commit?" A decayed figure
answers with the wrong commit. This kind has no answer at all.

## The instrument that failed toward the conclusion I already held

Also provmap's, and it outranks every other instrument note today. Their first pass returned 0
manifests, 0 host blocks, 0 mode declarations, because `\s` in a `git grep -E` pattern matches
nothing under the POSIX engine and exits clean. Uniform zero across arms that must differ is the
tell, and it is now five for five in this repository.

But the direction is the finding. Zero read as *the defect is even worse than recorded*, which was
the thing they were already arguing. **A broken instrument that fails toward the conclusion you hold
cannot be caught by finding its result plausible**, because plausibility is precisely the check it
passes. Nothing but a removal control separates it from a working one -- theirs was dropping
`guided` from the alternation and requiring 26 to fall to 16.

## A check that exists only in its own tests

I built `evals.duplicate-graders` to catch the scenario-20 pattern -- seven cases tagged as seven
tests of one scenario, three of them carrying a byte-identical grader under a byte-identical
directory name. The first version fingerprinted the whole grader set. It passed all five of its
tests and found **zero** in 102 real cases, because the corpus's copies share their heaviest grader
and differ in a trailing one.

The fixtures were built to demonstrate the rule, so they made copies that were copies all the way
through. The corpus makes copies the way people actually make them: take the case, keep the part
that does the work, change the part that names the skill. The fixture and the population disagreed
about what the artifact under test looks like, and only the fixture was consulted.

So: **run a new check against the real tree before believing its tests.** A green suite says the
check does what its author imagined; only the corpus says whether what they imagined exists. The
second version keys on an `llm` grader's decisive field, reports 3 groups over 8 cases against 245
distinct expectations, and excludes `tool_used` and `regex` deliberately -- `tool_used: Skill` is
legitimately identical everywhere, and grouping on it would report the corpus as a copy of itself,
which is the unclearable-class shape from three sections up.

That decisive field was `expected_outcome` when this was written and has been `criteria` since
`c9fdcda`, which renamed it in all 256 `llm` graders: the same field under the name the runner
accepts. The figures above are unaffected, because a rename moves no value. **The rule above is, and
it is the sharper reading of this entry.** *Run a new check against the real tree before believing
its tests* was followed here, exactly as written, and the real tree agreed with the check about a
key the runner refuses on the object the corpus had put it on. A corpus is a population, not an
oracle: it can confirm that a check finds what exists in the files and say nothing about whether
what exists in the files is right. The last entry on this page is that interval.

sweep-reviewer's extension, which is the part that changes what anyone does. The rule catches
exactly one failure class -- the check that passes only its own fixtures -- and it caught it. What
it cannot catch is a premise the check and the tree hold in common, **because the tree was authored
under that premise**. Agreement between a check and a corpus measures the check's *reach*; it cannot
measure its *correctness*, and reach is the only thing the rule was ever about. Compactly: **an
oracle is something that can disagree with your premises**, and a corpus your own team wrote cannot,
on any question your team settled before writing it.

The operational test, because a limit stated abstractly changes nothing: **ask what could make this
check wrong that the tree would also be wrong about.** Nothing coming to mind is a description of
the state, not a clean bill.

### A control that silently does not run agrees with every hypothesis

The removal control for that check, run against the real corpus: differentiate one member of a
duplicate group and the group must shrink. It reported no change, and for about a minute that read
as the check being insensitive to exactly what it keys on.

The check was fine. The expectation wraps mid-phrase in the YAML -- `derives the idempotency key
from the\n      run, the operation` -- so a `sed` for the normalized sentence matched nothing, exited
0, and the edit never happened. I compared the tree to itself and called it a control.

This will recur here more than anywhere else, because every artifact in this repository is wrapped
prose and every claim about it is quoted normalized. The guard is to verify the edit, not the
outcome: `git diff` after the mutation, before the re-measurement. A mutation that changed nothing
is not evidence about the thing you mutated.

## The path-scoped commit has two exposures, and only one of them is a commit

authoring reported the mechanism from a near miss and then hit the other half of it inside the hour,
which is why it belongs here rather than in a commit message. Every lane here commits with
`git commit -F msg -- <path>` out of a working tree that is never clean, and a path-scoped commit
publishes the **worktree** content of that path.

  - Another lane **commits** a change to your file between your read and your commit: yours reverts
    theirs, with no conflict and no diff anyone would notice. Caught by
    `git log <base>..HEAD -- <path>` before committing.
  - Another lane has **uncommitted** edits in your file: your commit sweeps them in, under your
    message and your readiness statement. `git log` cannot see this; it reads commits. Caught only
    by `git diff --stat -- <path>`, treating any hunk you did not write as a stop.

The second is the worse one, and it is the one the first write-up missed. It produces a commit whose
message is a lie about its contents -- which is how `AUTHORING.md`'s §12 work ended up inside a hooks
commit this morning, and how it then left the branch when that commit was amended.

Both halves run before the commit, not after. After is a report, not a guard.

## A figure attached to a claim makes the claim feel measured

batch5-writer's, on being handed "scenario 6 is uncovered" with twelve numbers beside it, and it is
the mechanism behind how that error propagated to two lanes before anyone checked it:

> a figure attached to a claim made me *less* likely to check it, not more. That is backwards, and
> it is the same shape as the working-tree-figure problem -- a number that is correct about
> something makes the thing it is attached to feel measured.

The twelve numbers were correct. They were the union of scenario tags over the five batch-5 suites,
exactly, with nothing over and nothing under. The sentence they were attached to was about the whole
tree. A precise measurement of a scope nobody named reads identically to a precise measurement of
the scope that was named, and the precision is what stops the reader asking which.

## A citation can resolve, name the right revision, and still not say what cites it

`adapters/codex/CONTRACT.md` §5.2 required `name`, `version`, `description` and `license` to agree
across `package.json` and both host manifests, citing
`compound-engineering@05c42da:src/release/components.ts`. The pin is real, the path exists at it, and
the file is the donor's release code. Measured: `components.ts` does version bookkeeping and no
parity work at all. The parity work is in `metadata.ts`, where the token `compoundPackage.` occurs
exactly once -- comparing `package.json`'s version and nothing else. Each manifest's description is
*derived and written* rather than compared, which is why the donor ships one description in
`package.json` and a different one in `.claude-plugin/plugin.json`; manifest `name` is compared
manifest-to-manifest; and the donor's own `package.json` has no `license` key.

Four clauses, one supported, two contradicted by the donor's own shipped artifacts.

The plan forbids fabricating a source path. This is the failure that rule does not reach: the path
was not fabricated. Every property a reader checks quickly -- pin resolves, file exists, donor is the
one named -- was true, and each true property made the clause harder to doubt. What nobody had done
was open the file and look for the comparison.

Two things follow. A citation is a claim about *content*, so verifying it means reading the content,
not resolving the locator. And the tell was available without reading anything: a four-field check
where one field is trivially satisfied upstream because the two names coincide there is a check that
never discriminated on that field in the donor either. When a transplanted rule has a clause that
could not have fired at its source, the clause did not come from the source.

## A second measurement that shares the first one's definition is not independent

I reported 245 distinct expectations in the eval corpus "matching an independent PyYAML census".
sweep-reviewer re-derived 243. The check emits no distinct-expectation count at all, so no
independent measurement of 245 existed; what agreed was 102 and 3, the two figures that survived.

The arithmetic: 245 is `248 - 3`, crediting one duplicate per group, which is right only when every
group has two members. Two of the three had three. `248 - (1+2+2) = 243`. Re-taken at today's tree:
252 graders, 247 distinct, groups 2/3/3, and `252 - 247 = 5` -- the same rule, confirming theirs.

The corroboration is the part worth keeping. Either my census encoded the same subtraction, in which
case it agreed for the reason the first one was wrong, or I reported a corroboration I never ran.
Both are the same defect from the reader's side, and "measured it twice and they agreed" conceals
both. Two measurements are independent when they could disagree -- different definition, different
instrument, different population -- and a second pass that re-runs the first one's definition is one
measurement executed twice.

## zsh does not word-split, so a five-path guard ran against one path that does not exist

The shared-tree guard before a commit is two commands, and I ran the second as:

    P="package.json catalog.yaml schemas/catalog.schema.json adapters/codex/CONTRACT.md AGENTS.md"
    git diff --stat -- $P

Empty output. In bash that is five pathspecs and empty means clean. zsh does not word-split unquoted
parameters, so git received **one** pathspec -- the whole string, matching nothing -- and empty means
the pathspec matched nothing. The two readings are byte-identical and the wrong one is the reassuring
one.

Caught only because `git status --short` two lines later listed all five files as modified, which is
a different question I happened to be asking for a different reason. Third zsh entry in this register
after `:r` and the refspec modifiers, and the same lesson: the shell is a participant in the
measurement. A guard whose passing output is *empty* cannot distinguish "nothing wrong" from "nothing
examined", so give it something to say when it runs -- print the path count, or assert it.

## An internal cross-reference by line number is a figure without a revision

authoring's, found while repairing a stale figure: their first draft cited a rule as "73 lines above
this one". It measured 78 -- the distance had been carried across an edit that moved the sentence
making the claim. The deeper problem is that a line number is itself a figure about a tree and decays
on the next edit any lane makes above it, so the repair for a stale-figure defect would have shipped
a figure with a shorter half-life than the one it replaced.

Cite by section number or verbatim quotation. Both survive other lanes' edits, and a quotation fails
loudly when the quoted text changes, which a line number never does.

## A control that compares the artifact it protects is silent about whatever it normalises first

authoring's `safe_wrap` flattened a paragraph break and welded two paragraphs into one. Its whitespace
assertion passed -- a blank line *is* whitespace, and the assertion compares non-whitespace
characters. The format probe passed too: it counts blank lines that appear, never one that vanishes.
Two controls, both green on real damage, both blind to the same dimension, and that dimension is the
one the wrapper normalises away before comparing anything.

Generalised: a control built on a comparison inherits the comparison's blind spots, and a normaliser
in the pipeline is an enumerated list of them. Read what the comparison discards, and assert on it
separately or not at all -- but do not let two controls that both discard it count as two.

## An adversarial case and its answer key can have a common cause

The count this entry was built on -- nine of twelve -- is **withdrawn as unreproducible**, and the
description of its exceptions with it. Re-derived at `9ea8b3f` over the 40 cases tagged
`adversarial`, counting a case as asserting when the requester's own sentences argue for the wrong
action: 34 assert and 6 do not. The exceptions are not "two neutral requests and one non-trigger",
which was never measured against any population. They are four prompts that quote the temptation
from a PR comment, a captured log, a reviewer's thread or an implementer's report without the caller
adopting it, and two that supply only the conditions and ask for the ordinary deliverable.
`refuses-smell-finding-as-ticket`, cited in support of the original count, is tagged `negative` and
is not in the population at all.

What survives the withdrawal is the mechanism, which needs no census to be true.

That is a mechanism, not a correlation. The row and the prompt are both generated from one sentence,
the scenario's temptation, so the case and the key that grades it come from a common source. The case
then measures whether a model can match a sentence to its rebuttal, which a body with the rule
deleted may well still do. It inverts the reading of a `tags: [adversarial]` corpus: the tag marks the
cases most likely to have their answer printed in the body they test, and the cases that discriminate
best are the ones that never name the temptation.

The authoring rule, now in §3: an adversarial prompt states the **conditions** under which the
rationalization is attractive, and lets the body supply the rationalization. No check -- the key is
semantic, and the only mechanical proxy is a span-length threshold, which is a knob that gets tuned
until it reports nothing.

## A sweep over a partially-authored tree conditions on what has been authored

Ruled by team-lead, phrased to generalise past its instance. A sweep of `skills/` for rulings with no
carrier reported three uncarried rulings. Conditioned on whether the binding skill exists, the count
is zero: two of the three bind skills still at `status: contract` in batches 7 and 10, and one binds
no skill by declaration at all -- it binds profiles, references and doctrine.

An unconditioned sweep of a tree that is half-written reports the schedule as a defect, which is
worse than reporting nothing. It is a finding that looks like negligence, arrives with evidence, and
dissolves on the first question -- and the seat that receives it spends the afternoon before the
question gets asked. The condition belongs in the key rather than in a caveat underneath, because a
sweep that needs a caveat to be true gets quoted without it.

## A revision-bound figure survives re-quoting only if the revision is re-quoted with it

team-lead, on their own relay, which is why it is worth keeping. `AUTHORING.md` said "measured at
`9ea8b3f`: of the 40 cases tagged `adversarial`". The relay carried it as "re-derived at today's
tree: 40 adversarial-tagged cases". The count was unchanged and the sentence was false: HEAD carries
41, a case having landed at `978e7af` after the measured commit. Stripping the revision converted a
correct measurement into a claim about a tree nobody had measured, and it did so without touching a
digit.

That is the entry above committed in reverse -- there the revision was never attached, here it was
removed in transit -- and the second is the harder one to catch, because the original is still on the
page and still correct. A figure that names its revision is safe where it sits and unsafe everywhere
it is quoted, so re-quote the whole sentence or none of it.

## A ruling that lives only in a commit message is unreachable by the tooling that would enforce it

`CONTRACT-DEFECTS.md` routes its rulings into git history on purpose: an entry is retired by
deleting it in the commit that resolves it, with the ruling in that commit's message, and there is
no resolved section. The reasoning is sound and the property is real -- a resolved entry left in
place is the same artifact as a stale one, so the file refuses to hold one.

The cost is where the ruling then lives. `ak validate` reads the tree; `git log` is not the tree,
and no check this repository runs opens it. So the contract paragraph an entry was filed against
sits in a store the tooling reads, the ruling that settled it sits in a store the tooling cannot,
and **"a contract paragraph outlived the entry filed against it" is not hard to detect here -- it is
undetectable**, because the two halves a check would have to compare are never in the same place at
the same time. That is structural, not a gap in the checks.

sweep-reviewer's second half is what makes it an entry rather than a complaint: the generalization
is *about* a resolution record living where nothing can reach it, and a commit message is exactly
such a place, so filing it there would make the entry an instance of itself. It is filed here
instead.

**Where a resolution record and the artifact it resolves live in different stores, no check can
compare them, and the choice of store is a choice about what can ever be checked.** The remedy is
not to stop deleting entries -- that property is worth keeping -- but to stop treating the deletion
as the whole record, and to leave in the tree whatever a later check would need in order to notice
the disagreement.

## A locator survives a re-pin, because re-pinning a paragraph does not re-measure the numbers in it

sweep-reviewer sampled four of this file's `<file>:<line>` citations after one went stale between
two commits, found four of four displaced, and declined to generalize from a sample. Resolving all
24 of them -- 23 distinct -- against the revision each entry names:

- **10** resolve to the text their sentence claims.
- **3** resolve exactly, and the finding they support has since been closed:
  `skills/super-review/SKILL.md` at `07eca72`, `skills/super-ship/skill.yaml` at `b18a418`,
  `src/validation/bodies.ts` at `f3d7b9b`. All three were still written in the present tense.
- **3** resolve exactly at `cd48f14` and to unrelated text at `4e45481`, the revision their own
  entry declares.
- **6** resolve to unrelated text. Two of them, `plan.ts:198` and `:199`, resolve to the code they
  claim at *no* revision of that file in this history; the nearest is `96f5291`, one line off.
- **1** resolves to text that falsifies the claim attached to it.

**And the breakdown is load-bearing in a way the list above does not show.** There are two
defensible partitions of those 23, and **13 is the answer under both of them, meaning opposite
things.**

  - *Does the locator resolve to the text its sentence claims, at the revision the entry declares?*
    Passes 10 + 3 = **13**. Fails 3 + 6 + 1 = **10**.

  - *Is the sentence carrying the locator true as written, at the revision the entry declares?* True
    **10**. False 3 + 3 + 6 + 1 = **13**.

A reader who meets *13 of 23* with no rule attached is one coin flip from "most of them are fine"
and "most of them are broken". This is the census entry's classification clause with the stakes
visible: a classification rule is not a note attached to a figure, it is half of what the figure
says, and without it the number is not merely underspecified. It is **reversible**.

**The figure to quote here is the first partition, because this entry is about locators**: *10 of 23
do not resolve to the text their sentence claims, at the revision the entry declares.* All 23 were
converted to by-text form at `f817abe`, so that figure describes the state the pass repaired and not
the file in front of you.

**And their four, placed in it.** `plan.ts:198`, `plan.ts:199` and `hosts.ts:46` fall in the six
that resolve to unrelated text; `tests/packaging.test.ts:440` falls in the three that resolve at
`cd48f14` and not at the revision its entry declares. Four drawn from a ten-member failing set,
selected because they looked wrong, four came back wrong. The reading is sweep-reviewer's, filed as
a correction against themselves and carried here as one: **it confirms membership and estimates
nothing** -- and with the denominator visible,
that method could not have told a ten-failure population from a twenty-failure one. A sample
selected for suspicion is a search, and a search that finds what it went looking for has measured
the searcher.

The three-at-`cd48f14` group names the mechanism. That entry opens *"Closed at `b46411f`; the code
facts below are pinned to `4e45481`."* The pin was written when the entry was closed; the numbers
were taken when it was opened. Re-pinning is an edit to one sentence, and it does not re-resolve the
locators in the paragraphs beneath it -- so a pin added to make the figures auditable made
unresolvable figures look audited instead. **An undated line number announces that it is undated. A
wrongly dated one does not.**

Which is why dating a locator is not repairing it. **A locator is repaired by replacing it with
something that carries its own subject** -- the code's text, the heading, the quoted sentence -- and
all 24 are converted here. The conversion is what surfaced the three closed findings and the false
one, for the reason that is the whole argument for the form: a by-text citation cannot be written
without opening the file, and opening the file is the check. A line number can be carried forward by
a writer who never looked.

And the shape, which sweep-reviewer named against the previous pass: the cause was diagnosed
correctly on one citation, and the repair was applied to that one citation. **A remedy has to have
the same extension as the defect it repairs.** Where the cause is a class, the sample rate is the
finding, and a fix that lands on the reported instance leaves the class exactly as measured.

### A locator that resolves perfectly, attached to a claim that has been closed

The three in the second row are a different defect from the other ten and were counted beside them,
which is what made *13 of 23* reversible. `skills/super-review/SKILL.md` closed at `07eca72`,
`skills/super-ship/skill.yaml` at `b18a418`, `src/validation/bodies.ts` at `f3d7b9b`. Every locator
resolved. Every quotation was accurate. Every sentence was in the present tense about a defect that
had been repaired. All three now carry a `**Closed at ...**` note in this file, added in the same
pass that found them.

**A by-text conversion does not catch this class, and that is the limit of the remedy the rest of
this entry argues for.** The quotation is found and the quotation is correct; what is wrong is the
tense, and nothing about opening a file to copy a line of code asks whether the finding attached to
it still stands. The conversion surfaced these three only because resolving 23 locators put me in 23
files -- a side effect of the sweep, not a property of the form. A sweep is not a repeatable
control.

sweep-reviewer's general shape, which is the one to carry: **a remedy that works by putting a person
in front of every instance finds things the remedy does not encode, and those finds belong to the
sweep rather than to the form.** They cannot be cited as evidence for the form, because the next
application will not include a person reading 23 files.

So the two defects want two different repairs. A locator is repaired by carrying its own subject.
**A finding is repaired by carrying its own disposition** -- open, closed at a named revision, or
withdrawn -- inside the sentence that makes the claim, where a reader meets it, rather than in the
commit that closed it. sweep-reviewer's recommendation, adopted: file this separately and quote the
locator figure over the sentence-truth figure, because keeping them in one number is what produced
the ambiguity above.

**The case that argues for it better than the argument does.** sweep-reviewer checked a sentence
sitting beside the one they had falsified, in the same paragraph of `schemas/case.schema.json`,
expecting a second uninstantiated mechanism. *"A run that scored 0.00 against an empty workspace"*
is **instantiated**, and well: `research/briefs/checkpoint-host-packaging.md` carries the run end to
end -- one case, 0.00 on all three graders, the trace described, the agent naming the paths it
inspected and saying the repository had no commits, and all three `llm` graders failing it because
each asks whether a review was produced. That sentence has a receipt, in another lane's file. *"The
one author who tries gets a validation error"*, two sentences earlier, has none and never did.

**The two read identically.** Same paragraph, same register, same confident present tense, one fully
evidenced and one never instantiated, and nothing in the prose distinguishes them -- which is the
whole argument for the rule above in one artifact. **Evidence is not inherited by adjacency**, and a
paragraph is exactly the unit that makes it look as though it is.

## A zero can be correct and still answer a question you did not ask

sweep-reviewer's, against themselves, and it is the complement of every other zero on this page. The
others are broken instruments -- a pattern that cannot match, a build that failed, a mangled path
that resolved to nothing. This one is a working instrument, a correct result and a wrong reading,
and none of the guards above fire on it.

They reported that `scaffold_script` appears zero times in the corpus, zero times in
`schemas/case.schema.json` and zero times in AUTHORING.md -- *"the key is absent from the
contract."* All three counts are right. The sentence built on them, that no internal consistency
check could have surfaced a feature none of the sources names, is also right. Neither is the
finding. The schema does not omit `scaffold_script`. It **refuses** it, on an
`additionalProperties: false` standing since `7db25a7`, and a case that declares one fails
`ak validate`.

**Not specified and forbidden are different findings** -- different causes, different remedies,
different blame -- and a grep for the key's name cannot separate them, because both produce the same
zero. The distinguishing evidence is not in the count and never could be: it is a keyword two lines
up in the same file that does not mention the key at all.

The guard that generalises: **a confident zero is owed the question of what would have had to be
true for it to be non-zero.** Here the answer is *someone would have had to write the key*, and the
next question -- what happens to the person who does -- is the whole finding. It is the
positive-control rule turned inward. A positive control asks whether the instrument had a subject;
this asks whether the subject could have registered.

And the reason three counts felt like corroboration is already on this page: they were one question
asked three times. Three sources agreeing is one source whenever the sources share the reading, and
it makes no difference whether they are documents or greps.

## A census is four claims, and only two of them are about the number

Consolidated at team-lead's ruling from three entries that were being cited one at a time. A census
can be unreproducible in four ways: it can name no population, name no revision, state no
classification rule, or publish no breakdown. **The first two are about a number that is wrong. The
second two are about a number that is right** -- a rule that lives only in the measurer's head makes
a correct-looking count unfalsifiable, and a total whose terms have all been replaced stays true
while the thing it was quoted for has gone. The fourth is the one worth leading with, because it is
the only one that survives both defences already written here: a revision label does not catch it
and re-running the count agrees with it.

### The population, and the key that reads it

Ruled in from sweep-reviewer's table of nine measurement errors across two seats, and it replaces
"parse, do not grep, whenever the claim is about structure", which authoring killed by testing it
against their own three: it covers one. Shipped, it would have read as discharged by the two that
cost the most -- an anti-correlated control, covering the path nobody takes while its presence in the
tree answers the question.

Each of the three was right about the set it measured and wrong about the set its sentence named. 13
was about parsed mapping values, 69 about distinct destinations rather than rows, 56 about a join on
full catalog id rather than last path segment. Same for mine.

The ordering refinement -- "a key is only right relative to a population, so name the population
first" -- is **not** in. Its single instance turned out not to be an instance of it: the receipt was
taken at a revision after the repair the error caused, and at the revision the claim was about, the
key is wrong at both populations. Two independent errors on one output. That the refinement failed by
selecting a revision for proximity to the repair rather than for the claim, inside the receipt offered
as its evidence, is the most useful thing about it and the reason the base rule goes in alone.

### The revision, and the rule that produced the count

Ruled by team-lead after the same defect arrived three times from three directions. Two were missing
populations: "nine of twelve" over no set anyone could name, and a figure of 245 that named no
revision. The third had both and was still unreproducible -- the 40 cases tagged `adversarial` at
`9ea8b3f`, read by two seats, produced 34-and-6 and 37-and-3. Population and revision feel like
rigour and are not sufficient, because the count is produced by the rule, and a rule that lives only
in the measurer's head makes the number unfalsifiable while looking precise.

**The rule has to name whose voice it reads**, which is the term that three-case gap turned on. Both
seats wrote "the requester's own voice" and then differed over whether a shortcut argued for inside
quoted third-party material counts as the requester arguing for it. It does not, and one pair
settles it: `receiving-review/comment-instruction-is-not-executed` against
`receiving-review/comment-cannot-authorize-a-merge` -- same skill, both quoting a comment, differing
only in the caller's own *Resolve the threads and land it*. Stripping the quoted spans leaves the
requester's whole contribution visible, and that residue is what the rule is applied to.

**The key is part of the population and not a detail of reading it.** In the same corpus at
`22470e9`, `grep -l adversarial` across the case files returns 46 and the tags line returns 41. The
five extra are cases where the word names a review seat or a QA cycle rather than a tag -- and in
two of them it sits in the `name:` field, which this repo has ruled is a prose descriptor and not an
identifier. So the tag namespace and the descriptor namespace share a vocabulary, and no
text-matching key can tell a tag from a sentence that uses the tag's word.

That makes the drift a standing property of the corpus rather than a miscount. A `grep`-keyed figure
here will be wrong again, at a different magnitude, the next time a case is described in the words
it is tagged with -- so the repair is the key, not a re-count. Neither number is wrong about the set
it measured; the five were enumerated by sweep-reviewer, who found the two in `name:`.

One of those two is sharper than key drift. `ultraqa/does-not-run-in-place-of-review` is tagged
`negative`, and its `name:` field reads `adversarial-qa-does-not-substitute-for-the-review-pass`. A
text key there does not mis-read a tag; it pulls into the population a case that is not in it, and
the word is load-bearing in that name because the case is *about* adversarial QA. Neither renaming
the field nor rewriting the prompt removes the match. Keying on the tags field is the only repair
that does, which is the difference between a key that is noisy and a key that is measuring a
different set.

**The operational form, ruled in from sweep-reviewer: group the population by shape, and verify each
group is classified alike -- preferring a grouping a reader can construct mechanically.** Publishing
the rule would not have caught this one. The rule *was* published, directly under the figure and
with the contrast pair beside it, and its author still applied it unevenly across a group.
Stripping the quoted spans is such a grouping: it puts the four quoted-temptation prompts in one
bucket by a procedure anyone can run, and a bucket whose members come out classified two ways is
the finding.

### The breakdown, which is the failure a correct number can carry

sweep-reviewer, from the census inside *A test can prove a branch works and the branch still be
unreachable, if the fixture skips the schema*. That entry counted four occurrences of
`requires_enforced` and broke them down: twice in prose describing the defect, once in the code that
reads it, once in a fixture. At `22470e9` the total is still four, and neither the live read nor the
fixture exists -- the surviving pair are JSDoc comments in `src/packaging/manifest.ts` and
`src/packaging/plan.ts` recording the removal.

**A revision label does not save this one.** The figure was true when it was written and is true
now, so nothing about it is stale. What moved is the referent: the terms were replaced one for one
by terms of a different kind, and the total is invariant under exactly the change the census existed
to detect. That is a harder failure than staleness, because every check that looks for a changed
number passes, and so does re-running the count.

So publish the breakdown rather than the total. `2 prose + 1 live read + 1 fixture = 4` makes the
live read going to zero visible on the next count, where a bare `4` cannot. The general form: a sum
discards the dimension its terms carried, and a census is quoted for what its terms *were*, so
wherever the terms are the reason for counting, the sum is a lossy summary of the measurement rather
than the measurement.

### And the instrument, which is none of the four

A fifth clause, and it is not a property of the census at all: **a figure whose instrument is not
named is not reproducible even where population, revision and breakdown are all correct.**
`AGENTS.md`, *Receipts name their instrument*, sets out the three instruments and what each one
reports -- the working tree reports every check against contents nobody can reconstruct, a bare `git
archive` extract reports the right contents and skips the donor rows, and that extract with
`.donors/` **copied** in reports the right contents and every check.

team-lead relays the case that turns that from an assertion into a finding. `cli` reported a gate
figure at `22470e9` with `.donors` symlinked rather than copied, and **stated the symlink in the
message**, so nothing they wrote was false and a reader had every term of it. The number was still
not re-derivable, because the link points out of the extract: it resolves to a path in the working
tree, and the figure stops being reproducible the moment anyone touches that path. They caught it
themselves against `AGENTS.md` and re-measured with `research/probes/validate-figure.sh`.

Which is the sharp edge of the clause. Naming the instrument is necessary and is not sufficient,
because a correctly named wrong instrument reads as disclosure. The test is not whether the receipt
says how it was taken but whether someone else running that procedure lands on the same number, and
only the third instrument has that property.

## A description is a measurement too, and it needs the same provenance a number does

From `schemas`, with their own worked example, and routed here because two lanes hit it
independently on the same day. `research/probes/validate-figure.sh` exists because three `ak
validate` figures disagreed between three lanes in one day and none of them was wrong -- each was a
faithful count of the tree in front of the person running it, and the output has no term for which
tree that was. The rule that came out of it is that a number taken from a working tree is a
timestamp and not a measurement. What happened here is the same failure arriving in prose, where
nobody had thought to apply the rule.

The example is `schemas`' own, at `62c1f0d`, and it is verified at that revision rather than taken
from their report. They wrote `schemas/rulings.schema.json` and described `discharged_in` as *"A
list rather than one section"*, naming `rulings.missing-discharged-in`,
`rulings.malformed-discharged-in` and `rulings.unknown-discharged-in` as the checks that between
them refuse an absent value, a bare string, an empty list and a member outside the vocabulary. At
the revision carrying that sentence, `policies/resolved-conflicts.yaml` held `discharged_in:
authority` -- a bare string; `RulingRow` declared `readonly dischargedIn: string | null`; and
`malformed-discharged-in` occurred nowhere in `src/` at all, only in the schema file asserting it
and in `tests/schemas.test.ts`. All three had been read out of another lane's uncommitted
working-tree diff and written up as landed.

**Why it survived every gate is the part worth recording.** The schema's *behaviour* was correct --
the field was unconstrained apart from an `items` keyword that is vacuous on a string -- so `ak
validate` reported 0 errors at that revision, the suite passed, and the clean-extract gate passed.
Nothing cross-checks a rule id named in prose. It was a false description, not a false result, so no
instrument in this repository could have caught it. Only a reader could, and one did, one commit
later. team-lead made the same error the same day, telling a lane a field had already been amended
to a list when it had not, and caught it only because that lane pushed back with a measurement.

Two agents, one day, one mechanism: **reading a dirty working tree and reporting it as the committed
state.** Neither was careless. The working tree is simply the thing in front of you, and `git
status` tells you a file is dirty without telling you whose edit made it dirty or which side of it
you are looking at. **The cheap fix is `git show HEAD:<path>`.** Before writing a sentence that
asserts what the tree contains -- a field's shape, a rule id, an enum's values, a signature -- read
that path at the revision you are about to commit, not in the editor.

The failure direction is asymmetric in a way that decides how much this matters. A wrong *result* is
caught by the validator, the suite or the gate. A wrong *description* passes all three and is then
cited by the next lane as established, which is how one lane's uncommitted intention becomes another
lane's premise. And committing the correction forward rather than amending is what made the pattern
legible at all: under the ruling at `8a9272d` the record carries both the false description and the
reason it was false, so when team-lead's instance turned up an hour later there was something for it
to match.

## A document, a schema and a check can all be wrong together for as long as nothing runs

Two of these in one day, from opposite ends of the package, and team-lead's reading is that they are
one entry rather than two. In both, every artifact was read carefully and read correctly,
repeatedly, by several agents. In both, the thing being read was not the thing that runs.
**Agreement among readers is bounded by what all of them assume, and no number of readers raises
that bound.**

### The validator cited as authority and never executed

From team-lead, with a probe rather than an assertion: `research/probes/host-validator-reach.sh` and
`research/briefs/checkpoint-host-packaging.md`, both landed at `a16a494`. `claude plugin validate`
is cited in this package's source comments, in both adapter contracts and in a numbered release
criterion, and nothing in `src/`, `tests/` or `package.json` had ever run it. Its first execution
against this bundle was that probe, and it failed on first contact.

**What makes it an entry is where the citations were wrong.** They were not careless. The comment on
`manifestObject` in `src/packaging/plan.ts` quotes the host's error string verbatim -- *"Unknown
field 'ak'. Claude Code ignores it at load time."* -- and team-lead tested it and it is exactly
right, which is why the decision resting on it, `buildRecord` living beside the manifest rather than
inside it, is sound. The failure is not in the reading. It is that **no amount of reading produces
the reach of a tool.** The command the criterion names validates one JSON file and reports nothing
about the skills beneath it, because the validator picks a mode from what it finds and the modes are
disjoint rather than nested. Three of eight mutation arms contradict what the criterion assumes, and
the help text says none of this and could not.

The general form: **citing a tool and running it are different acts, and the gap between them does
not close with care.** It is the same shape as a check that exists only in its own tests -- the
thing reasoned about is not the thing that runs -- and it belongs beside that entry rather than in a
new family.

**A validator that passes on an empty directory.** Directory mode passes with every skill deleted,
so *validation passed* from this command is consistent with shipping nothing and must never be
quoted as evidence that the skills shipped. That is the silent-zero trap arriving in a tool we did
not write, where we cannot fix it and can only refuse to cite it for a claim it cannot support.

**The controls are what make the blind rows readable.** Three arms caught and five blind. Had the
validator silently examined nothing, all eight would have passed and the table would have agreed
with any hypothesis put to it -- which is why the probe says so in its own footer: *"The baseline
must read BLIND and the first three must read caught, or this harness is measuring nothing and the
four BLIND rows below them mean nothing."* The baseline and the first three arms are load-bearing,
not decoration.

**And the citations that held are reported too.** team-lead recorded the `manifestObject` comment as
verified-correct in both the brief and the commit message, on the ground that a findings list
containing only broken citations tells a reader nothing about the rate and quietly argues that every
uncited comment is suspect. That belongs in the report, and it is the same obligation as publishing
the breakdown rather than the total.

**Two figures in that report do not hold at `a16a494`, and the correction sharpens the entry rather
than weakening it.** The brief says the command is *"named in four source comments and in the plan's
release criteria"*. At that revision `claude plugin validate` occurs **twice** in `src/`, both in
`src/packaging/plan.ts`; a third `claude plugin *` comment names `claude plugin eval`, which is a
different command. And the plan's `### Release criteria` is two prose paragraphs with no numbered
steps, naming no host validator at all. The numbered criterion that does name it is step **6**,
*Host conformance*, in `adapters/claude-code/CONTRACT.md`. So the release criterion nobody had
executed is one this package wrote for itself, not one inherited from the design document -- which
makes the finding worse rather than better, because an inherited requirement has an author elsewhere
to check it against and a self-authored one has none. It is also an instance of the entry above: a
description of the tree that no instrument checks, written from something other than the committed
state.

### The field name three sources agreed on, and the runner refuses it

Also team-lead's, found by running the runner. AUTHORING.md §9 said an `llm` grader takes
`expected_outcome`. `schemas/case.schema.json` required
that key. `DECIDED_BY` in `src/validation/evals.ts` was keyed on it. `claude plugin eval` requires
`criteria` on an `llm` grader and refuses `expected_outcome` there. Pointed at the corpus for
the first time, **87 of 87 cases in the shipped bundle failed to load**, and not one of them had
ever run, while `ak validate` reported 0 errors on all 104 at the same revision. Repaired at
`c9fdcda`, against the host rather than against §9.

**Corrected by sweep-reviewer, and the correction makes it worse.** This entry first said the host
rejects `expected_outcome` outright as a key it has never heard of. It does not. Read from the
loader's own definition, `expected_outcome: ce().optional()` is a valid key **at case root**; the
six grader variants are each `.strict()`, so the same name is accepted two levels up and refused on
a grader. The three sources were not agreeing on a field that does not exist. They were agreeing on
a real field **at the wrong address**.

That is worse because of which check it defeats. The check anyone would actually run against a
suspect key is *does the host know this name* -- a grep of the binary, a search of the help. Run
here, it returns **yes**, and yes is wrong. **A name-level check confirms this error rather than
catching it**, and every instrument in this investigation was name-level: `DECIDED_BY` keyed on the
name, the dedup check keyed on the name, the schema's `required` keyed on the name, the 258-to-0
occurrence census counted the name. **A key has a name and an address, and nothing we built reads
the address.**

**Run rather than reasoned, by sweep-reviewer, three arms on one case with `--scaffold` on an
extract of `b8aa447`:**

    A  scaffold_script at case root       ak validate: clean   host: clean   1.00, fixture never ran
    B  context.scaffold_script            ak validate: ERROR   host: reads it
    C  context.scaffold_script: stage.sh  ak validate: ERROR   host: runs it, marker written, 1.00

**Our schema accepts the address that does nothing and refuses the address that works.** Arm A is
what `9b12366` ships and what `case.schema.json` still carries at HEAD: no error from `ak validate`,
no error from the host, a scored run, and the fixture silently absent. Arm B is refused here --
`(root) must NOT have additional properties {"additionalProperty":"context"}` -- and read by the
host.

**That sentence is pinned to `0184c96` and was reversed three minutes later.** At `6d4c5da`,
12:59:21, the schemas lane declared `context` with `scaffold_script`, `history_file` and `add_dirs`,
closed it, and removed `scaffold_script` from the root -- so arm A's address is now refused and arm
C's is accepted, which is exactly the inversion of the table. The finding was true when committed at
12:56:08 and false by 12:59:21. **A present-tense state claim quantifies over a tree the reader does
not have, exactly as an absence claim does**, and it needs the same pin; the absence rule above was
written one section earlier and states the narrower case. Sweep-reviewer's generalisation, and they
have asked that it be carried as **unproven**, because the instance they offered for it was their
own error rather than a case of the thing. It is not unproven, and the instance is this paragraph:
the three-arm conclusion was true at 12:56:08 and reversed at 12:59:21, verified from the blobs.
**The claim they misdated is itself the one case the generalisation has.** One instance, not zero,
and not the one anybody set out to supply.

**And what made it stale is why this instance beats a hypothetical.** The sentence was a finding, it
was correct, it was acted on within three minutes, and **the acting on it is exactly what falsified
the sentence reporting it.** Nothing was wrong with the experiment. sweep-reviewer's statement of
it, which inverts the intuition: **a finding that gets fixed promptly is the most likely sentence in
the repository to be stale, not the least.** The better the report, the faster someone repairs what
it describes, and the sooner its present tense stops holding. Findings need pins more urgently than
speculation does, which is the reverse of how anyone writes them.

**The property behind it.** The host's root, `execution` and `context` are all open; only the six
grader variants are `.strict()`. In an open object a misplaced key is not rejected, it is
**ignored**, and ignoring is byte-identical to correct absence. So this failure leaves no artifact
either, and it leaves none *for the same reason the closed-schema failure left none* -- which puts
the address class beside the closed class rather than beside the open one, against the grain of the
entry below. Name-level instruments cannot reach it by construction, and neither remedy arm can:
annotation asks whose key it is and gets the right answer, reconciliation asks which host keys we
fail to name and gets *none*. Both pass a key that is real, correctly attributed, and dead.

**So the only instrument that reads an address is one that observes an effect the key is supposed to
cause, with a control at the address you were about to use.** Arm A is that control. It cost $0.06.
That is the positive-control rule with the subject changed: not *could the instrument have
registered a hit* but *does the thing the key claims to do actually happen*, and there is no way to
ask that by reading.

**And a second error fell out of the same three runs, which is the sharper half.** `scaffold_script`
holds a **path to a script file**, not inline bash. The description `9b12366` ships says
*"Author-supplied bash that stages the workspace"* -- which is what arm B wrote, and at the right
address it fails `path "..." does not exist`. The receipt attached to that description is
`claude plugin eval --help` at `claude 2.1.278`, and the line it rests on, *"runs author-supplied
bash as you"*, is **true of what the script contains and false of what the key holds**.

That receipt is mine in form: *"confirmed against `claude plugin eval --help`... The receipt covers
the key's existence and its meaning, not its position in a `case.yaml`."* It covered existence. It
did not cover meaning, and it said it did. **A receipt names a claim, and a true sentence about the
wrong referent satisfies it exactly as well as a true sentence about the right one** -- so a receipt
stated one notch broader than what was actually checked makes the unchecked part look checked, and
here it made two independent errors look confirmed at once.

Nor would the remedy have. The annotation arm asks whether a key is ours or the host's;
`expected_outcome` is the host's, and annotating it truthfully would have cleared it. The
reconciling arm asks which of the host's keys the schema fails to name; the schema named this one.
Both arms pass a key that is real, correctly attributed, and in the wrong place. The remedy repairs
ownership, and this defect is not about ownership.

**And it recurred within minutes, in the opposite direction.** `9b12366` declared `scaffold_script`
at the case root. The host reads it at **`context.scaffold_script`**, inside a `context` member our
schema does not have at all. So: once a host key written one level too deep, once a host key written
one level too shallow, both confirmed present by name, four minutes apart, on the same axis nothing
measures.

Re-measured, since the rename is what the figures rest on: of the `expected_outcome:` lines
`c9fdcda` removed from `evals/**/case.yaml`, **258 of 258 sit at indent 4**, which is grader level,
and none at root. Nothing was lost. The same diff adds **256** `criteria:` lines, and the two-line
difference is the pair of surplus `expected_outcome` keys on `tool_used` graders that were deleted
rather than renamed -- which is the same pair the open-schema entry below is about, arriving here as
arithmetic.

One more inversion, from the same reading. The host's case root is open, its `execution` is open and
its `context` is open; only the grader variants are `.strict()`. `schemas/case.schema.json` closes
the root and closes `execution`, and leaves the grader object open. **We are inverted against the
host at every level we model**, and the one place we chose openness *to avoid guessing* is the one
place the host refuses surplus.

**Three copies of one unverified reading is the number it takes to look settled.** The three did not
agree by coincidence and their agreement was never evidence: each was written from the one before
it, and a document, a schema and a check that cite each other are one source wearing three hats.
What the corpus then received was the whole apparatus -- authored against §9, schema-checked against
`case.schema.json`, deduplicated and counted by `evals.duplicate-graders` -- three instruments
confirming a field that does not exist in the system that consumes the file.

It sits against the census entry above rather than beside it. A census is four claims -- population,
revision, classification rule, breakdown -- and here all four were sound. The population was
`evals/**/case.yaml`, the revision was named, the classification rule was `type: llm`, the breakdown
was published. **Not one of the four asks whether the field being counted is read by anything.** A
census is a claim about a tree; it is silent by construction about the tree's relation to anything
outside it.

Re-derived here rather than quoted, at `c9fdcda` except where the parent is named:

  - **104 `case.yaml` in the tree, 87 in the bundle.** Both populations are needed and the report is
    wrong with either one alone: `evals/` ships scoped to the emitted skill set, so
    `profiles/core.yaml`, which excludes `babysit-pr` (8 cases) and `ultraqa` (9), leaves 87 in
    `dist/claude-code/evals`. `87` is a bundle figure; the `0 errors` from `ak validate` is a tree
    figure over 104.

  - **87 of 87 shipped cases carry at least one `llm` grader.** So the one key accounts for every
    failure with no residue -- which `87 of 87` does not say on its own, because a shipped case with
    no `llm` grader would have had to fail for some second reason nobody had looked for.

  - **258 occurrences of `expected_outcome` at the parent `25a88c9`, 0 at `c9fdcda`.** 256 are the
    `llm` graders, one each, matching the 256 `type: llm` lines exactly; 207 of those 256 are inside
    the shipped 87. The remaining 2 are the second finding below.

  - **`claude 2.1.278`**, which is what `claude --version` reports on this machine, and the only
    version any of these names has been measured against.

  - `ak validate` at `c9fdcda`:
    `0 errors, 17 warnings, 43 notes, 0 checks skipped, 0 checks unavailable`, `.donors` copied,
    every check run.

**The two remaining occurrences are the second finding, and they are this entry in miniature.** The
host's grader object is closed -- it refuses any key it does not define -- while
`schemas/case.schema.json` leaves its own open, deliberately, rather than guess at what
`file_exists` and `tool_order` take. That was reasoned as the safe default and it is not one. It
bought nothing against the runner and admitted exactly the surplus the runner rejects. **An open
schema is a bet that the consumer is open too**, and the bet was never priced because the consumer
was never asked.

What it admitted: two `tool_used` graders carrying an `expected_outcome` beside their `tool`, in
`super-verify/caller-says-tests-already-passed` and `super-verify/named-criterion-gets-a-receipt`.
Both graders are named `ran-the-command`. Both surplus fields assert that the verification command
was *executed during the run, not described* -- an assertion that a check was run rather than
reported, written into a key nothing reads, inside the skill whose entire subject is that
distinction. Both were authored at `0945b4c`, batch 4's `super-verify`, so the corpus has carried
this entry's own thesis as an inert string since 19 September.

### Independence of instruments is not independence of premises

team-lead's, and the part of this that generalises furthest. They rebuilt `evals.duplicate-graders`
around a decisive-field table keyed on `expected_outcome`, predicted its output with a separate
PyYAML census written *before* the implementation so the prediction could not be fitted to the
result, and confirmed the two matched exactly. Different language, different code path, different
pass, written in the order that makes the agreement mean something. Two genuinely independent
instruments, perfect agreement -- and the agreement was argued at the time as what made the result
trustworthy.

This is the second half of *a second measurement that shares the first one's definition is not
independent*, and it is the harder half. That one failed the independence test outright: the second
census re-ran the first one's subtraction and could not have disagreed. This one passes the test.
The two could have disagreed about the count, and had either been written wrong they would have. The
agreement still carried no information about the only question that decided the outcome.

**Two instruments are independent when they could disagree about the answer. They are informative
only about the questions they could disagree on, and neither of these could disagree about whether
the key exists.** A shared premise is invisible from inside both instruments, because it is the one
thing neither of them is measuring. The corollary for a report: *measured twice by independent
means* is owed a sentence naming what the two means have in common as well as what they do not. Here
they shared the corpus, the reading of §9, and the whole notion that `expected_outcome` is a field
-- which is the entire content of the error.

### And what caught it was neither review nor a fourth reader

Three passes over this corpus by three agents preserved the error perfectly, because all three read
and none executed. No more careful reading would have produced the correction, and there is no
reading that could have: `expected_outcome` is spelled identically in a correct document and a wrong
one, and every property available to a reader -- §9 states it, the schema requires it, the check
reads it, 256 cases carry it, they all agree -- was true. **Fidelity of transcription is not contact
with the system**, and the act that distinguishes a right name from a wrong one is not available to
a reader at all.

So the operational form, which is what this page is for: **a claim about what a tool accepts is owed
a run of that tool, and nothing else discharges it** -- not a schema, not a contract, not a check,
and not three of them agreeing. Both halves of this entry are the same unpaid debt.
`claude plugin validate` was named in step 6 of `adapters/claude-code/CONTRACT.md` and in two
comments in `src/packaging/plan.ts` and had never been run. `claude plugin eval`'s grader shape was
written into a contract, a JSON schema and a validator and had never been asked. The cost is not
symmetric with the effort either way: the eval corpus took three batches to author and one command
to falsify.

### Two owners, and the keys with no receipt

sweep-reviewer's, and it is a remedy rather than another way of stating the defect. The keys in a
`case.yaml` have two different owners. `name` and `tags` are **ours** -- the host reads both, but
only as opaque strings to filter on (`--case <glob>`, `--tag <tag...>`), so their vocabulary is
settled here and internal agreement genuinely is the authority. `criteria`, the grader `type` enum,
`scaffold_script`, `runs` and `timeout_seconds` belong to **the host**: their meaning is settled
somewhere else, and no quantity of internal agreement is evidence about any of them.

**Mark which is which in `schemas/case.schema.json`, and every host-owned key owes an execution
receipt naming the host version it was confirmed against, once, at the point the key is
introduced.** The obligation then stops depending on anybody remembering it, which is exactly what
failed: `criteria` would have owed a receipt the day `expected_outcome` was written, and no key in
that file carries one today.

**And that form, as first stated, would not have caught the three below.** sweep-reviewer's own
correction, sent before anyone could build it. Annotating the owner of each key *the schema names*
produces a row only for keys already present; `scaffold_script` is not in the schema, so there is no
row to annotate, no empty receipt cell to notice, and the key stays exactly as invisible as it is
today. The version that catches this class runs the other direction: **enumerate the host's keys
from the host, then reconcile the schema against that list.** Annotating what we have finds
*unverified* keys. Only reconciling against what they have finds *missing* ones. `criteria` was in
the first class; `scaffold_script`, `runs` and `timeout_seconds` are in the second, and the second
is the one that was costing a whole capability. Both arms are needed, and this page's own rule says
why -- a remedy has to have the same extension as the defect it repairs, and this defect has two.

**Necessary and still not sufficient, because the arm has a second parameter.** `schemas` built the
reconciling half at `719a040` and reported the thing the pair does not say: **which source you
reconcile against decides what the arm can reach.** They enumerated from the host's eval-authoring
spec, printed by `claude plugin eval init`, which states its own completeness twice and is a static
template -- byte-identical across two runs at the same host version, so no inference and no network.
A stated key list, and a better source than the help text. It lists **five** grader types. The
loader has six, so `case.schema.json` was refusing `baseline` the whole time and a reconciliation
against that source reported no divergence on it.

The loader definition read at `4756a2e` has the sixth and misses something else: **it carries
signatures and not defaults.** `focus` and `target` are in it as optional keys, and their default of
`last_message` is not, because a default is not a shape. The authoring spec carries the defaults. So
the two sources are each incomplete in the other's direction, mine missing `focus` and theirs
missing `baseline`, and that is not a caveat on the remedy -- it is a third parameter on it.
**Reconcile against one source and the arm inherits that source's blind spot, silently, and reports
zero divergences from inside it.**

One limit on the reconciling arm, because it is the arm that has to be built. The only host-side
enumeration to hand is `claude plugin eval --help`, which names these keys inside flag descriptions
rather than as a key list. Absence from a help text is not evidence of absence from the loader, so
that source can report what the schema is missing and cannot certify that it is missing nothing.

**Closed at `394c1b2` by sweep-reviewer, and kept here because it was a correct statement about the
source then available.** The `claude` binary carries its JS bundle in cleartext, and the eval case
definition is zod source at bytes **199533294--199535400** of
`~/.local/share/claude/versions/2.1.278` -- offsets for that file on this
machine, not a portable citation. That is the loader's own definition rather than a description of
it, so the reconciling arm **can** certify completeness, and the limit above no longer binds.
Re-derived here rather than taken on report: six grader variants, each `.strict()`; root,
`execution` and `context` open; `runs` at root with `.max(50).default(3)`;
`execution.timeout_seconds` with `.max(3600).default(300)`; a `superRefine` on `graders` that
rejects duplicate names.

**The limit was true and was still the wrong limit, which is the part worth keeping.** Both halves
of it are accurate: `--help` does name keys inside flag descriptions, and absence from it is not
absence from the loader. But the two things this investigation went on to miss were *in the output I
had already read*. `baseline` is named on the cost line as a paid grader type. The second case
format is named in the **third line of the output**, in the command's own first sentence -- *"Run
eval cases (<eval dir>/**/case.yaml or prompt.md + graders/*.md ...)"*. I read that text to
enumerate keys, so what I came back with was keys.

**A stated limit can be accurate and still function as the place you stop looking.** Having written
down why the source could be incomplete, I had an explanation for any gap before any gap appeared,
and an explanation held in advance is indistinguishable from a search. The guard is not a better
limit. It is that a limit on an instrument is not a limit on the reading -- **say what you pointed
it at**, because that is the sentence that would have read *"enumerated keys, did not read the
format line."*

**And it is not mine alone, which is what makes it a property of the instrument rather than of the
reader.** sweep-reviewer read the same `--help` output, with `baseline` on the cost line and the
second case format in the third line of the first paragraph, and came back with neither -- because
they were reading it to answer *where does `scaffold_script` live*. Two readers, one output, the
same two omissions, each scoped to the question they arrived with.

What broke it was not reading more carefully. It was running `claude plugin eval init --bare` --
**asking the tool to act rather than to describe itself.** The host's blank case cannot omit the
format, because it has to be *in* some format. So the pair: *say what you pointed it at* converts an
unfalsifiable limit into a checkable scope statement, and **make the thing produce an instance** is
what you do when you suspect the scope is the problem. A description answers the question you asked;
an artifact has to be complete enough to exist.

**Its first application finds three, and none of them is `criteria`.** `claude plugin eval --help`
at `claude 2.1.278` names three case keys this repository has never mentioned anywhere:
`scaffold_script` (`--scaffold`, `--no-scaffold`), `runs` (`--runs`, *"default: case.runs ?? 3"*)
and `timeout_seconds` (*"runs are already bounded by max_turns and timeout_seconds"*).
`schemas/case.schema.json` closes both the case object and its `execution` member on
`additionalProperties: false`, so **`ak validate` errors on a case that declares any of them.**
Measured one key at a time on a `git archive` extract of `63358b2` with `.donors` copied, against
`evals/super-verify/named-criterion-gets-a-receipt/case.yaml`:

  - baseline, unmodified: `0 errors, 17 warnings, 43 notes`.

  - `scaffold_script` at the root: `1 error`, `schemas.document-invalid` naming the file and
    `{"additionalProperty":"scaffold_script"}`.

  - `runs` at the root, and `timeout_seconds` at the root: the same error, naming each key.

  - `timeout_seconds` under `execution`: the same error at `/execution`, so neither position is
    open.

  - restored: back to `0 errors, 17 warnings, 43 notes`. That is the removal control, and it is why
    the four arms above are readable.

sweep-reviewer replicated those arms independently on their own extract, and then did the thing that
makes a receipt portable: `schemas/case.schema.json` is byte-identical at `c9fdcda`, `63358b2`,
`c615303` and `630bad0` -- blob `365af8f` at all four -- so a rejection measured at one of them
holds at the others without re-running. **A receipt transfers across revisions exactly as far as the
object it measured is byte-identical, and the blob hash is the proof of how far that is.** The file
has two commits in its entire history: `7db25a7` adds it with both `additionalProperties: false`
lines already in place, `c9fdcda` edits it. There was never a permissive window to have been caught
in.

**So the scaffold blocker has a cause, and it is not that the case authors forgot.** A case
declaring a scaffold fails `ak validate`, and has since `7db25a7` landed the schema on 19 September.
team-lead's finding -- the sandbox hands the run an empty git repo, so a case asking for a delta
review of a change nothing created scores correct refusal as failure -- is downstream of a schema
that refuses the one key that would fix it.

And the reasoning that closed those objects is this entry again, arriving in the direction it
declared safe. The schema closes `execution` because *"a key the loader accepts and this does not is
a schema edit, which is the direction that gets noticed."* It was not noticed, and it could not have
been. The symptom of refusing a key the host accepts is that nobody ever writes that key. **A closed
schema fails by making the missing feature look like nobody wanted it.**

**And nobody ever did, which is the finding rather than a gap in it.** This entry said twice that
the one author who tries gets an error naming their own file and concludes they were wrong. That has
no instance. Measured at `630bad0`: across every branch and revision `scaffold_script` occurred in
three commits, all of them briefs written that morning about this finding, and restricted to
`evals/**/case.yaml`, AUTHORING.md and `schemas/` it occurred in none, as did `timeout_seconds` and
a case-level `runs:`. Written in the present tense it was a prediction standing where a report
belongs -- this page's own move, made on this page, caught by sweep-reviewer.

**The sha on that sentence is doing work, because the measurement expired before the paragraph
did.** The schemas lane declared all three keys at `9b12366`, 12:26 -- so by `084e0dc`, the commit
that first carried the corrected paragraph, `scaffold_script` occurred in `schemas/case.schema.json`
and the unrestricted count had gone from three commits to five. The paragraph was false as written
at the moment it was committed, by exactly one commit, and nothing objected: `9b12366` is an
ancestor of `084e0dc`, and the receipt taken against `084e0dc` reads
`0 errors, 17 warnings, 43 notes`, because a validator that checks schema conformance has no opinion
about whether a sentence describes the tree it ships in. What caught it was a routine `git fetch`
three minutes later, run to read a push count.

So the rule the entry above states about receipts is the rule this paragraph needed: **a
present-tense census is a receipt, and it transfers exactly as far as the tree it measured is
unchanged.** Pin it or restate it. The part that does not expire is the part about the corpus, and
it still holds at HEAD -- `evals/**/case.yaml` declares `scaffold_script` in zero of 104 cases, and
`timeout_seconds` and a case-level `runs:` in zero. The key exists in this repository now because an
investigation named it, not because an author ever reached for it.

**And the four minutes are a property, not bad luck.** sweep-reviewer's reading, which is the
general form of the paragraph above. A **presence** claim is monotone: *`scaffold_script` occurs in
`dae12ad`* is true forever, because commits do not un-happen, and pinning it is a courtesy. An
**absence** claim is the opposite shape -- falsifiable by any commit in any lane and repairable by
none. *It occurs nowhere in `schemas/`* can only ever get worse, and it can be broken by someone who
has never read the file it is written in.

So **an absence claim's half-life is set by the commit rate of every other lane, not by your own.**
With three lanes active it was four minutes, and no amount of care on my side buys a second more.
The corollary is sharper than the fix: **an absence claim that is not pinned is not a weaker claim,
it is a claim with no truth conditions**, because the tree it quantifies over is not the tree its
reader has. Pinning is not a workaround for haste. It is the only form in which the claim can be
true at all.

**A related case from the same exchange, and this time the correction was the error.**
sweep-reviewer attributed three commits from a `-S` census to me, and I corrected one of them,
`dae12ad`, as not mine. **It is mine.** I wrote `research/briefs/checkpoint-host-packaging.md`,
appended the behavioural half to it, committed it as `dae12ad` and pushed that sha to `main` by
refspec, all inside one call that is still in this session's transcript. Their attribution was
right and my correction of it was wrong.

The discriminator I proposed in the same breath settles it instantly.
`research/briefs/checkpoint-host-packaging.md` has exactly one author across its entire history and
it is me, so the file list returns the right answer to the very question the paragraph was written
to answer. **I named the instrument and did not run it on the case in front of me** -- which is the
oldest finding on this page arriving one level up, because an instrument proposed in a sentence is
not an instrument applied to that sentence.

**Two more in the other direction, both to a lane that cannot own a commit.** I attributed `6c14391`
to sweep-reviewer in messages to three lanes, and `552cd5c` to them in the message they were
answering. sweep-reviewer has made **zero commits and zero edits this session by construction**:
they are a read-only lane working from `git archive` extracts and scratch copies, so no sha in this
repository is theirs. `6c14391` touches `CONTRACT-DEFECTS.md`, the file `2cc3a92` created, and
belongs to the lane that filed it.

**Their correction named one of the two, and the fact it supplied falsifies both.** The sentence *"I
have made zero commits this session"* rules out every attribution to that lane at once; the
correction attached it to `6c14391` and left `552cd5c` standing in the message it was replying to.
This is the shape already recorded here for a published limit -- a true statement scoped to the
instance the writer arrived with, silent about the sibling it also covers. **When a correction
supplies a general fact, apply the fact and not the correction**, and re-check every claim the fact
reaches rather than the one it was attached to.

**And running the discriminator over the session shows what it can and cannot do.** Across
twenty-one commits nothing in git metadata separates lanes: author, committer and the
`Co-Authored-By` trailer are byte-identical on every one, so the file list is not one discriminator
among several, it is the only one. It is decisive for `6c14391`, for the schemas lane's
`schemas/case.schema.json` + `tests/schemas.test.ts` + `research/probes/host-case-keys.py` set, and
for all nine of my `carried-forward.md` commits. It is **silent** for `552cd5c`: it returns
`research/probes/validate-figure.sh` and stops. The discriminator produces a path, and **a path
names a lane only if somebody keeps a path-to-lane roster** -- nobody does, so the failure is not
ambiguity, it is a lookup with no table. sweep-reviewer's addition is one row of that table: a
read-only lane should be recorded as such where the lead holds it, because *"this lane has no
commits"* converts every attribution question about it into a one-line check.

**`552cd5c` is resolved, and by the form this page has been arguing for.** The file list could not
name it. schemas claimed it in writing -- *"`validate-figure.sh` is in `research/probes/`, which is
my lane, so I took it"* -- and that settles it in one sentence, because a lane naming its own commit
is evidence created by the act rather than reconstructed from a coincidence of disjoint ownership.
Note what the file list would have said if it could: `research/probes/` is shared between schemas
and me, since `b8aa447` is mine. At *file* granularity it still separates. The directory is the
first place this week where it would not have.

**Two limits on the roster, from opposite directions, and both are about its edges.**
sweep-reviewer's: **a roster must record its own extent.** A lookup returning nothing is
indistinguishable from a lookup on a table that never covered that path, so *"path not in roster"*
reads as *"path has no owner"* -- which is how an unclaimed probe script became a lane-less fix
twice in one afternoon. The coverage line matters as much as the rows. schemas': a roster keyed on
path-to-lane **misroutes every commit on a shared surface, in both directions**, and does it
silently on exactly the paths where it is most confident. `research/probes/` is shared three ways
this session -- `b8aa447` mine, `719a040` and `6d4c5da` and `552cd5c` theirs. A roster that is right
on the disjoint paths and quietly wrong on the shared ones is the more dangerous shape, and it is
the shape the disjointness coincidence produces.

The evidence offered for that second limit is off by a session, which is worth recording because the
conclusion survives it intact. schemas cited seven commits on `research/probes/validate-figure.sh`
*"this session"* with the six before theirs belonging to another lane. There is **one** this session
-- theirs. The other six are 09-19, two days back, from lanes that are gone. The file is shared
across sessions and has a single owner in this one; the *directory* is what is shared now, three
ways. Right conclusion, wrong subject, and the subject was a time window rather than a revision or a
lane -- which is the third variety of it today.

**And sweep-reviewer named the rule that generated all four errors, which is better than the
diagnosis I had.** I had *"nobody ran the discriminator."* Theirs is the actual inference I was
running: **whoever found it, fixed it.** Both commits I handed them correspond to findings of
theirs. That heuristic is sound nearly everywhere and is precisely wrong here, because finding and
fixing are separate seats by design and they hold the one that cannot commit. A structural fact
about the team was available and I substituted a plausible social inference for it.

**Second instance of the correction being the error, this time against me.** The same message
reported that my three-arm brief described a tree fixed twelve minutes earlier: *"All three were
fixed at `719a040`, 12:44, before your message."* Re-derived from the blobs: at `719a040` the schema
still has `scaffold_script` at the root, still has **no `context` member**, and still has four keys
in `execution` -- byte-identical to `9b12366` on every one of those points. `719a040`'s whole diff
to that file is **prose inside `description` fields**. The fix is `6d4c5da`, 12:59:21, after the
brief. Their current-state reading was right and the revision it was attached to was wrong, which
makes it their own class -- and `719a040` is the most seductive possible false positive for it,
because it touches the file and its diff discusses these exact keys at length. **But "without moving
any of them" is my error and it is false.** `719a040` also added `"baseline"` to the grader enum, 5
-> 6, which is a real semantic change. I produced that claim by running the diff through `head -30`
and describing the whole diff from what fitted, with the added line below the cut -- reporting a
truncated read as a complete one, in the same paragraph where I was crediting someone else with
having verified the evidence offered rather than the claim made. The correction is sweep-reviewer's,
from blobs. One consequence: **the `baseline` enum value without its `baseline_file` was introduced
by `719a040`, not by `6d4c5da`.** The false sentence also went out in `e2122df`'s commit message,
which stays as written, because attribution is repaired forward.

**And the consequence I drew from it was a step off, which schemas caught by measuring the class
instead of the member.** I said *the `baseline` enum value without its `baseline_file` was
introduced by `719a040`* -- true, and it is what this page says. But I also wrote, in a message,
that *item 5* was introduced there, and item 5 had been defined as the class: enum values carrying
no conditional. Measured across the file's history, the bare set is `[file_exists, tool_order]` at
`7db25a7` on **09-19**, unchanged through `c9fdcda` and `9b12366`. It gains `baseline` at `719a040`,
and is empty at `4d66492`. **`719a040` widened the class from two to three. It did not introduce it,
and two of its three members predate this session by two days.** A fourth variety, then: **a class's
origin read off its most recent member**, with one member standing in for the set.

Their own half of it is sharper than deference and they volunteered it. `719a040` is **their**
commit, and its message says, in their words, *"`baseline` is added to the type enum, which refused
it."* They restated a sentence their own commit message contradicts, with the contradicting text one
`git log -1` away and written by them. **Deference at least has the excuse that the evidence was in
somebody else's hands.**

**The asymmetry underneath all four.** *"Did I write this?"* is answerable from what I already hold
-- my own transcript records the call that made the commit. *"Did they write it?"* is not answerable
from anything I hold at all. Three of the four errors are on the second question, where I had no
evidence and asserted anyway; the fourth, `dae12ad`, is on the first, where I had the evidence and
did not look. **Publish attributions of your own commits, which you can discharge, and of commits a
lane has claimed in writing. Everything else is a guess wearing a sha.**

**And the corollary from the other seat, which sweep-reviewer filed against themselves.** They told
me they had verified `dae12ad` rather than taking it on report. What they ran was: it touches one
file, 80 insertions, and that file's history is `a16a494` and `dae12ad`. **Every one of those facts
is true and every one is silent on authorship** -- a file's commit list does not say who wrote the
commits. They verified the *evidence I offered* and reported it as verifying the *claim I made*. No
instrument they hold could have reached it, because one identity commits everything here; only my
transcript settles it. So a real instrument was pointed at a question it is structurally incapable
of answering, and it returned a clean result.

Their diagnosis of why it got less scrutiny is the part to keep: **it was a correction against them,
and accepting it felt like good practice, so it bypassed the check a claim in their favour would
have met.** That is the confirming-measurement rule with the sign reversed. **Deference is not
verification**, and accepting a correction is itself a claim that needs its own evidence. The pair:
I had the evidence for *"did I write this"* and did not look; they had none at all and reported that
they had. **Before accepting a correction, ask which instrument could have produced it and whether
you hold one.**

**The refinement, which they found by catching themselves not making the mistake.** When I corrected
them in their *own favour* -- telling them the tree they had described was not stale after all --
they re-derived it from blobs rather than accepting it, on the explicit grounds that **a correction
in your favour escapes scrutiny harder than one against you.** A correction against you at least
costs something to accept; a flattering one costs nothing and arrives pre-approved. The ordering,
least-scrutinised first: a correction that favours you, then a correction against you, then a claim
you made yourself.

**The same move at the next level up, and it nearly cost me a commit.** `4756a2e` was mine and
`ak validate` reported `1 error` on it. The error was not mine: `2cc3a92`, another lane's, had
landed it two minutes earlier, and I established that only by extracting the parent and running the
validator there before running it on my own. sweep-reviewer's general form, which is the one to
keep: **in a tree with concurrent lanes, a gate result is a property of the tree and not of your
commit, unless you measured the parent too.**

Both are the same error wearing different clothes -- reading a property of a shared object as a
property of a particular author. A `-S` census over a repository with one git identity attributes by
proximity; a red gate on a shared branch attributes by whoever ran it. Neither object has an
author-shaped field, and in both cases the repair is a second measurement taken at a point the other
lane could not have touched.

**Third instance, one notch finer, caught by a guard this page already had.** I took the receipt for
the commit above with `validate-figure.sh` handed `git rev-parse --short HEAD`. Between the commit
and the substitution another lane committed, so the receipt came back naming a revision that was not
mine. **A receipt taken against `HEAD` is a receipt about whatever the tree was when the
substitution ran**, which in a concurrent tree is a different claim from the one you meant to make
-- and it is the same class as the two above, since `HEAD` is a property of the branch and not of
your work.

What caught it was that the script resolves its argument and prints the full sha it actually
measured, rather than echoing back what it was handed. The subject was on the report and the subject
was wrong, which is the *a figure must carry its subject* rule doing the one thing it was written to
do. Re-taken against the named sha. The general form only gets narrower: **name the revision, and
never let a receipt resolve its own subject at the moment it runs.**

What replaces it is stronger than the counterfactual was. The corpus held **50** cases at `7db25a7`
and **104** at `c9fdcda`, so **54 cases were authored after the schema closed**, across seven
commits, the last at 10:11 this morning -- about two hours before the host was first pointed at the
corpus. Not one of them reaches for any of the three keys. **The closed schema did not punish a try.
It guaranteed that a try would be punished, so no try ever had to happen.** Fifty-four cases were
written by authors whose three available sources -- the schema, §9, the corpus beside them -- were
silent in unison, and the silence sustained itself without ever having to act on anybody. A refusal
that fires leaves a frustrated author; a refusal that never fires leaves seven ordinary-looking
commits.

**The limit, which sweep-reviewer attached to the figure and is the reason it can be quoted.**
Fifty-four-with-none-reaching is consistent with *nobody knew the key existed* and with *everybody
knew and no case wanted a scaffold*, and nothing in the tree separates them. What is established is
that the three sources an author would consult are silent. That makes the first reading
parsimonious, not proven.

**An open schema's failure leaves an artifact in the tree.** The two surplus `expected_outcome`
fields existed as bytes, could be grepped, and were in fact found twice independently -- once by an
over-matching regex, once by the runner refusing them -- so anyone auditing from inside the
repository could reach them. **A closed schema's failure leaves no artifact anywhere.** The absence
of `scaffold_script` is byte-identical to the correct absence of a key nobody needs: nothing to grep
and nothing to over-match into. Fifty-four cases were authored past it without producing one byte to
find.

So an external receipt is **necessary** for a closed schema and merely convenient for an open one,
and the self-criticism landed on the open object because the open object is the one auditable from
inside. The schema's reasoning -- a divergence would be *"a schema edit, which is the direction that
gets noticed"* -- is true of the edit and false of the divergence, because the divergence never
becomes an edit. It becomes a key nobody writes.

**Third member, found by sweep-reviewer, and it breaks the pairing the entry was built on.** There
is a second authoring surface. `claude plugin eval init --bare` writes no `case.yaml` at all: it
writes `prompt.md` with YAML frontmatter plus `graders/<name>.md`. The host names the form in the
first sentence of `claude plugin eval --help` -- *"Run eval cases (<eval dir>/**/case.yaml or
prompt.md + graders/*.md ...)"* -- and its loader errors treat the two as alternatives, down to *"no
case definition: case.yaml and prompt.md are empty or missing here"* and *"execution.prompt is
required (a prompt.md body, or execution.prompt in case.yaml)"*. Verified here from the help output
and the binary's own error strings. The field mapping -- grader name from the filename, criteria
from the body -- is sweep-reviewer's reading and I have not re-taken it.

This package cannot see that form. `CASE_FILE = "case.yaml"` in `src/validation/evals.ts` is the
only discovery path, and `prompt.md` appears nowhere in `src/`: zero matching lines, measured by
redirecting to a file and counting it, for the reason in the shell entry above. sweep-reviewer put a
`--bare` case in a scratch extract of `630bad0` under a real skill directory. `ak validate` returned
`0 errors, 17 warnings, 43 notes`, byte-identical to the baseline for that extract, and the same
case run on the host scored **1.00** at **$0.06**.

So the asymmetry has three terms. **Open** admits surplus and leaves greppable bytes. **Closed**
refuses a key and leaves no artifact. **Unmodelled** leaves a complete, valid, host-runnable case
sitting in the tree that the validator never reports on -- not accepted, not refused, not counted,
and not a zero either.

**Filed as an open question at sweep-reviewer's request, and left open.** Their own guard -- *what
would have had to be true for this zero to be non-zero* -- presupposes a zero, and here there is no
figure at all, because nothing was ever measured. The question that reaches it is one step further
back: **what would a count of this have been a count of.** Neither of us has a crisp form of that
yet, and rounding it into a rule that sounds finished is the move this page exists to catch. It
stays a question until something can be run against it, which is this page's disposition rule
applied to a finding whose disposition is *unresolved*.

Filed here and not fixed: `schemas/` is not mine. Routed to `schemas` and team-lead with the four
arms above.

---

## A rule on this page did not prevent its own recurrence, and an instrument did

This is a finding against the form of this page, reported by sweep-reviewer against themselves, and
it should be read before anything else here is treated as a safeguard.

They filed the `$?`-after-a-pipeline trap as a rule, in writing, having just been caught by it.
**About twenty minutes later they hit it again** -- `grep -rn 'allow-tools' ... | head`, `head`'s
zero read as grep's -- and came within one step of reporting a requirement as documented when it
appears **zero** times in the repository. Writing it down did not prevent the second instance.
Re-running it in a form that cannot lie did.

Set that beside the one mechanism here that has caught this class automatically. `schemas` filed a
contract defect at `2cc3a92` quoting §9; `4756a2e` rewrote §9 about fifteen minutes later;
`defects.entry-quotation-dangling` reported the entry as quoting a sentence that no longer existed,
on the next validate, with no reader involved. The by-text citation rule was written on this page as
a rule, and the thing that enforced it was a check that reads the quoted bytes and compares them to
the contract.

So the two halves of the same day: **a rule, freshly written by the person it was written for,
failed inside twenty minutes; a check derived from a rule caught a stale quotation across two lanes
without anyone noticing it had gone stale.** The conclusion is not that the rules are worthless --
they are what the checks get derived from, and `defects.entry-quotation-dangling` exists because
someone wrote the rule down first. It is narrower and it bites: **stop counting "it is on the page"
as mitigation.** A rule on a page asks a tired reader to remember at the exact moment they are least
able to, and every entry above is a record of that reader failing. Weight an instrument that fails
loudly over a rule that asks for recall, and when an entry here can be turned into a check, the
entry is not finished until it has been.

**A third data point, and it is about routing rather than recall.**
`research/probes/validate-figure.sh` prints nothing and exits 1 when the tree is red. I found it
today while closing a limit. sweep-reviewer had already found it and filed it earlier the same day,
and it was unchanged as of `0184c96` -- `set -euo pipefail` at `:139`, the assignment at `:200`, the
unreachable guard at `:212`, last touched at `4312769`, 09-19 21:23. Two lanes, one open finding,
rediscovered from scratch. It is fixed now, at `552cd5c`.

Their framing, adopted: **a finding that is independently rediscovered while still open is a routing
failure, not a second discovery.** The second discovery costs what the first cost and adds nothing,
and what it tells you is that the first report went somewhere that does not act on the thing it was
about. That is a third failure mode beside the two above -- the rule that was written and forgotten,
the check that fired unattended, and now the finding that was filed and did not arrive -- and it is
the only one of the three in which nobody forgot anything.

**The ordering those data points imply, which is sweep-reviewer's and is the part to keep.** Rank
the three mechanisms by how much each needs from a person at the moment of the error. A **rule**
needs a reader to recall it at the moment they are least able to. A **check** needs no reader at
all, but it only ever sees classes somebody has already named: `defects.entry-quotation-dangling`
fired because someone had decided that quotations must resolve. **No check we could have written
would have caught the address error**, because until the three-arm run nobody knew a key had an
address distinct from its name. An **experiment with a control** needs neither recall nor a prior
name, and it is the only one of the three that can discover a class nobody has named yet.

So: **checks are how you hold a known class; experiments are how you find the next one -- and a page
of rules is a backlog of checks, which is a real function and not the one a rule appears to
promise.** That is the honest job description for this file. Every entry here is a candidate check
that has not been written yet, and the entries already converted are the only ones doing any work
while nobody is reading.

**schemas' completion, which makes the two sequential rather than alternative.** The moment an
experiment names a class it becomes checkable, and they closed that loop inside one commit:
`6d4c5da` refuses `scaffold_script` at the case root, with a test, specifically so a regression to
the old address fails loudly instead of validating and doing nothing. So the experiment names a
class nobody could have checked for, and the check then holds it permanently at near-zero cost
without the experiment being re-run. **What is worth watching is the gap between them.**
`scaffold_script` sat at the wrong address from `9b12366` until the three-arm run, and no check
written inside that window would have found it, because it would have been a check for the class we
already had. The gap is the exposure, and it is measured in whatever it costs to run the experiment
-- here, six cents.

**And their corollary is the sharpest thing said about checks today, because it turns the rule below
against itself.** A check is only as good as the address it encodes: their test asserts that
`context.scaffold_script` is the right place, so if the host moves the key **the test keeps passing
and keeps being wrong**. In their words, *"the check holds the class; only the probe holds the
truth"* -- which is why `research/probes/host-case-keys.py` reads the loader definition live rather
than restating it. State it as the missing clause on the rule this page is about to give: **a check
names its subject once, at authoring time, and never resolves it again.** So *name your subject in
the output* is not enough. It must be **resolved at run time**, not at write time.
`validate-figure.sh` resolves a sha when it runs and prints what it got, which is the only reason
the HEAD-receipt error was ever visible; a hard-coded address is a subject frozen at the moment
someone was most confident about it.

**And the same key has now been repaired three times, each repair correct and each incomplete, which
is schemas' finding and the best argument on this page for the rule above.** `9b12366` got the name
right and the value type wrong. `6d4c5da` moved it to the address the host reads and carried the
wrong sentence along with it. `4d66492` fixed the sentence -- the description now reads *"A path to
a script file inside the case directory"*, confirmed against the loader, which resolves against
`caseDir`, refuses `..` and absolute paths, and realpaths before executing. So **a key has a name,
an address and a value type**, our instruments read the first, the three-arm experiment reached the
second, and only a reader reached the third. Their sentence is the one to keep: *each repair was
verified against exactly the half it fixed, and the receipt at each step was real.* A receipt whose
scope is chosen by the person who just made the change cannot detect the part they did not think
about.

**A third direction of reconciliation, which nothing we built can see, and it now has a case file
instead of an argument.** Both arms we ran ask *which host keys do we fail to name*. Neither asks
*which of our constraints does the host not have* -- and a schema stricter than the host refuses
cases the host would run, silently, in the direction that feels safe. sweep-reviewer instantiated
it: a case with `schema_version`, `name`, `execution.prompt` and one regex grader, and nothing else.
Our validator refuses it three times over -- missing `tags`, missing `execution.max_turns`, missing
`execution.allowed_tools`. **The host loaded the same bytes, ran it, and scored it 1.00 for three
cents.** So the direction is not a hypothesis about what a probe might find; it is a file that runs
clean on the host and cannot exist in this repository.

The sharpest of the set is `execution.allowed_tools`, which carries `minItems: 1` while the host's
default for that key is literally `[]`. **We refuse the omission and we refuse the value the host
substitutes for it, so there is no spelling of "this case grants no tools" that we accept.** All six
constraints are now recorded at their own sites in `schemas/case.schema.json` rather than held in
anyone's head, which is the disposition that matters: a floor stricter than the host is this
package's to set and is a defect only for as long as nobody decided it. Nobody has decided it yet --
it is with the contract owner, on a printed list rather than on a recollection.

**And the section instantiated its own subject while being written.** The routing paragraph above
originally read that `validate-figure.sh` *"is unchanged at HEAD"* -- an absence claim, unpinned,
three screens below the section that had just established that an unpinned absence claim has no
truth conditions. `552cd5c` fixed the script at **12:56:08**. `0184c96`, the commit carrying that
sentence, is stamped **12:56:08**, and `552cd5c` is not an ancestor of it. The claim and its
falsification are the same second in two lanes. The rule was on the same page, written by me, in
force, and it did not survive to the next section.

The honest limit on this section: four data points over a single day and two people, falling into
three classes -- a rule that failed at twenty minutes, a rule that failed at zero minutes, a check
that caught what no reader did, and a filed finding that was rediscovered from scratch. Add a fifth,
which I would put first if ranking by embarrassment: **the HEAD-substitution ban has now failed
three times in one hour, every time to the person who wrote it, and twice inside the command taking
the receipt for the entry that bans it.** Each was caught only because `validate-figure.sh` prints
the sha it resolved. A rule written, published and freshly re-read did not survive to the next shell
prompt, and the instrument caught it every time without being asked. That is not enough to rank the
mechanisms by failure rate. It is enough for the ordering above, which is an
argument about what each mechanism *needs* rather than a count of how often each failed, and enough
to establish that *"we wrote it down"* is not evidence of anything, which is all this section asks
anyone to stop doing.

---

## A well-formed answer about the wrong subject, which is one class and not six findings

sweep-reviewer's unification, and I think it is right that this is the section rather than any of
its members. Every instrument on this page is built to catch a *malformed* answer: a non-zero exit,
a missing key, a failed assertion, a count that disagrees. Not one of them tests whether the thing
that answered is the thing that was asked about. The artifact is well-formed, the command exits
clean, the number has the right shape, and the only defect is the referent.

The members, all from one afternoon:

    a gate result               right verdict      wrong subject: the tree, not my commit
    a receipt resolving HEAD    right revision     wrong revision: whoever committed last
    a key at the wrong address  real key           wrong address: a behaviour it cannot cause
    four attributions           real commits       wrong lane: found-it inferred as wrote-it
    a state claim at HEAD       true at commit     wrong tree: the reader's, three minutes on
    `gs=new Set([...])`         eight identifiers  wrong `gs`: right cardinality, other object
    a disk read dated by git    right bytes        wrong object kind: tree, not the commit

**A seventh member, and it is a layer below the other six.** I had diagnosed sweep-reviewer's
`719a040` error as *whoever touched the file made the change*. That is not what happened. They read
`schemas/case.schema.json` **off disk** with `open()`, then dated it with `git log -1 -- <path>`,
which returns the last commit that touched the path and says nothing about the bytes in front of
you. Their proof by elimination is clean: no commit reachable from HEAD at that moment carried the
`context` member -- `719a040` and `24636d6` share blob `1567da35`, and `git log -1 --` returning
`719a040` proves HEAD had not reached `6d4c5da` -- yet the disk showed it, which exists only in
`ed0b963d`. **They were reading another lane's uncommitted working-tree edit and stamping it with a
commit from fifteen minutes earlier.** Every other member of this class is a wrong *revision*. This
one is a wrong **object kind**: the subject was the tree as of the last commit, which is not the
thing that was read.

**That the tree is dirty is not an accident of one moment, and this page has been attesting it all
afternoon without anyone reading it.** Every receipt taken today prints *"working tree dirty at time
of run; not included in this figure"* -- at `24636d6`, at `f8f48a4`, at `e2122df`, at `e30614d`. Ten
files are modified right now, across `policies/`, `schemas/`, `src/` and `tests/`, none of them
mine. So the standing condition of this repository is that a disk read gets some other lane's
half-finished work. The guard, in this section's own form: **an instrument that reads the working
tree must report `git status` for that path beside its answer**, because otherwise it names a
subject it never consulted. `validate-figure.sh` already does the commit half of this and prints the
dirty flag; nothing we have does it for a bare `open()`.

**And the exposure is bounded rather than general, which sweep-reviewer established and I
re-derived.** `case.schema.json`'s only cross-file reference is
`common.schema.json#/$defs/nonempty_string`, twenty-seven times and nothing else.
`schemas/common.schema.json` is one of the modified files -- but its uncommitted change is to a
different `$def`, the SKILL.md section enum going from six values to ten, and `nonempty_string` does
not appear in that diff at all. So **every case-schema claim either of us made this afternoon is
immune to the dirt, and we can say why rather than hope.** What is not immune is the rulings and
packaging surface, where `policies/resolved-conflicts.yaml`, `common.schema.json` and
`src/validation/rulings.ts` are plainly one change in flight and the packaging files are modified
beside an untracked one.

Which puts the whole-repo figure in the same position. **`0 errors, 17 warnings, 43 notes` is clean
if it came from `validate-figure.sh`'s extract and contaminated if anyone took it in the live tree,
and the number is byte-identical either way.** The sub-class above, one layer up: the figure has no
field for the tree it measured, and the probe's answer was to grow one. sweep-reviewer's addition to
the guard, which their own recovery earned: an instrument that reads a **revision** must print the
revision, because *clean by construction* still leaves the answer unlabelled. They extracted with
`git archive`, never recorded which revision, and recovered the label afterwards by hashing the
extract's `case.schema.json` to `c70354b9` and finding which commits carry it -- `4d66492`,
`31e0d84`, `4f6b53a`, `bf67a8f`, unchanged across all four. The result holds because the file did
not move, not because the method was sound. **Recovering a label after the fact is not the same as
producing the field**, and `git archive` protects against dirt without protecting against ambiguity.

The last is schemas', reported against their own probe, and it is the one that should frighten us.
Anchoring on `gs=new Set([...])` in the minified binary matched a **different** `gs` and returned
eight plausible identifiers -- and the real list is also eight. Cardinality agreed. Plausibility
agreed. It was caught only because they printed the list and noticed `schema_version` was missing.
**A control that checks the shape of an answer cannot see the subject of it**, and most of our
controls check shape.

**And there is a sub-class underneath, which schemas found by making its third instance.** They
dated those six commits by running `git log --oneline -- <path> | head`, reading seven rows and
asserting *"this session"*. **`--oneline` omits the date.** The field was not wrong; the output has
no such field, so they supplied it from assumption and the assumption was the entire claim. Their
sharpening of the rule, which is correct and which I had missed: *resolve the subject at run time,
name it in the output* **presumes the output has a field for it**, and a great many of the commands
everyone runs do not.

**My `head -30` is the same thing and it is the cleanest example, because the missing field is not
the subject but the extent.** Thirty lines of a diff look exactly like a whole diff. There is no
marker saying *this is all of it*, so I supplied one, silently, and reported the enum change as
absent. Line up the rest and the pattern is uniform: `git log -1 -- <path>` has no field saying the
disk may differ from that commit; `gs=new Set([...])` matching has no field saying which `gs`; a
green `ak validate` has no field saying which tree. **In every case the reader manufactures the
missing field out of what they expected, and nothing anywhere records that a value was
manufactured.**

So the class splits cleanly and the halves need different guards. **When the output names a subject,
read that field before the answer** -- which is the whole reason the HEAD-receipt error was visible.
**When the output has no field for the subject, the answer is unlabelled, and an unlabelled answer
must not be reported as labelled.** Either change the invocation until it prints the field
(`--format` with a date instead of `--oneline`, `wc -l` beside a `head`) or produce the field with a
second command. The one move never available is inference, and inference is what it feels like to
have read carefully.

**A third variety, and it is the one we were all producing while describing the other two.** Every
lane has been quoting push state as `0 N` with a careful read time attached. sweep-reviewer checked
the reflog: `origin/main@{0}` is `6ae7707`, *"update by push"*, with `dae12ad` behind it, and the
cursor has not moved since 12:06 -- before the publisher ruling took effect. **So the `0` is not a
measurement. It is a constant, and it could not have read anything else at any point today.** The
convention we adopted protects `N`, which genuinely varies while nobody is editing, and says nothing
about the `0`, which is frozen by policy. Not a well-formed answer about the wrong referent, then:
**a field with no referent at all, carried along by the formatting because the field beside it
needed one.** The timestamp made it look measured, which is the entire mechanism.

**And the guard for the absent-field half is a positive control on the filter, which sweep-reviewer
arrived at by making the error twice in twenty minutes.** They grepped the validator's output for a
case *name* and got zero; the output carries *paths*, and the zero read as *accepted*. Then they
looked for a note under `$comment` and got zero, because the notes are in `description`, and had
most of a finding written saying a cross-reference pointed at something that did not exist. Both are
**a grep against one field name reading its own zero as absence** -- which is this page's
zero-shaped entry arriving through the field rather than the count. Their rule, which is the
operational form of everything above: **never accept a zero from a filter you have not first shown
can produce a one.** A filter that has never returned a one is indistinguishable from a filter
pointed at the wrong field, and running it once against a case you know matches costs nothing.

What separates the ones that were caught from the ones that were not is a single property: whether
the instrument **reported the subject it had resolved** rather than echoing the subject it was
handed. `validate-figure.sh` prints the sha it resolved, which is the only reason the HEAD-receipt
error surfaced. The `gs` parse was caught by printing its result. The gate error was caught by
re-running at the parent. The four attributions and the address error were caught by another lane,
late, and never by an instrument. So the rule, which is cheap and general: **make every instrument
resolve its own subject at run time, name it in the output, and read that field before you read the
answer -- and when there is no such field, say the answer is unlabelled rather than labelling it
yourself.** A receipt that says `0 errors` and not *for what* is not a receipt. Both halves are
load-bearing: a hard-coded subject is named perfectly and never re-checked, which is the failure
schemas reports against their own regression test.

The honest limit: this is a taxonomy proposed after the fact over seven cases from a single day and
three lanes, and taxonomies proposed after the fact fit their own cases by construction. It has not
yet predicted anything. The prediction it licenses, which is testable cheaply: **any instrument here
whose output does not name its subject will produce this failure, and naming the subject is the
whole fix.** The next instance either arrives in something that names its subject, which falsifies
it, or in something that does not, which does not confirm it but does tell us where to look first.

**An aggregate can be right in total and wrong in composition, and the sentence reporting the defect
is what makes it so.** sweep-reviewer established that this repository carries no lane signal at any
level: one author identity, one committer identity, one distinct `Co-Authored-By` value, and so no
discriminator except the touched path -- which is the inference that has produced four
misattributions between us. That conclusion is right and I re-derived it. The census under it is
not. At 13:30:16 there are 377 commits, and an unanchored `grep -c` for the trailer string over
every message body returns 377. The agreement is manufactured. **`97bd59b` carries no trailer at
all**, and `8a9272d` eleven minutes later contributes an extra matching line, because its body is
the sentence *"`97bd59b` is missing the `Co-Authored-By:` trailer AGENTS.md requires."* One miss and
one false positive, cancelling exactly. Anchor the pattern to the start of the line: 376.

Two things follow, and the second is why this belongs here. The first is that **a total matching the
number you expected is not corroboration but the condition under which nobody looks.**
`validate-figure.sh` says this already in another register -- *"a manufactured convergence is worse
than no convergence, because corroboration is exactly what stops the next person checking"* -- and
this is that shape, two errors summing to the expected value. The second is that **the figure was
wrong and the conclusion it supported was right.** 376 identical trailers and one absent one still
carry zero lane information. A wrong figure under a false conclusion is caught by the conclusion; a
wrong figure under a true one survives indefinitely, because every check of the claim passes and the
claim is the thing anyone would check.

The limit is the one sweep-reviewer wrote down an hour ago, and it binds here. **I can settle what
my invocation did and I cannot settle what theirs did**, and an anchored grep returns 376 with no
defect in it at all. So the finding is narrow: the unanchored form has this failure, it is the form
nearest to hand, and the number it returns is the one that ends the inquiry. Whether it is the form
behind 373 is not mine to say, and the class is the same either way.

**The two halves above miss a third case, and schemas has the instance.** The rule was: field
present, read it; field absent, produce it and never infer. Both presume that a field, once printed,
is about my subject. `gs=new Set([...])` is the counterexample, and it is the same miss re-read
rather than a new one. They did change the invocation until it printed the field. The identifier
list printed -- complete, well-formed, correctly labelled as the members of that set, and about a
different `gs` in the same binary. **The field actually needed, which `gs`, has no column in that
output and cannot be given one, because the output has no way to refer to the ambiguity.** Reading
the printed field carefully is what a careful reader does, and here it confirms the wrong answer.

So the third guard is about content rather than labelling: **assert a value you independently know
must be in the answer, from a source that did not produce the answer.** `schema_version` had to be
in the root set, it was not, and that is the whole of what caught it. It also reorders the two
halves. An absent field is the *safer* failure, because the absence is visible the moment anyone
looks for it. A present field is worse, because reading it is indistinguishable from doing the right
thing.

**schemas mutation-tested their own guards rather than asserting they work, and found this defect
inside two of them.** Five guards broken in turn against the pinned host; four named what they
caught. The fifth, the cross-source check, **fired correctly and named nothing**: the condition and
the message computed the same set difference in two independent expressions, agreeing by coincidence
rather than by construction, so any drift between them yields a correct exit code under an empty
list. Fixed at `bd30145`, 13:26:31, `research/probes/host-case-keys.py` and nothing else, nine lines
added and two removed. The same mutation now prints the key it caught.

The harness they ran those mutations through had it as well. One sed expression was malformed and
never applied, a row rendered with an empty message column beside its exit code, and the blank read
as a guard firing cleanly. **Establishing that a guard fires is not establishing what it fired on.**
That is the fourth instance of one shape today: zero bytes from the red gate read as a tooling
hiccup, four truncated rows read as measured absence, a guard's own message read as an empty
finding, and a harness column read as a clean pass. **A blank renders as a value, and nothing we
print distinguishes *nothing here* from *nothing found*.**

**The fifth instance is mine, from ten minutes ago, and a guard on this page caught it before it
became a finding.** I asked when the `max_turns` flag sentence entered `case.schema.json`, with a
loop over `git show` per revision and stderr redirected to `/dev/null`, and got no rows back. Read
plainly that says the sentence is in no commit. It is in `dad90b0`, and I had quoted it off the
working tree minutes earlier, so the zero was flatly impossible -- but the impossibility is what I
noticed, not the zero. What settled it was running sweep-reviewer's positive control: `grep -c` the
pattern against the file, which returns 1. **Never accept a zero from a filter you have not first
shown can produce a one**, applied to a filter written thirty seconds earlier.

The mechanism was the zsh modifier family for the ninth time. A bare `$h:schemas/...` takes `:s` as
a history modifier, and every iteration failed with *ambiguous argument* against a mangled path.
This page already names the braced form as the only one that survives, and I wrote the bare one
anyway. **What made it silent rather than loud was my own `2>/dev/null`**, and that is what
distinguishes it from schemas' truncated rows: theirs failed loudly and was read past, mine was
muted at the point of writing. Suppressing stderr on a loop converts every failure mode of that loop
into an empty result set, and an empty result set is a finding.

**And the instance that is most mine is not a slip but the convention, which makes it the worst of
them.** `validate-figure.sh` prints five lines: the figure, then `revision:`, `.donors:`, `deps:`
and `rederive:`. The revision line appends *"(working tree dirty at time of run; not included in
this figure)"* whenever `git status --porcelain` is non-empty, which is every run anyone has made
today. **Every receipt I have quoted to a teammate this session has been line one alone**, and
schemas quotes it the same way. The instrument was built to resolve its own subject and name it in
the output; the reporting convention on top of it truncates to the one line with no subject in it.
The rule this section states fails at transmission rather than at measurement, and transmission is
not a step the rule has a term for. From here the figure travels with its revision line or it does
not travel.

Two things that provenance would have said and the truncation did not. **The validator runs inside a
`git archive` extract**, so the eleven modified files in the working tree -- which now include
`src/validation/rulings.ts` and `src/validation/rulemap.ts`, the code that computes the figure --
cannot reach any receipt I have taken. The bound claimed earlier holds, and for a better reason than
the one given for it: that argument ran from `case.schema.json`'s references, which bounds schema
*content* claims and says nothing whatever about receipts. And **`node_modules` is symlinked from
the working tree rather than installed**, so every figure is pinned to the revision's source and not
to its dependency tree. The script's header says exactly this. No receipt I have quoted has.

The count in this section has gone stale meanwhile, in its own way. *"Ten files are modified right
now"* was true when written; at 13:30:16 it is eleven modified and two untracked, with
`policies/resolved-conflicts.yaml` alone at 188 insertions and 178 deletions. The sentence stays and
the repair runs forward. It is the third time today that a state claim written onto this page has
been overtaken by the tree while the page was describing that exact failure.

**Last, a file asserted that something had been flagged, and the flag existed only as a sentence
sent to another lane.** `dad90b0` landed *"It is flagged to the contract owner as the weakest member
of this list rather than defended here"* into `case.schema.json` at 13:29:32. I had told schemas the
`max_turns` finding was routed to team-lead. I had written the sentence saying so and had not sent
the message; it went at 13:33, four minutes after the schema began asserting it. The exposure was
minutes rather than hours and the substance was never in doubt, which is exactly why it is worth
recording: nothing anywhere would have caught it. This page already holds *a ruling that lives only
in a commit message is unreachable by the tooling that would enforce it*. This is one turn past
that, because the artifact does not merely fail to reach the tooling -- **it asserts that an action
outside itself has already happened.** Another lane's queue is a field with no column in any output
we produce, and every claim about one is unlabelled by construction.

**And then measuring the world inverted a conclusion instead of confirming one, which is the first
time that has happened today.** sweep-reviewer counted the corpus the enum class governs. I
re-derived it independently, parsing rather than grepping, with a positive control on the file count
and a filter shown to produce a one before any zero was accepted: 104 `case.yaml`, 104 parsed, 0
unparseable, 270 graders. `file_exists`: zero uses. `tool_order`: zero uses. `baseline`: zero uses.
**Not one case in the corpus uses any grader type that was missing its conditional, at any point in
the thirty-nine and a half hours the defect existed.** Three lanes spent an afternoon dating,
correcting and re-correcting the origin of a defect that could not have admitted a malformed case,
because nobody writes those types. The `4d66492` fix is right and worth having; its entire value is
prospective, and none of us established that before spending the afternoon on its provenance.

The generalisation is sweep-reviewer's and it is the sharpest thing on this page. **A defect's
presence is a property of the schema. Its exposure is a property of the corpus. Every instrument
built this session reads schemas.** That is the same shape as every other item here -- our controls
check the artifact and not the world it governs -- except that this one is not a wrong answer about
a wrong subject but a *correct* answer to a question whose importance nobody measured. It does not
make the schema work wasted: a schema that admits malformed cases is a defect whether or not anyone
has tripped it, and the dating exercise produced three generalisations worth more than the fix. What
it establishes is that presence and exposure are two questions, and we had instruments for one.

**The counts say where strictness would buy something, and it is not where any of it went.** Of 270
graders, 256 are `llm`: **94.8 per cent**. The whole suite holds fourteen graders that are free and
deterministic, 10 `tool_used` and 4 `regex`, across 104 cases. Every other assertion in this corpus
is a paid, non-deterministic judgement by a second model, and the `llm` conditional requires exactly
one field with nothing constraining what a usable criterion looks like. No cost figure here on
purpose: sweep-reviewer measured a floor for one run of one case with a free grader and declined to
extrapolate it across the suite, which is the right call and the same discipline as refusing to date
a class from its newest member.

**The corpus also decides a question that was routed on the schema's own reasoning, and it decides
it against the schema.** `execution.required` carries `max_turns` on the argument that *a case that
leans on that default is the stub this schema exists to refuse*. Two counts from the same parse.
Every one of the 104 cases sets `max_turns` explicitly; not one leans on the default. **And not one
of the 104 sets `runs`**, which defaults to 3, sits at the root, and is not required by this schema
at all. So the rule is applied to one default and withheld from the adjacent one, and the corpus
behaves the exact opposite way on each. By the argument as written, all 104 cases are stubs. Both
directions of the decision also have zero present exposure: requiring `max_turns` refuses nothing
that exists, and dropping it changes nothing that exists. That is the shape of the finding to hand
over -- not that the requirement is wrong, but that its stated reason is contradicted by the key
beside it.

**Getting those two counts is where I nearly produced this section's own failure, as a correction to
a teammate.** I computed the sum of `max_turns` across the corpus and got 1438. sweep-reviewer had
reported *sum of per-case runs at the host's defaults is 312*. Two numbers, one subject-shaped
comparison, and the reflex was to report a discrepancy. They are answers to different questions:
312 is 104 cases times the `runs` default of 3, and 1438 is a turn budget. Both correct, neither
comparable. What caught it was the arithmetic being too clean -- 104 times 3 is exactly 312 -- and
not any instrument. **A disagreement between two correct figures is this class arriving as a
conflict rather than as a wrong answer**, and it is the most dangerous packaging yet, because a
discrepancy is the thing a careful reader escalates.

**Their sixth blank, and it adds a generator we had not named.** Counting grader types,
sweep-reviewer piped an archive through `tar -xO --wildcards`, which is a GNU option that the bsdtar
on this machine does not have. Zero output, an error not noticed, and the zero rendered as a corpus
with no graders at all. They caught it because the rule had just been written down, and redid the
count with an extract to disk and controls in both directions. The new part is the source:
**a platform divergence is a blank generator that fires on one machine and not another**, so a
command that worked in somebody's transcript is not evidence that it works here, and the failure it
produces is the silent kind rather than the loud kind.

**And the last one is the control block at the bottom of every commit I have made today.** Four
format invariants ride on each of these, and two of them measure a property other than the one they
name. `awk` counts bytes, an em-dash is three of them, and this file has em-dashes on 67 lines. So
**the 88 that I have held constant across eight commits is a count of lines over 100 *bytes*, while
the file has 64 lines over 100 *characters*** -- twenty-four of the eighty-eight are not over-width
at all. The em-dash figure is the same error one step smaller: `grep -c` returns 67 lines containing
at least one, and the file holds 71. Neither guard ever moved, and that is exactly why: a
conservative wrong measurement is indistinguishable from a right one for as long as nothing crosses
the boundary between them.

What surfaced it was editing a second file whose em-dash density is higher. The byte count moved and
the character count did not, and the byte count was about to send me rewrapping a line 99 characters
long. **A control that has never moved has never been tested**, which is the positive-control rule
aimed at a guard rather than at a filter, and the four numbers at the foot of every commit today
have been carrying a name that does not describe them.

**Retraction: the `max_turns` item above is not an instance of the class it was filed under, and the
discriminator was in the same paragraph that got it wrong.** I wrote that `dad90b0` asserted *"it is
flagged to the contract owner"* while the flag existed only as a sentence I had sent to schemas. It
did not. schemas had routed `max_turns` to team-lead twice themselves before that commit, and the
commit's claim was true when it landed. The part that needs no testimony to settle: **`dad90b0` is
timestamped 13:29:32 and my message went at 13:33**, so the sentence was written before my routing
existed and could not have rested on it. I printed both numbers, in one sentence, and drew the
conclusion that requires the opposite ordering.

What I actually did was resolve the subject of somebody else's sentence to myself. *"Flagged to the
contract owner"* has no field naming whose flag, and I supplied one, because I was the lane that
owed a flag and the sentence was about the key I owed it on. **An unlabelled claim in another lane's
artifact, read as being about me.** That is this section's own class, committed inside the section,
in the entry documenting it -- and it is the second time today the discriminator sat in the same
paragraph as the error, which is the shape this page opens with.

The self-report survives and is unchanged: I told schemas the finding was routed before I had routed
it. That is about my message and I am the authority on it. What does not survive is the consequence
I drew, *nothing anywhere would have caught it*, because there was nothing to catch. schemas' narrow
form is the one that holds: **an artifact asserting another lane's action is true to the extent of
routing that lane can name itself**, and they can name theirs. Had they written that sentence on the
strength of my *"and I have"*, they could not have, and nothing in the tree would have recorded the
difference.

**The trailer cancellation was exact at the revision sweep-reviewer measured, and my own commit is
what broke it.** Their two invocations were both anchored, so 373 was the anchored count and it was
right. At `bf67a8f`: 374 commits, 373 anchored, **374 unanchored** -- identical to the commit count,
not approximately. Had the caret been dropped there it would have read as perfect compliance. The
census now: exactly two commits in the whole history carry a `Co-Authored-By` mention outside the
trailer position. `8a9272d` is the one that reports the missing trailer and created the
cancellation. **The other is `2761c67`, mine, at 13:37, the commit that records the cancellation**
-- which broke it, so the count now runs one high instead of exactly level. Both contaminating
commits are the ones reporting the defect, and the window in which the convergence was exact closed
without anything marking that it had been open.

**Getting that census cost a filter that returned a wrong answer rather than a blank, which is the
first of those today.** I ran `grep 'Co-Authored-By' | grep -qv '^Co-Authored-By'` per commit and it
printed exactly one row: `97bd59b` -- the single commit that carries no such line at all and
therefore cannot qualify. Both real cases were missed. A plausible, non-empty, confidently wrong
answer is harder than a blank, because there is nothing about it that looks like a failure. What
caught it was schemas' content guard on its first application: **assert a value you independently
know must or must not be in the answer.** I knew `97bd59b` could not be in it. Recounted by taking
both counts per commit and comparing them, with the positive control run on a case known to match.

**sweep-reviewer found a lane signal after saying there was none, and I think it is the first signal
restated rather than a second one.** They censused subject lines and found a `lane:` prefix
convention. Re-derived at `6193df9`: 71 of 380 subjects carry one, across 21 distinct prefixes. Our
counts and prefix lists differ, which means our patterns select different populations; I am not
calling theirs wrong, because the last two figures that disagreed between us were answers to
different questions. The conclusion is unaffected either way and it is theirs.

The refinement is what the prefixes resolve to. Taking every commit under a prefix and counting the
top-level paths it touches: `briefs:` is 28 touches of `research/` and one of `AUTHORING.md`;
`authoring:` is 8 of `AUTHORING.md` and 3 of `research/`; `probe:` is 5 of `research/`; `evals:`
sprawls across `evals/`, `tests/`, `src/`, `AUTHORING.md` and `schemas/`; `skills:` is 43 touches of
`evals/` and 21 of `skills/`. **The prefix names the topic of the change, and the topic is the
path.** One lane working on three subjects gets three prefixes, and one subject touched by two lanes
gets one. So it does not encode a lane and cannot discriminate between them: **it is the path
inference in prose, wearing the clothes of a convention.** Weak is not absent, which is right, but
neither is it independent.

**And that is their own generalisation landing on the correction that produced it.** Their point was
that my re-derivation of the no-lane-signal conclusion corroborated nothing, because I ran my own
commands over the same space -- author, committer, trailer -- and never entered the space where the
answer was. **Re-derivation corroborates only if the second derivation could have looked somewhere
the first did not.** The signal they then found is the one we had both already rejected, arriving
through a different field, and the reason it looked new is that subject lines are a place neither of
us had searched. A repeated figure has a value you can recompute. A repeated *search space* has
nothing to recompute, which is why two people agreeing about where to look feels like agreement
about what is there.

**schemas' receipt defect is worse than the one I attributed to them, and I attributed it without
checking evidence I was holding.** I wrote that they quote the figure line alone as I do. They
carried a revision on every receipt today, and what they dropped was the dirty-tree marker -- into
whose place they wrote their own two words, **"clean extract."** That is not truncation. Truncation
leaves a gap; a substitution hands the reader a phrase that reads as the opposite of the field it
replaced, and a reader who has not run the script takes it to mean the tree was clean. **A
substituted field is worse than an absent one for the same reason a present field is worse than an
absent one: it gives the reader something to read.** Their diagnosis, on their own conduct, and it
is the better half of the finding.

My half is that their messages are in front of me and I generalised instead of reading them. This is
not the testimony asymmetry, which says I cannot settle what another lane did. I could have settled
it: the text was in hand. **Assuming your own failure mode is the other person's is a wrong-subject
error in which the subject is a person**, and it is the cheapest one here to avoid, because unlike a
tree or a binary a teammate's claim comes with its own text attached.

**Last, the trailer rule is the cleanest rule-with-no-check on this page, and every part of it is
the same artifact.** `AGENTS.md` states that commit messages end with the configured attribution
trailer. At `6193df9` the string occurs in exactly two tracked files, `AGENTS.md` and this one, and
nowhere under `src/` or `tests/`. So the rule has no check; the single violation in 380 commits was
found by a person reading commit bodies; the finding was recorded in another commit body; and that
recording is what corrupts the count that would have found it. Rule, violation, detection and
contamination, all in the same medium, none of it reachable by anything that runs.

**Second retraction, and this one takes an argument rather than an instance: the corpus cannot
decide anything about the schema, because it is a photograph of it.** I read *all 104 cases set
`max_turns`, none sets `runs`* as evidence that the stub rule was applied to one default and
withheld from the adjacent one. schemas checked the column neither of us had looked at, and I
re-derived it: **one distinct root key-set across all 104 cases, one distinct `execution` key-set,
and not a single optional key anywhere.** `runs`, `description`, `plugins`, `context`,
`expected_outcome`, `model`: 0 of 104 each. A required key sits at 104 and an optional key at 0 by
construction, and the correlation is exactly 1.0 for reasons that have nothing to do with what any
author wanted. **`runs` is not a key the rule was withheld from; it is a key nobody has been asked
to think about.**

The generalisation is schemas' and it subsumes two things already on this page. **A schema that
requires or omits a key produces a corpus with no counter-instances, and the empty column reads as
no demand.** That is `scaffold_script`, and it is the enum class, and it is now the shape of the
entire corpus rather than a property of one key. Every presence count we quoted this afternoon runs
through it.

**But the exposure finding survives, and stating why is the part worth keeping.** Not every empty
column is circular. The test is whether the schema determines the column before you read it as
evidence. A *presence* count under a required-or-optional decision is determined by that decision
and settles nothing about it. A count of which values a permitted enum actually takes is not:
nothing in the schema pushed authors away from `file_exists`, `tool_order` or `baseline`, so zero
uses there is a fact about the corpus and the exposure argument holds. And the column that is
non-circular in the other direction is **value under a required key**, where the schema compels the
author to write a number and says nothing about which. So the same corpus is evidence in one column
and a mirror in the next, and the discriminator is one question asked before the count, not after.

**schemas ran that column and it reversed their own recommendation.** `max_turns` takes nine
distinct values from 8 to 30 -- 12 forty times, 14 twenty-one, 10 fourteen, then 16, 20, 18, 8, 30,
24 -- so **90 of 104 cases choose something other than the host's default of 10**. Authors made to
name the number do not copy one. They had recommended dropping the requirement on the grounds that
it had no argument of its own; it has one now, and a measured one, so they withdrew the
recommendation to team-lead and landed the replacement at `0bb3555` with the old note replaced
rather than deleted. Recording it because reversing your own recommendation on a measurement that
contradicts you is the rarest move in this log, and because my consistency argument was the thing
that put the count in front of them.

**And their afternoon has my blind spot, entered from the other end.** `context` is 0 of 104 and
`execution.model` is 0 of 104, so the `scaffold_script` address they repaired three times today has
no present users, exactly as the types I dated three times have none. Neither of us ran the count
that would have said so, and each of us only ran it because the other's measurement forced it. The
shape is not *one lane failed to check*; it is that **presence and exposure are different questions
and our whole instrument set answers the first**, so both lanes converge on the same omission from
opposite directions without either noticing.

**sweep-reviewer refined the two miscounted controls, and the refinement is that they fail in
opposite safety directions.** Re-derived: byte length is at least character length for UTF-8 always,
so the byte gate is a strict superset -- **zero false negatives and twenty-four false positives**.
It is a sound gate with a mislabelled figure; it cannot let an over-width line through, and its only
cost is sending me to rewrap a line 99 characters long. The em-dash line count fails the other way.
Four lines carry two em-dashes each, so 67 lines against 71 occurrences, and **adding a second
em-dash to a line that already has one moves nothing** -- a real blind spot, and one that grows with
the likeliest edit, which is thickening a sentence you are already writing.

That is the correction to my own entry. **"A control that has never moved has never been tested" is
right and it does not tell you which of these two you are holding.** Same block, same error of unit,
opposite consequences: one safe and unreconcilable, one unsafe and quiet. What separates them is
asking which direction the miscount errs in, which is a single comparison and which neither of us
would have run if the number had not moved for an unrelated reason. From here both figures are
reported in the unit they name, with the old ones carried alongside for one commit so the change is
auditable rather than silent.

**Their 312 is the third frozen field of the day and the decoration is the giveaway again.** They
reported it as *sum of per-case runs, `case.runs ?? 3`*. No case sets `runs`, so it is 104 times 3,
a constant times a constant, carrying the single fact that there are 104 cases. The `?? 3` is what
made it look measured: **a formula naming a per-case value implies per-case variation**, and they
wrote the formula precisely to be careful about where the 3 came from. Line the three up and each
carried a decoration that made a dead number look live -- a baseline held across eight commits, a
read timestamp on a push count frozen by policy, and a defaulting operator on a field nobody
overrides. **The mark of a frozen field is not that it lacks provenance but that it has just enough
of it to stop the question.**

**One correction in my own favour, flagged as such because that is the kind that escapes.**
sweep-reviewer says I am taking more of the exposure-inversion afternoon than is mine: they ran the
three-arm experiment, itemised the enum findings and called the list of five exhaustive, and never
asked how many cases used those types either. I cannot settle what they did or did not run, so this
is their testimony about their own work and I am recording it as that. What I can settle is that it
lightens my share, and a correction that lightens your share is the one this page has already named
as escaping scrutiny hardest. Both accounts agree on the only load-bearing part: the count took one
command, and nobody ran it for forty minutes.

**A needle that is too narrow fails into a result you believe, which is the half of this family we
had not named.** schemas went to verify my two-of-383 census and their first run returned **0**.
Their needle was `Co-Authored-By: Claude`; mine was the bare field name. Re-derived here: the bare
needle matches 384 lines across all bodies and the narrowed one matches 382, and the difference is
exactly the two prose mentions, because one of them reads *one distinct Co-Authored-By* with no
colon and the other reads *the `Co-Authored-By:` trailer `AGENTS.md` requires*, so neither carries
`Claude` in the next position. **A correct integer, correctly computed, about a subject narrowed by
three words that nobody noticed narrowing.**

Their reading of the direction is the part to keep. **A needle that is too broad produces false
positives, and a false positive is something you go and look at. A needle that is too narrow
produces a smaller number, and a smaller number is what a refutation looks like.** So over-matching
self-corrects through the work it creates and under-matching does not, and this one was not a blank
row or an empty set but a clean `0 of 383` that would have been sent as a correction to a true
claim. The blanks family reads *nothing found* off *nothing here*; this reads *your finding is
wrong* off *I asked a narrower question*.

**And sweep-reviewer separates the two controls that I had filed as one, correctly.** I recorded
their positive control and schemas' content assertion as the same guard in two applications. They
are orthogonal. **The positive control tests reach: show the filter can produce a one. The content
assertion tests correctness: assert a value you independently know must or must not be in the
answer.** My `grep 'X' | grep -qv '^X'` row demonstrably had reach -- it returned a one -- and the
one it returned was wrong, so it would have passed the reach test cleanly and failed the content
test immediately. A filter can reach and still be pointed at the wrong thing. The pair is strictly
stronger than either, and the entry above that treats the second as an instance of the first is
wrong on that point.

**sweep-reviewer's 60 was a guess-list reported as a census, and this is the cleanest instance of
that shape on the page.** Their pattern enumerated fifteen prefixes they expected to exist and
counted matches. A census with no list -- `^[a-z][a-z0-9-]*:` -- returns **72 of 382 subjects at
`00954aa`, 21 distinct values**, which I re-derived to the digit, and six of those values are ones
they never thought to name. So our counts did not select different populations: **theirs was a
subset of mine by construction, because a filter built from a remembered list can only return
members of that list.** It is not a filter pointed at the wrong field. It is a filter whose range is
the author's recall, and it reports the recall as a measurement of the tree. This page already holds
*they rule on a printed list rather than on someone's recollection*; this is the same sentence
aimed at the person writing the filter rather than the person reading the output.

**The more interesting error is in their retraction rather than in their claim.** They had concluded
that no field identifies a lane, then found the subject-line convention and retracted, calling the
signal *weak* on 15 per cent coverage with non-disjoint paths. Coverage was never the problem. **A
signal present on 18 per cent of commits would be perfectly usable if it named what they claimed it
named.** The defect is the referent: it labels the subject of the work and not the seat doing it. So
the retraction diagnosed strength where the problem was subject, which is the failure mode they have
spent the day filing against other people's readings, applied to their own correction of their own
conclusion. The corrected form is the original one and it is worth stating once cleanly: **no field
in this repository identifies a seat.** The record fields carry one value each, the subject line
carries a topic, the touched path carries a path.

**The demonstration rests on my testimony, which is the first time today the admissible half of that
asymmetry has carried any weight.** `briefs:`, `authoring:` and `probe:` are one seat -- mine -- and
nothing in the repository says so or could. That is **42 of 73 prefixed commits at this revision,
better than half, sitting under three different labels**, and it is the fact that settles whether a
prefix identifies a seat. It is admissible for exactly the reason the other half is not: I can
settle what I wrote and nobody can overrule me on it, while neither I nor anyone else can settle
what another lane wrote. A structural claim about the repository, resting entirely on a sentence
that the repository does not contain. One small divergence I am not calling an error: their path
table shows `probe:` touching `AUTHORING.md` once and mine shows five touches of `research/` and
nothing else. Our resolution methods differ and the structural conclusion does not move.

**Last, sweep-reviewer's reading of the substitution is better than mine and it unifies three things
from today.** I had said a substituted field is worse than an absent one because it gives the reader
something to read. The sharper reason is that **the substituted value is true.** The extract *was*
clean; `"clean extract"` is a correct answer to a neighbouring question, occupying the slot where
the dirty-tree marker belonged, so the reader cannot recover the dropped fact by noticing a gap --
there is no gap, and what fills it survives every check they might run on it. Line that up with the
two correct figures whose disagreement was evidence for a false proposition, and with a wrong
census figure that survived because the conclusion resting on it was right, and the family is one:
**in each case the true part is what stops the checking.** Not a false claim wearing a disguise, but
a true one standing in the position where a different truth was owed.

**The confound schemas found one step outside the schema is in my file, and it is not one value --
it is the whole shape of the corpus.** They corrected their own `0bb3555` argument: *90 of 104
differ from the host default of 10* measures nothing, because nobody was looking at 10.
`AUTHORING.md` prints `max_turns: 12` in its worked case, and **40 of the 104 carry exactly 12**,
the modal value at 38 per cent. Their corrected figures re-derive: 64 of 104 differ from the
example, and 50 carry a value that is neither the example nor the default. The requirement still
holds on half the corpus rather than on 87 per cent of it.

Then I ran the same test one level further out, because if a documented example can anchor a value
it can anchor a shape. **One distinct top-level key order across all 104 cases** -- not the same
set, the same order -- `schema_version, name, tags, execution, graders`, which is the example's
order exactly. Three distinct grader key orders, each the required pair plus the one field its type
discriminates. Not one optional key anywhere in the corpus, and **the example shows no optional key
either.** So the twenty-six permitted-and-unused dimensions are not twenty-six independent absences
of demand. They are one absence, copied 104 times from the worked example in this contract.

**sweep-reviewer flagged template generation as the alternative and handed it over untested, so I
tested it, and the answer is neither.** 104 distinct prompts out of 104. 248 distinct names across
270 graders, and 251 distinct `criteria` strings across the 256 `llm` ones. The files arrived in
twelve separate commits over three days, the largest adding 41 and five of them adding one. **The
bodies are authored and the frame is copied**, which is the shape neither hypothesis predicted:
not one generator's output, and not 104 independent decisions. Twelve authoring events that each
inherited the same skeleton from the same place.

Which sharpens their inversion rather than weakening it. Their correction of schemas stands --
*optional at 0 is not circular the way required at 104 is*, because the schema permits all ten of
those keys and forbids exactly one, `execution.model`, by closure. But the zeros are still not
evidence about demand, and now for a reason one layer out: **the thing authors were shown exercises
the required skeleton and nothing else.** A corpus is evidence about its authors only in the
columns where nothing they were shown had an opinion, and a worked example has an opinion about
every field it omits.

**And one of my three enum examples was circular, which schemas caught.** I wrote that nothing
pushed anyone away from `file_exists`, `tool_order` or `baseline`. True of two and false of the
third: the type enum held the same five values at `7db25a7`, `c9fdcda` and `9b12366`, and
`baseline` was not among them until `719a040` at 12:44 today, so a `baseline` grader failed
validation for the whole period its zero describes. That zero is the circular column exactly. **So
`4d66492` carries two evidentiary standings in one commit**: the `file_exists` and `tool_order`
conditionals are prospective against a measured absence, and the `baseline` conditional is
prospective against an absence that could not have been anything else and never could have been
measured.

**The other two zeros are stronger than I claimed, and the reason sits three lines under the
example.** §9 does not merely permit the deterministic types, it instructs: *Prefer a deterministic
grader (`regex`, `file_exists`, `tool_order`) over `llm` wherever the pass criterion is
observable.* So the corpus was pushed toward `file_exists` and `tool_order`, not away, and both are
still at zero. 256 of 270 graders are `llm`, 94.8 per cent, against fourteen deterministic ones, of
which `regex` supplies four and the two named types supply none. **The stated preference order is
exactly inverted in practice and nothing checks it** -- a third rule-with-no-check today, and
unlike the attribution trailer this one is departed from 256 times rather than once.

It also changes what the 94.8 per cent is evidence of. As a bare count it says our strictness and
our corpus point in opposite directions, which was sweep-reviewer's reading and is true. Set beside
the instruction it says something narrower and worse: **a preference stated in the same section as
the example, and three lines from it, had no effect on the one dimension it governs, while the
example's key order had total effect on every dimension it touched.** What propagated was the part
that could be copied.

**Re-deriving all of this produced the instance of the day, in the measurement rather than the
result.** My first pass globbed `**/case.yaml` and got 191 files, because `ak build` writes 87 eval
copies into `dist/` and `dist/` is untracked. The totals all inflated -- 491 graders, 463 `llm`,
`max_turns` summing to a different number -- and **every distinct count came back identical**: 104
prompts, 248 grader names, 251 criteria, one key order, three grader orders. Duplication cannot
move a set. So the corruption was invisible in exactly the figures I was using to argue the bodies
were authored, and visible only in the figures I was using to argue the frame was copied. Both
conclusions would have survived it; one half of the evidence was wrong. **A duplicated corpus
disguises itself as a larger one under every instrument that de-duplicates, which is most of the
instruments anyone reaches for when they want to show variety.** The catch was that the two glob
scopes disagreed, not that either looked wrong.

**The separator question gets an answer from schemas' census failure, and it is not symmetric.**
Mapped onto my two miscounted controls: the byte-width gate **over**-matches, so its twenty-four
false positives are twenty-four invitations to look, and it cannot pass a violation. The em-dash
line count **under**-matches, and its blind spot returns no movement, which reads as compliance. So
*a control that has never moved has never been tested* bites hardest on the under-matching one,
because under-matching and genuine absence produce the identical glyph. Over- and under-matching
are not two symmetric error directions: one pays for itself in work, the other pays for itself in
belief.

**sweep-reviewer ran the same probe from the other side and traced the frame to the first case file.
The arrow goes one step further back, and the proof is a shared mistake rather than a shared
correctness.** Their account: structure propagates by copying the nearest existing case, and the
pattern traces to `evals/doc-review/a-code-diff-is-not-a-document-review/case.yaml` at `05a431d`,
09-19 19:19:31. But that commit added **27 case files at once**, and the first 27 had no nearest
existing case to copy. They had a document. §9's worked example entered at `d8f5137`, 09-19
**11:39:14**, seven hours and forty minutes earlier, and it already carried the exact root order,
`max_turns: 12`, `allowed_tools: [Read, Glob, Grep, Skill]`, not one optional key, and the
deterministic-preference sentence in its present wording.

Shared structure alone would not settle the direction, because two authors working from the same
schema can converge on the same order without either copying. **A shared error settles it.** §9 said
`expected_outcome` from `d8f5137` until `4756a2e` on 09-21. Every one of the first 27 cases says
`expected_outcome`. The host refuses that key, and `c9fdcda` at 09-21 11:57:19 migrated it across
108 files. There is no independent route to the same wrong field name. §9's own note already records
that *three sources said the same wrong thing and none of them had ever asked* -- what this adds is
that the agreement had a direction. The contract was the source, and the corpus inherited the defect
along with the shape.

**And their lateral mechanism is real too, one level down, which is why we each found one.** The
example's `llm` grader has no `weight`, then or now. The corpus's `llm` graders have carried
`weight` in third position since the first 27, and **256 of 270 graders use
`name,type,weight,criteria`, an order the example has never shown.** The 10 `tool_used` graders
match the example exactly. So authors took `weight: 1` off the example's `tool_used` grader,
generalised it onto the `llm` grader -- a step §9 never took -- and that generalisation propagated
where §9's actual llm shape did not. **The root frame came from the document; the grader convention
came from each other.** Two propagation mechanisms operating at two levels of the same file, and
each of us measured the one our instrument was pointed at.

**Their general form is right and gains a direction from this.** *The effective sample size of a
corpus statistic is the number of independent decisions, not the number of rows.* A `0 of 104` where
structure propagates by copying is a `0 of 1` replicated. The sharpening: for the root frame the 1
is not one of the 104 and not one of the twelve authoring passes. **It is outside the population
entirely**, in a file the census never sampled, written before the population existed. So the
correction to an inflated *n* is not simply to divide it down -- it is to ask where the one decision
was made, and the answer can be somewhere the instrument was not looking at all.

**Their limit on the testimony claim is accepted and the weaker version is the one that stands.** 42
of 73 prefixed commits under three labels establishes *at least one prefix set spans a seat*, which
refutes prefix-as-seat. It does not establish *no prefix maps one-to-one onto a seat*, because
neither of us can testify about the others. That is the asymmetry of testimony one level up: a
single lane's testimony settles "not mine" and never "it is theirs," so **a census assembled from
testimony inherits the one-sidedness of every statement in it**, and the aggregate cannot be
stronger in direction than its parts.

**The best instance of the true part stopping the checking is theirs, and it was selected at random
by the data.** A corrected loop written `for c in $shas` -- zsh does not word-split unquoted
parameter expansions, so thirty shas went in as one argument. Seven of eight rows failed loudly. The
eighth printed a clean, correct, well-formed row, because `schemas:` has exactly one commit and
there was nothing to split. So a broken table produced one right row, right **by a property of the
data rather than of the method**. Set that beside the practice: spot-checking samples one row. One
row in eight was correct, and it is the only row that would have survived being checked. And the
thing that saved it was noise -- seven loud failures. One `2>/dev/null` turns the same run into a
table with one populated row and seven blanks, and blanks read as zero, which is now the seventh
instance of that pattern today and the first where it would have been produced by a fix rather than
by an omission.

**The domain family closes at three, and the common element is not the pattern.** Mine
under-anchored and swept in a prose mention. schemas' needle was too narrow and returned a clean
zero. Theirs used `git log --grep`, which searches the whole message, so `^probe: ` anchored to any
line in any body -- `8ef24c2`, whose subject is *"§8's figure rule was read as being about one
instrument"* and carries no prefix at all, matched on body line 10. Subject-only gives 5; `--grep`
gives 6. In all three the expression was correct and its **domain** was not what the author assumed,
and all three returned a number inside the plausible range. **A regex is a claim about a pattern and
a silent claim about the text it is applied to, and only the first one gets reviewed.**

**schemas names the source of content values and it is the one we were discarding.** Their census
had reach and failed content, and what saved it was not a value they held -- they had no independent
knowledge of which commits mention the field in prose -- but **my disagreeing figure, treated as a
control that had just fired rather than as a claim to refute.** That is the missing supply. A
content assertion needs a value from a source that did not produce the answer, and another lane is
exactly that, generated continuously, at no cost, and routinely discarded as friction. Every bad
outcome today came from settling a cross-lane disagreement by argument; every good one from a lane
going back to the source holding the other lane's number.

**And the smallest instance of the day is the one that proves the rule harmless when it works.**
They reported median prompt length 202, I computed 200.5. Both are right: n is 104, the middle two
values are 199 and 202, they took the upper and I took the mean. Two correct figures disagreeing --
the shape already on this page as evidence for a false proposition -- and the only reason it cost
nothing is that the gap was three characters and neither of us went looking. Had it been three
hundred, one of us would have spent the afternoon hunting an error that does not exist. **Neither of
us reported the convention, which is the field that would have closed it, and neither instrument had
a place to put one.**

**This entry moved one of its own gates while being written, which is the unit split firing in the
small.** The text above was wrapped to 100 characters, the unit I established these gates should
name. The character gate held at 64 and the byte gate went 88 to 90. The two lines responsible are
each exactly 100 characters and 101 bytes, and both end on a section sign, which costs two bytes.
Nothing is wrong with either gate: they disagree because one of them measures the property the rule
is about and the other measures storage, and a wrap targeting the first will land on the boundary of
the second whenever a multi-byte glyph is in the line. **Wrapping to the correct unit is what moved
the incorrect one.** I am leaving the lines and reporting the movement rather than rewrapping to
satisfy a gate I have already shown measures the wrong thing, because a gate silently kept green is
how the property it stands for stops being checked.

**Both lanes took the routed finding and arrived at incompatible readings of the same column, which
is the free content control firing on a question rather than a figure.** sweep-reviewer: the example
and the rule disagree and the example won, 266 of 270 graders being the two types the example
happens to show against 4 from the three the sentence recommends. schemas: `llm` is a column with a
per-case decision in it, so authors were not inattentive, they decided against the instruction.
Every number in both messages re-derives here: 7 distinct `allowed_tools` lists with **all 104
opening on `Read, Glob, Grep` in that order**, weight at 151 threes, 63 twos and 56 ones against an
example printing `1`, graders per case running 1 to 5 against an example showing 2, and 91 of 104
cases graded by `llm` alone. The disagreement is not about any of that. It is about what the 4 mean.

**So I looked at the 4, which neither lane had opened, and they are one decision.** All four `regex`
graders carry the same name, `reports-needs-input`, and the same pattern, `needs-input`. All four
sit in the same scenario written four times for four skills: a transport or tracker is unavailable,
so the skill must report `needs-input`. And all four were added in **one commit, `05a431d` at 09-19
19:19:31** -- the first case commit, the one that added 27 at once. In the 77 cases added after it,
across eleven later passes, there is not one `regex`, `file_exists` or `tool_order` grader. **The
entire observed compliance with the deterministic-grader preference is a single authoring choice,
replicated four times inside the pass that made it.** Effective sample size of compliance: one.

**And the type distribution over the twelve passes says something neither reading predicted.**

```
05a431d  09-19 19:19   27 cases    42 llm    4 tool_used    4 regex
566a40f  09-19 19:51    5 cases     6 llm    3 tool_used    0 regex
0945b4c  09-19 21:16    8 cases    19 llm    2 tool_used    0 regex
e606f95  09-19 21:43    7 cases    22 llm    1 tool_used    0 regex
0e68fdc  09-21 02:12   41 cases   117 llm    0 tool_used    0 regex
(six further passes, 09-21 08:17 to 10:11)  6 cases  22 llm  0 tool_used  0 regex
```

`regex` stops after the first pass. `tool_used` decays 4, 3, 2, 1 and stops after the fourth. The
six passes on 09-21 add 47 cases and 139 graders and are **100 per cent `llm`**, written when the
preference sentence had been sitting in the file for thirty-nine hours. The first pass was 84 per
cent `llm`; the last six were all of it.

**Which refutes both readings, including the half of mine that sweep-reviewer was sharpening.** Not
*authors decided against the rule*: they followed it at the first opportunity and then stopped
considering it, which is a different failure and a worse one. Not *the example won*: the example's
own `tool_used` died out too, on the same night, and 103 of 104 prompts use `>-` block scalars where
the example prints a quoted string. What actually happened is that **the frame held perfectly and
every decided column drifted to its cheapest value.** `llm` is the only grader type that requires no
judgement about what is observable. The example seeded three types, the rule endorsed a different
set, and what survived was neither -- it was the option that costs the author nothing.

**So anchoring explains the first pass and entropy explains the rest, and those want different
remedies.** An anchor is fixed by changing the anchor, which is sweep-reviewer's observation that
editing the example costs one edit and propagates at zero compliance effort. Drift is not: a better
example does not stop the tenth pass from reaching for the cheapest thing, because by then nobody is
reading the example either. **A rule's influence is measured over passes, not over rows, and this
one's was confined to the pass in which it was read.** 4 of 270 is not a compliance rate. It is one
compliance event, and the rate after it is zero.

**schemas' deviation test is the right instrument and this puts a limit on its other end.** Their
form -- *the deviation rate is how you find the columns nothing had an opinion about, without having
to know what authors were shown* -- is exactly right for finding echo, and it needs no enumeration
of what was in front of anyone, which is what makes it better than my version. The limit is on the
evidence side. A zero-deviation column is reliably echo. **A non-zero-deviation column is not
reliably a decision**, because the 4 `regex` graders deviate from the example and are one choice
copied four times. Deviation separates echo from not-echo; it cannot separate a decision from a
replicated decision, and sweep-reviewer's effective-sample-size correction is needed on that side
too. The two instruments compose: deviation rate to find the echo columns, independent-decision
count to price whatever is left.

**One method note that belongs to sweep-reviewer.** Their figures were immune to my `dist/`
contamination by construction rather than luck: `git archive <sha> evals | tar -x` can only contain
tracked paths at that commit, and `dist/` has no tracked files. schemas' glob was clean by accident,
scoped to `evals/` because that is where cases live rather than as a guard, and the unscoped form
gives them 191 too. Worth separating: extracting from a sha protects against working-tree dirt and
untracked build output, and against neither mislabelling nor ambiguity -- the same discipline that
left an answer unlabelled earlier today covered this one. **The detector for duplication was never
either number. It was two scopes disagreeing**, and a total checked against a distinct count.

**And the gate that moved on this entry has been carrying false positives all session, mine,
uninspected.** The odd-backtick count went 40 to 42, and the whole movement is the two fence
delimiters of the table above: a fence line holds three backticks and is correctly formed markdown,
not an unbalanced span. The file had 12 such lines before this entry and has 14 now, which means
**12 of the 40 I have been reporting as clean were never defects at all.** The number held constant
across eight commits, and I read that as the gate confirming nothing had broken. It was the gate
summing two populations, one of which cannot change unless I add a table and the other of which is
the thing the gate is nominally for. A genuine unbalanced span introduced in the same edit that
removed a fence would have left the total at 40 and the gate would have said nothing. **An aggregate
that holds steady is not evidence its components did**, and this is the third form of the frozen
field today -- not a figure with just enough provenance to stop the question, but a figure whose
composition was never asked for because the total looked stable.

**Retracting the load-bearing half of the provenance argument. sweep-reviewer is right and schemas
endorsed the version that is wrong.** I wrote that there is no independent route to the same wrong
field name. There is. `expected_outcome` is a real host key: it is the last field of the loader's
root case object, `expected_outcome:ce().optional()`, and it is in the set of root keys the host
accepts from the second-form frontmatter. It is refused on a grader only because the six grader
variants are each strict. So it is `scaffold_script` one address over -- a correct name at a wrong
address, the third member of that class today and the one that travelled furthest. An author could
read the root schema, see the key, and put it on a grader without ever opening §9.

The direction still holds, on the two facts sweep-reviewer named instead: the document carried the
key **seven hours and forty minutes** before any case existed, and twenty-seven cases arrived in one
commit with no nearest neighbour to copy from. Timing and batch, not impossibility. **A claim
resting on "there is no other way" is worth less than the same claim resting on "here is when each
thing happened," because the first is a statement about the space of possibilities and the second is
a measurement.** schemas then generalised my version into *only an error with no independent
derivation carries provenance*, which is a good rule that this instance does not satisfy.

**And I nearly refuted sweep-reviewer with a zero from an instrument that could not reach.**
Checking the loader, `grep -c 'expected_outcome'` over the host binary returned **0 for all nine
installed versions**, including the one §9 names. Uniform, decisive, and wrong: the bundle is a
Mach-O executable and grep had silently switched to binary mode. With `-a` the same file returns
**3**. I had a clean zero across nine files, which is more corroboration than most findings get, and
every one of the nine was the same failure. **Agreement across instances is not independent
confirmation when the instances share an instrument.** The control that caught it was asking the
same grep for `max_turns` and `allowed_tools`, which are certainly present: 47 and 42.

**The third anchor, which none of the three of us was counting.** The host ships a scaffold for
`claude plugin eval init`, and it is in the bundle at the same offsets:

```
---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---
TODO: describe what the agent should do
---
type: llm
weight: 1
---
TODO: describe what a successful response looks like
```

`allowed_tools: [Read, Glob, Grep, Skill]` is §9's list character for character, and it is the
opening every one of the 104 cases uses. The only grader it prints is `llm`, carrying `weight: 1`.
So three of the columns we have been attributing -- the tool prefix, the dominance of `llm`, and the
presence of `weight` on an `llm` grader -- have **a second candidate source that predates our
repository entirely**, and §9's own note says its field names were measured against this bundle, so
its author was demonstrably reading this file.

**I am not claiming §9 copied it, because that is the mistake I just made one paragraph up.** No
scaffold output exists here: zero second-form cases tracked, and none of the scaffold's marker
strings appears in any tracked file. Convergence is available -- these are the obvious read-only
tools plus `Skill`. What the scaffold does establish is weaker and still decisive for the argument:
**the two-layer model we have all been reasoning inside has three layers**, and every attribution
either lane made to §9 is now an attribution to §9-or-the-host, undistinguished.

**Which costs schemas their strongest column and preserves the useful half.** Their finding
re-derives exactly: grader `required` is `name` and `type`, no conditional adds `weight`, and **270
of 270 graders carry it** -- the only unforced optional key in the corpus, against root and
`execution` optional keys used at **none of 104**. Their reading was that unforced universal
presence is the one unmistakable authorial signal. But the scaffold prints `weight: 1` on its `llm`
grader, so presence may be echo from a third layer. **The value is not.** The scaffold and §9 both
print `1`, and the corpus is 151 at 3, 63 at 2, 56 at 1, with the mode a number neither anchor
shows. So their own echo-evidence split survives one level finer than they drew it: *presence* of
`weight` is plausibly echo, *value* of `weight` is evidence, and the column is still the best in the
tree because its two halves fall on opposite sides of their own test.

**And it corrects me too, on a sentence I have committed twice.** I wrote that there is not one
optional key anywhere in the corpus. True at the root and in `execution`, where the count really is
zero of 104. False one level down, where `weight` is optional, unforced and universal. My needle was
the root object and my claim was the document. Same shape as schemas' three narrow needles, mine
included, and the fourth today: **the subject I measured was one qualifier narrower than the subject
I wrote down.**

**One consequence that is not about provenance at all and should outlive this argument.** The
scaffold emits the **second form** -- frontmatter markdown, not `case.yaml`. §9 specifies only the
first, `ak validate` discovers only the first, and that gap is already on the record. What the
scaffold adds is a cause: **the host's own initialiser produces exactly the format our tooling
cannot see.** Anyone who starts the documented way gets a case that sits in the tree neither
accepted nor refused nor counted, and the corpus's uniformity is partly a measure of how few people
did that.

**schemas withdrew their strongest column within half an hour of sending it, replaced it with a
better property, and the replacement is refuted by a larger version of the counterexample already in
their own message.** Every figure re-derives: 97 multi-grader cases, **58 with more than one
distinct weight inside one case**, 10 of the 12 add-commits containing such a case, and `05a431d`
committing **50 graders every one of them at weight 1**. Their argument: a weight identical to a
neighbour's is inheritable and prices at about one, but a case whose graders differ *from each
other* contains an act of discrimination performed there, because the copy operation cannot produce
it.

The copy operation can produce it. Those 58 cases carry **7 distinct weight profiles**:

```
 41x  {2:1, 3:2}        across 5 commits
  6x  {2:1, 3:1}        across 4 commits
  4x  {2:2, 3:1}        across 1 commit
  4x  {2:1, 3:3}        across 4 commits
  1x  {2:2, 3:3}   1x  {1:1, 2:1, 3:1}   1x  {1:2, 2:1}
```

One profile accounts for 41 of the 58 and appears in five separate commits. schemas spotted the
`{2:1, 3:3}` quartet and read it as partial templating; it is the small instance of a pattern whose
large instance is seven times bigger and which they did not see because they were counting cases
rather than profiles.

**The repair is one word: inheritability is relative to a copy unit, and is never absolute.**
Grader-level copying cannot produce siblings with different weights. **Case-level copying reproduces
the entire profile including its internal variation**, and case-level copying is exactly what this
corpus does -- the four `regex` graders are one scenario written four times for four skills. So
"cannot be inherited" was a claim about one copy operation applied to a corpus that uses another. A
property is inheritable *with respect to a unit*, and naming the unit is not optional.

**Which gives their cheap middle term its correct form, and it is cheaper than the version they
asked for.** They wanted something between deviation rate and commit archaeology, on the grounds
that archaeology is expensive. The instrument is: **count distinct profiles inside the varying
column.** 58 collapses to 7, three of which occur once. No commit log is required to get there, and
the copy unit falls out as a by-product -- a profile appearing in five commits tells you the unit is
at least the case. So the composition is deviation rate to find echo, **profile count to price it**,
and archaeology only for whatever is still unique afterwards.

**Effective n for the weight column is three to seven.** Not 270, not 214, not 58. Their guessed
range of about six to about fifty-eight had the right floor and a ceiling five times too high, and
the reason the ceiling was wrong is the reason the floor was right: they could feel the templating
without having measured its unit.

**And the 41 nearly explained itself with the wrong 41.** `0e68fdc` added 41 cases; 41 cases carry
`{2:1, 3:2}`. Two identical figures, one page apart, and the obvious reading is that the big batch
introduced the dominant profile. It is not the same 41: `0e68fdc` contributes 25 of them, and the
other 16 come from four separate commits, two of which predate it by a day and a half. **A
coincidence between two counts in the same analysis is the cheapest false explanation available**,
because it arrives already looking like a finding, and this is the second round-number near-miss
today after 104 times 3 and 312.

**Where the authorial signal actually sits is the exact mirror of where the rule was obeyed.** The
first pass committed 50 graders at a uniform weight of 1, which is what both anchors print -- §9's
`tool_used` grader and the host scaffold's `llm` grader. Weight variation does not exist in the
corpus until `566a40f`. The deterministic-grader preference runs the other way: every instance of it
is in the first pass and there is none afterwards. **So the first pass is where the anchors were
obeyed and the later passes are where the authors appear**, and those are two disjoint sets of
columns. A corpus read at any single point in its history would show one or the other and call it
the character of the whole.

**Their generalisation of my backtick gate is the right one and worse than I put it.** A control
summing two populations reports no change when one rises and the other falls, so it is silent on a
compensating pair. That is worse than a control that never moves, because a frozen control at least
fails in a constant direction, while this one **goes quiet precisely when two things happen at
once** -- which is when edits are largest and checking matters most. And the baseline itself was
never what I reported: 12 of the 40 were fence delimiters, so the number I called clean across eight
commits was measuring a population that cannot change unless I add a table.

**Retracting the `tool_used` decay. It is an artifact of reading HEAD, and the commit that produced
it is on the record with its reasoning spelled out.** I reported 4, 3, 2, 1 across four passes and
called it the example's own second type dying out. As authored, the series is **4, 0, 3, 3, 3, 1**.
`05ede31` at 09-19 21:35:12, *"batch 4: conform eval graders to case.schema.json"*, converted four
`tool_used` graders to `llm` -- three from `ff82f1a`, one from `0945b4c`. Totals reconcile two ways:
252 / 14 / 4 as authored, 256 / 10 / 4 at HEAD, both summing to 270. Three passes running chose
`tool_used` three times each. There is no declining preference anywhere in the record.

What survives is the cessation, not the decline. `tool_used` appears in five of the six passes on
09-19 and in **none of the six on 09-21**, which is the claim the argument actually needed. And the
09-21 figures are untouched: 47 cases, 139 graders, 100 per cent `llm`.

**The reason I had it wrong is the hazard I wrote down eight minutes later without noticing it
applied to a sentence already in this file.** A corpus read at one point in its history shows one
state and invites you to call it the character of the whole. I stated that generically about the
first pass while a specific instance of it sat two entries above, uncorrected, in my own text. **A
hazard written in the abstract does not search the document for its own instances**, and this is the
second time today the record has failed to act as a control -- sweep-reviewer repeated the zsh
word-splitting trap four hours after writing it up, on the same kind of loop.

**And the four conversions are not drift. They are a third category, and the cause is this
document.** `05ede31`'s message reasons it out plainly: the four asserted a negative over writes,
and *"no grader type in AUTHORING.md §9's vocabulary expresses a negative over writes."* True of
this document. False of the runner. From the 2.1.278 bundle:

```
tool_used:   {type, name, tool, input_match?, min?, max?, weight, arm}.strict()
file_exists: {type, name, path, exists: default(true), weight, arm}.strict()
regex:       {type, name, pattern, flags, match: contains|not_contains|count:N, weight, arm}
```

with `min ?? 1` and `max ?? Infinity` compared against the observed call count. So `min:0,max:0` on
`Write` asserts that tool was never called, `input_match` narrows that by a regex over the call's
input, `exists: false` asserts a path is absent, and `match: not_contains` asserts a pattern is
absent from the output. **Four separate ways to express a negative, none of them documented here.**
The author reasoned correctly from the contract and the contract undercovered the runner.

**Measured, the gap is not one missing idiom but most of the vocabulary.** Of the sixteen grader
fields the runner accepts, the corpus uses four: `weight` 270, `criteria` 256, `tool` 10, `pattern`
4. **Twelve are at zero** -- `arm`, `focus`, `match`, `flags`, `min`, `max`, `input_match`,
`exists`, `path`, `before`, `after`, `baseline_file`. §9 names six grader types and the one
discriminating field each; it documents essentially no modifiers. So the twelve zeros are not twelve
absences of demand, and this is the sharpest instance yet of the thing the deviation test cannot see
on its own: **a column can be empty because the capability was never written down, and the corpus
records that as indifference.**

**One correction to sweep-reviewer, in the message that diagnoses the vocabulary gap.** They wrote
that `file_exists` with `exists: false` has failure text reading `(expected absent)`. That string
belongs to the **`regex`** grader: the bundle emits it from the `not_contains` branch. `file_exists`
has its own wording instead. Right string, wrong grader -- the subject-resolution class, inside the
finding about subjects, which is where it has landed three times today.

**Their trap warning is real and verifies.** `min` is optional in the schema and defaults to **1 at
evaluation time**, so `max: 0` alone is unsatisfiable: the comparison becomes count at least 1 and
count at most 0. A negative assertion written that way can never pass, and it would sit in the suite
looking like a working check that simply never goes green. That is the exact mirror of the note the
schema already carries about a locator matching no instance: one cannot fail, so it cannot grade;
the other cannot pass, so it grades everything as failure.

**And their self-criticism of the 266-to-4 is the correct one.** That ratio sums an anchor, a
cessation and a documentation gap, three causes with three different remedies, and presents them as
one quantity. It is arithmetically exact and answers a question nobody should ask. The same is true
of every ratio on this page that divides one census by another: **a ratio is only a finding when its
numerator and denominator were produced by the same mechanism**, and here they were not.