# agent-kit — maintainer guide

This repository is a **catalog of engineering instructions**, not an application. It amalgamates nine
donors — eight MIT, one Apache-2.0 (claude-mem, which feeds only the opt-in learning runtime) —
into *one* lifecycle rather than shipping four plugins that fight over activation descriptions.
Read this file before changing anything under `skills/`, `packs/`, `protocols/`, `roles/` or
`references/`.

Governing design: `research/sources/engineering-skills-repo-plan.md` (cited as `arch §N`).
Design brief: `research/sources/grok-transcript.md` (cited as `G:Lx–Ly`).
**Precedence: arch doc > later transcript turns > earlier transcript turns.**
Donor behavior is whatever the pinned commit in `provenance/upstream.lock.yaml` actually contains —
never what either document claims about it, and never memory.

---

## The invocation law

Non-negotiable. The source rule is quoted here; ADR-0007 amends its start condition for autopilot
alone. `ak validate` checks the invocation graph and the first-step authority gate.

> - **User-invoked:** align, bound, wayfind, ship, compound. Only a human starts these.
> - **Model-invoked:** scout, tdd, diagnose, standards-review, spec-review, prototype, attach-pack.
> - A user-invoked skill may call model-invoked skills.
> - A user-invoked skill may **not** call another user-invoked skill. […]
> - Domain packs auto-attach by artifact type. They never start a phase.

**How "only a human starts these" is held** changed in `docs/decisions/0003-model-invocation.md`. The packager no
longer emits `disable-model-invocation`, so the model can load any skill. A U skill keeps its class:
its description carries the non-trigger clause, its first workflow step is the authority check, and
started without an explicit request or a validated grant it stops and says so.

**Standing-start amendment (ADR-0007):** Firstmate may start `autopilot` for a crewmate only after
the runner validates a standing grant for autopilot.start against a captain-approved immutable
charter. The worker's brief, a prompt naming autopilot, and a phase grant do not start it. Every
other U public entrypoint remains human-started by its slash command, save under the bypass grant
below. Sensitive grants, merge,
deploy and anything outside the charter remain human decisions.

**A second standing exception to "only a human starts these"** is the bypass grant
(`docs/decisions/0008-bypass-start-grant.md`, `policies/invocation.yaml` `bypass`). A supervisor
writes it from outside the repository for one task, and it stands in for the typed command of
super-align, super-bound, super-review `full` and `readiness`, and super-ship. It starts phases
only: every approval inside them still goes to the supervisor, and merge and deploy are never on it.

Source: `G:L1672–1676`. The elision in the fourth bullet drops a model-routing illustration that the
content denylist forbids in this file; the unedited text is at
`research/sources/grok-transcript.md:1675`. The quote is reproduced exactly; ADR-0007 records the
later explicit captain decision that narrows its first bullet for `autopilot`.

**The quote uses the design brief's vocabulary, not this package's.** It names capabilities, and this
package reclassified several of them: two became protocols and two became roles, none of which are
skills. `catalog.yaml` is authoritative for what each id *is*; take a section from it, never from the
law above. No id is both a skill and a protocol, so this is reclassification, not a contradiction.

| In the quote | Here | Lives at |
|---|---|---|
| align, bound, ship, scout | `super-align`, `super-bound`, `super-ship`, `super-scout` | `skills/super-*/` |
| wayfind, compound, diagnose, prototype | unchanged | `skills/<id>/` |
| tdd, attach-pack | protocols, not skills | `protocols/<id>/PROTOCOL.md` |
| standards-review, spec-review | `reviewer-standards`, `reviewer-spec` — roles, not skills | `roles/<id>/ROLE.md` |

The amended law still binds each of them. A protocol or a role is not an entrypoint at all, which is a
stricter position than the quote's model-invoked class, not a loophole in it.

### How the law is satisfied where skills legitimately need each other

`super-ship` needs `compound`; `autopilot` needs gated phases. Both are U skills calling U
skills, which the law forbids. The resolution (ruling `entrypoint-phase-operation-split`) is
**not** an exception — it is a split:

| Layer | Who may start it | Example |
|---|---|---|
| Public entrypoint | A human by slash command; autopilot also Firstmate under a runner-validated standing grant | `/ak:super-review` |
| Phase operation | A delegated controller, **only** under a runner-validated grant | `review.delta` |

A human invokes a public entrypoint, or Firstmate starts autopilot under the standing-start amendment.
A controller invokes a phase operation only when the runner validates a grant that covers it.
**Ordinary workers cannot manufacture a grant or start a new gated
phase**, and public wrappers and the supervisor pair run the same protocol, so there is no second
pipeline. Where a host cannot validate a grant, the skill **stops for explicit invocation** rather
than reproducing a forbidden command's effect through a side door (ruling
`entrypoint-phase-operation-split`).

`authority` values live in `schemas/common.schema.json#/$defs/authority`:
`explicit`, `explicit-or-standing`, `explicit-or-delegated`, `delegated-grant`, `active-review-run`, `model`.

---

## Model routing is stripped, and the stripping is enforced

No model selection, pricing, provider config, effort ladder, escalation tier or routing dependency
appears anywhere in this catalog. A large fraction of the design brief is model routing; each concept
was replaced with a role- or evidence-based equivalent:

| Design-brief concept | What this repo does instead |
|---|---|
| Tier choice / confidence scoring before a spawn | Deterministic policy checks against artifact evidence |
| Named-model implementer seating | An `implementer` role; the runner binds who fills it |
| "Cross-family on purpose" supervisor pairing | Two `supervisor` seats declared **independent**; independence is a runner-enforced constraint |
| "Fail closed on low confidence" | "Fail closed when required evidence is absent" (ruling `required-lane-failure-is-unavailable`) |
| "Do not put <model> on security" | The security seat may not be filled by the implementer of the change under review nor by whoever approved its spec (ruling `missing-supervisor-never-implementer`) |
| In-skill cost/token caps | Budgets passed in by the runner; the repo enforces only the cap it was handed |

What the right-hand column cannot carry, because it is a translation table and not the rule: a seat
that cannot be filled independently is **unavailable**, and unavailability blocks the checkpoint. It
is never backfilled — not by the implementer, not by the author, not by the spec approver, and not by
a seat already sitting on the panel (ruling `missing-supervisor-never-implementer`).

Worker-attested evidence never lifts an autonomy ceiling. The evidence-consuming autonomous form
requires `trusted-evidence`, supplied fail-closed by the runner contract; host permissions are not
evidence provenance and never imply that capability.

`ak validate` fails on any denylist hit outside `provenance/` and `research/sources/`, which quote the
sources verbatim by design. License texts that ship into `dist/` from `provenance/licenses/` are still
scanned, because nothing packaged into `dist/` is exempt. The non-routing concepts arch § tells us to keep — per-finding solution
specificity, difficulty, evidence classification, independent roles, iteration limits — all survive,
expressed without any classifier.

---

## Repository layout

`AUTHORING.md` §8 governs the prose in this file, including this table. Precedence decides which
document is right where two disagree; it does not exempt the superior one from the writing standard,
and a false claim about the tooling is worse here than anywhere else because readers treat this file
as authoritative. Every row below is a claim about the tree, checkable against it.

| Path | Contents | Committed? |
|---|---|---|
| `catalog.yaml` | Single source of truth. Every skill, pack, protocol, role, reference | yes |
| `catalog.d/*.yaml` | Fragments that add entries to `catalog.yaml` and never override one; the loader merges them (`docs/decisions/0010-catalog-fragments.md`). Upstream carries none: it is a downstream fork's surface for its own entries | yes |
| `skills/<id>/SKILL.md` | Canonical skill bodies. Agent Skills spec frontmatter only | yes |
| `packs/`, `protocols/`, `roles/`, `references/` | Attachable constraints, shared phase logic, role prompts, reference packs | yes |
| `schemas/` | JSON Schemas; `common` holds the shared `$defs` | yes |
| `policies/`, `profiles/` | Machine-readable rulings and install profiles. Profiles never name models | yes |
| `adapters/` | Host and evidence-source contracts: claude-code, codex, runner, knowledgebase, firstmate, tracker, review-source, observation-source | yes |
| `provenance/` | `upstream.lock.yaml`, `adaptations.yaml`, `conversation-map.yaml`, licenses | yes |
| `research/` | Design sources and the donor dossiers. **Denylist-exempt** | yes |
| `src/`, `tests/` | The `ak` CLI and its tests | yes |
| `dist/` | Generated by `ak build`. Never hand-edited; absent from source branches, published by CI on `published` | **no on `main`** |
| `.donors/` | Full donor clones, reproducible from `upstream.lock.yaml` | **no** |
| `.work/` | Scratch | **no** |
| `ak.install.yaml` | Per-install adapter attachment | **no** |

---

## Authoring rules

The full contract is `AUTHORING.md`. The parts that get violated most:

1. **Canonical `SKILL.md` frontmatter carries only Agent Skills spec keys** — `name`, `description`,
   optionally `license` and `metadata`. `name` must equal the directory name.
   Host keys (`argument-hint`, `allowed-tools`) are **generated** by the packager from `skill.yaml`.
   Hand-writing them, or `disable-model-invocation`, into a canonical file is a validation failure.
   No bundle carries `disable-model-invocation`: every skill is loadable by the model, and a U
   skill's gate is its own authority step (`docs/decisions/0003-model-invocation.md`).
2. **≤150 lines, hard cap 300.** Longer material goes behind `references/`. Progressive disclosure is
   the mechanism — not a full-body shim that depends on another plugin's hooks.
3. **Every adapted file needs a provenance row** in `provenance/adaptations.yaml`:
   `donor@commit:path`, whose path must exist at the pin, or the anchored-local form in
   `AUTHORING.md` §5. A capability with no upstream source is
   `origin: conversation` with a `G:L` locator — never a fabricated source path.
4. **Cite the ruling.** Wherever a skill touches a resolved conflict, it references the row in
   `policies/resolved-conflicts.yaml`. Improvisation at those exact points is what the rulings exist
   to prevent.
5. **No placeholders.** `TODO`, `TBD`, `lorem`, `placeholder` fail validation.

## Things that are deliberately absent

Arch §2.6. These are selections, not gaps — re-adding one is a design change, not a fix:

- No second `/lfg` or "run everything" entrypoint beside `autopilot`
- No `/teach`; no visual-review HTML
- No duplicate donor brainstorm / plan / work / review / TDD / worktree commands
- The 17 CE personas are pass-1 machinery, not individually invocable skills
- CE Proof is an optional *publishing adapter*, not an engineering skill
- Model routers and model price/effort tables are entirely out of scope

## Numeric heuristics are guidance, not gates

The ~100-line PR target and the 80/15/5 test pyramid are configurable starting points, established
per project and carried in the project record. **Neither is validated or enforced here, and neither
is grounds for a finding on its own** — that clause is the whole point, and it is the one a reader
supplies wrongly if it is left out. Real constraints are set per project, and exceptions are
**recorded** rather than forcing artificial file splits or meaningless tests (ruling
`numeric-heuristics-are-guidance`).

## Before you commit

```bash
bun test                 # validator, selector and packager units, incl. invalid-case fixtures
bun run ak validate      # catalog complete, schemas valid, links closed, no denylist hits
bun run ak build         # the packager runs on this tree and writes dist/ for every host
bun run lint             # oxlint through the ratchet: no violation beyond tools/oxlint/baseline.json
bun run lint:growth      # the baseline records nothing beyond its copy at the merge base with origin/main
bun run fmt:check        # oxfmt: code and JSON formatted; `bun run fmt` fixes it
```

**The third line is `ak build`, not `ak build --check`, and restoring `--check` here would undo a
repair.** `dist/` is generated and never committed on `main` — the table above says so — which means it does
not exist in a fresh clone. `--check` there reports `packaging.dist-missing` errors describing
the absence of a local build rather than anything about the commit. Run `ak build` first and
`--check` passes because you just built. Green for whoever has built, red for whoever has not, and
neither answer is about the repository: it is an instrument that returns the same reading under both
hypotheses, in the one position where the reader most needs it to discriminate.

`ak build` is the check this position wants. It validates first and refuses to write `dist/` while
errors stand, then runs the packager — which is where relative references are resolved a second time
after transitive dependencies are copied into `references/shared/`, a property of the source tree
that nothing else in this block reaches. `--check` has a real job in the release sequence, where
`dist/` has just been built on purpose and the question is whether it matches; that is where it
belongs.

These lines are a gate, not a report. The condition is that `ak build` exits 0 on a clean
`git archive` extract of the commit with `.donors/` copied in, writing `dist/claude-code` and
`dist/codex`; how many errors some tree reports today is a figure about that tree and not evidence
about the gate, so no count is kept here. `tools/hooks/pre-push` runs the same build against the
exact commit being published, so a red build is refused at the wire rather than caught in review.

## Lint and format

After editing code, run `bun run fmt`, then `bun run lint`. The lint output is one line per
violation with its rule, followed by the rule's fix instruction when it has one. `bun run lint`
needs Node 22.18 or later on the `PATH`: oxlint loads the vendored plugin's TypeScript through
Node's type stripping.

Fix the code. Don't add a cast, a `!`, or a disable comment just to quiet a rule; those are what
the rules exist to catch.

A rule `.oxlintrc.json` leaves on is an error. The violations that predate a rule are recorded per
file and rule in `tools/oxlint/baseline.json`, and that file only shrinks. A count above the
baseline fails. A count below it also fails until you record it with `bun run lint:baseline`,
because a slot left unrecorded would be spent by the next change. Growth is refused unless
`--allow-growth` is passed, and the baseline diff is what the reviewer reads. The flag has two
uses. Adopting a new rule: the diff adds that rule's counts and nothing else. Moving or renaming a
file that has recorded violations: the baseline is keyed by path, so the new path reads as growth
even though nothing grew, and `bun run lint:baseline -- --allow-growth` is how the entries follow
the file. The reviewer checks that the counts moved with the file, with the old path removed and
the new path added carrying the same counts, rather than any count rising. The ratchet counts per
file and rule, so fixing one violation while adding another of the same rule in the same file
leaves the count unchanged and passes.

`bun run lint:growth` holds the "only shrinks" half that the ratchet cannot see: the ratchet
compares the tree with whatever baseline it finds, so a hand-edited or `--allow-growth` baseline
passes it. `tools/oxlint/growth.ts` compares the baseline with its copy at the merge base with
`origin/main`, and CI and the gate both run it. A renamed file may carry its old path's counts,
and no more. "Renamed" is what `git diff -M` pairs between the merge base and the tree, which takes
at least 50% similar content. A file rewritten past that in the same branch reads as new, so land
the move on main before the rewrite. Any other growth passes only when `.oxlintrc.json` changed in
the same branch, because that is a rule being adopted; the growth is printed either way.

oxfmt owns whitespace, so anti-slop's `require-readable-spacing` is off. Markdown, YAML,
fixtures, donor material, recorded eval evidence and the eval inputs that receipts pin by sha256
(`tests/learn/evals/**/*.json`) are never formatted (`.oxfmtrc.json`
`ignorePatterns`). `tools/oxlint/anti-slop/` is vendored upstream code: update it from upstream
as its `UPSTREAM.md` describes, and never edit it in place.

## Token budget

`tests/token-budget.test.ts` pins the size of every fixed text agent-kit hands an agent, in bytes
and in chars/4 estimated tokens: this file, every file the bundle ships under `skills/` and
`references/`, role prompts, the learning hook's session-start block, the judge prompts and the
Firstmate brief texts. `tools/budget/surfaces.ts` lists them, and new agent-facing text belongs
there. Any change in size fails `bun test`, naming the file and the delta. `bun run
budget:baseline` lowers a pin after a shrink. Growth also needs `-- --allow-growth`, and the
`tools/budget/baseline.json` diff is where review sees it.

## Receipts name their instrument

A receipt that reports a check without naming what it ran the check *with* is not reproducible.
Measured on `origin/main` at `4e45481`: of the 9 commits whose message carries an `ak validate:`
figure, 7 say nothing about the tree that figure came from, `ae061b2` names the donor half only,
and `8798873` names its instrument outright — so the practice below is the exception becoming the
rule, not a new obligation. The first three lines above behave differently depending on how the
tree was obtained, which is why the instrument is part of the result:

| Instrument | What it reports |
|---|---|
| The working tree | every check, against contents nobody else can reconstruct |
| `git archive <sha>` extracted bare | the right contents, but `1 check skipped: donor paths at pin` — provenance rows go unverified |
| That extract with `.donors/` **copied** in | the right contents *and* every check |

Only the third is a receipt, and **`research/probes/validate-figure.sh` is that instrument** — run
it rather than rebuilding it by hand. It extracts the revision, copies `.donors/` in, runs the
validator there and prints the figure with the provenance that makes it re-derivable.

Copy `.donors/`, never symlink it. A symlink measures the same thing and reports the same numbers,
and is still wrong for a quoted figure: the link points out of the extract, so the figure stops
being reproducible the moment anyone touches that path in the working tree. The script's two other
choices are load-bearing for the same reason and are easy to lose when rebuilding it by hand — it
symlinks `node_modules/` so the figure pins the revision's *source* rather than its dependency
tree, and it resolves its workspace with `cd "$(mktemp -d)" && pwd -P`, because on macOS a bare
`mktemp -d` returns a `/var` path whose second name silently empties the checked-file population in
`tests/typecheck.test.ts`. Both failures report as content findings rather than as broken
instruments.

So a receipt states the sha it measured and that `.donors/` was present. When comparing two runs,
note that the skipped check prints as a `provenance.donors-unavailable` NOTE *and* is counted in
the summary total, so a bare run reporting `40 notes, 1 skipped` and a copied run reporting
`39 notes, 0 skipped` are the same tree measured twice — the difference is the instrument, not a
change. Clone donors **without** `--depth`: a shallow clone is the common default and resolves
donor paths for the tip while failing at the pin, which the validator reports as missing paths
rather than as a broken instrument.

`bunfig.toml` makes `tests/` the canonical test root: `bun test` runs every test there and excludes the `evals/super-build/_fixtures/**/*.test.js` scaffolds (the eval runner exercises them) and the `dist/` copies, so its population does not depend on whether the tree has been built.
Its `[test] preload`, `tests/preload.ts`, keeps the operator's learn settings and config roots out of the test process; what it cannot reach, and the convention that covers it, is in its header.

The install configuration is part of the instrument too: a skill's packaged mode depends on which
adapters `ak.install.yaml` attaches and on whether it configures a tracker backend, so the summary
line of `ak validate` and `ak build` ends with an `install:` clause naming the file or the default and
the tracker's state, and a quoted figure keeps it. The pre-push gate and
`validate-figure.sh` measure the default install, with no such file in the extract (ruling
`fail-closed-adapter-lifts-ceiling`).

Commit messages end with the session's configured `Co-Authored-By:` attribution trailer. The
assistant identity in that trailer is supplied by the harness at commit time; it is deliberately
not written here, because every tracked file in this repo outside `provenance/` and
`research/sources/` must survive the model-name denylist.

## Shipping

All changes ship through the no-mistakes gate:

- Commit on a feature branch, then push with `git push no-mistakes <branch>`. Never push directly to `origin`.
- no-mistakes runs review, test, lint and document checks, then pushes to origin and opens the PR. Follow progress with `no-mistakes status` or the `/no-mistakes` skill.
- Per-repo gate commands live in `.no-mistakes.yaml`. It is only read from the default branch.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
