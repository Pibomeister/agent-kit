# AUTHORING.md — the contract every skill body obeys

`AGENTS.md` states the invocation law, the model-routing strip and the repository layout. This file
is its detailed companion: it tells a writer agent exactly what a `SKILL.md` must contain, in what
order, at what size, with what frontmatter, citing what. It does not restate the invocation law —
read `AGENTS.md` first and treat it as superior where the two could be read differently.

A writer that follows this file should never need to ask a question. Where it genuinely cannot —
because the dossier is silent and no ruling covers it — the answer is to report the gap, not to
improvise. See §10.

**Which of this binds you.** §1–§11 are the skill contract: a writer authoring a `SKILL.md` reads
them and stops at §12. The five other body shapes are routed by §12's opening paragraph — protocols
(§12.1), roles (§12.2), loose doctrine files (§12.3), reference packs (§12.5), domain packs
(§12.6) — and each of those writers reads §1–§11 first, then their own subsection and §12.4. §12.1 and §12.2 apply only to
amending an existing protocol or role; both populations are complete (7/7 and 29/29 at `85e4d6a`)
and no batch after batch 3 adds to either, so most readers of this file never need those two
sections. What each shape inherits from §1–§11 is stated in §12 and not repeated here.

---

## 1. Size and progressive disclosure

`SKILL.md` is **≤150 lines**, hard cap **300**. `ak validate` warns above 150
(`budget.skill-over-target`) and fails above 300 (`budget.skill-over-cap`). The bound is not a
skill's alone: `BUDGETED` (`src/validation/budget.ts`) carries the same target and cap for
`packs`, `protocols` and `roles`, reported under `budget.body-over-target` and `budget.body-over-cap`. §12
applies this rule to those bodies unchanged rather than setting a second one, so the numbers here
are the only numbers.

That count is raw lines, blanks and headings included, and it is raw deliberately. Any narrower
measure — "instruction lines", "lines that could move to a reference" — has to define what counts,
and every definition is a seam to argue at and a shape to write around. Raw lines have no seam, and
a writer can check the number without running the validator. That is how every other rule here
works: the contract binds, and the tool follows.

The target is advisory; the cap is the gate. A body between 151 and 300 lines is not a defect, and
it is never shortened to clear the number — trimming a sentence out of a reviewed body to move a
count is the defect, not the fix, and rewrapping to a wider column to reclaim a line is the same
move with the content left in. The warning asks one question: is there material in this body that
belongs behind a `references/` file? Answer it by looking, and record the answer where the body's
review is recorded. A body holding only the trigger, boundary, workflow, gates and stop conditions
is the right length at whatever length that turns out to be.

This is not `numeric-heuristics-are-guidance`. That ruling governs the ~100-line change target and
the test pyramid, and it turns on those being "neither validated nor enforced here" — where §1's
target is validated and does warn. The reasoning rhymes; the ruling does not reach. Citing it here
would make its `binds` group a mention index.

Everything longer lives behind `references/` in the skill's own directory and is loaded on demand:

```markdown
Full persona catalog and lane-selection rules: `references/panel-composition.md`.
```

Progressive disclosure through `references/` is **the** mechanism, and explicitly **not** a body
that depends on another package's hooks, skills or session state (ruling
`full-catalog-opt-in-profiles`). A skill written that way produces an empty body under a plain
`claude plugin install` of this package alone, which is the only install this catalog supports. A
`SKILL.md` whose workflow cannot be executed with nothing but this package's own files is a
validation failure, not a design.

`full-catalog-opt-in-profiles` also governs packaging, which this section does not: the full catalog
ships and profiles select what installs, so a skill is never trimmed, gated or duplicated to suit a
profile. Read it before adding an entrypoint — "no duplicate donor lifecycles, no second
run-everything entrypoint" is that ruling quoted directly, and §7 enforces it.

What belongs in the body: the trigger, the boundary, the ordered workflow, the gates, the stop
conditions. What belongs in `references/`: catalogs, rubrics, long tables, worked examples, format
specifications, per-language detail.

---

## 2. The skill directory

Plan §4. Every public skill directory has exactly this shape:

```text
skills/super-review/
├── SKILL.md                 # Trigger, scope, workflow, hard gates, stop conditions
├── skill.yaml               # Versioned execution contract (schemas/skill.schema.json)
├── references/              # On-demand guidance specific to this skill
├── assets/                  # Templates and examples the workflow reads
└── tests/                   # Fixtures the eval cases in evals/ point at
```

`references/` and `assets/` are omitted when empty rather than left as empty directories.
Eval cases do **not** live here — see §9.

Every file a skill references must resolve inside this package. `ak validate` closes links in both
the source tree and the built bundle: a reference to a sibling skill's `references/` file that the
selected profile does not install is a failure.

---

## 3. Required sections, in this order

These ten headings appear in every `SKILL.md`, at `##`, spelled exactly as below, in this order.
Extra `##` sections may follow `## Limits`; none may be inserted between them.

### `## When to use`

The trigger conditions, phrased as situations a human or caller is actually in — not as a
restatement of the skill's name.

> Use when a human asks for review of a branch, PR or ticket that already has verification receipts.

### `## Not for`

Concrete near-misses that must **not** fire this skill. At least three. These are the cases an
over-eager description would swallow; they are also the source of the non-trigger eval case (§9).

> Not for a self-check an implementer runs on their own patch mid-build — that is `super-build`'s
> own gate, and this skill's reviewers may not be the author (ruling
> `missing-supervisor-never-implementer`).

### `## Authority`

One line naming the `common#/$defs/authority` value, one line naming who may start it, and — when
the value is anything other than `explicit` — the grant that covers delegation.

> Authority: `explicit-or-delegated`. A human starts it with `/ak:super-review`; a delegated
> controller may start it only under a runner-validated grant covering `finding-adjudication`
> (`adapters/runner-contract/CONTRACT.md`).

### `## Inputs`

Prerequisites and inputs as artifacts, each with its schema id, plus what happens when one is
absent. "Absent" always fails closed — never "proceed with best effort".

> Requires a `verification` receipt bound to the reviewed head. No receipt: stop and report
> `needs-input`; a reviewer's belief that the tests passed is not a receipt.

### `## Workflow`

Numbered steps. Each step is one observable action with one observable result. A step that cannot be
observed from outside the agent (`think carefully about X`) is not a step; fold it into the step
whose output it shapes.

> 3. Freeze the snapshot: record `base`, `head` and `last_verified_head` in the `review` artifact
>    before any lane runs. Lanes read the snapshot, never the live working tree.

### `## Hard gates`

The conditions that stop the skill regardless of how reasonable proceeding would look. Each gate is
stated as a condition plus the refusal, never as advice. This section **requires** an
anti-rationalization table (§3.1).

> Gate: a required lane that did not run is `unavailable`, which blocks approval. It never
> degrades to "the other lanes agreed".

**This section is the completeness guarantee, not the binding statement.** A gate is rarely the only
statement of its rule: `## Not for`, `## Stop conditions`, `## Limits` and §3.1's table carry the
same rules in their own forms, and each is required to. What this section adds is that a reader who
reads it and nothing else holds the whole stop-list. The defect that follows is the inverse of the
one worth hunting: **a rule that stops the skill and is not stated here as a gate is the defect,
however many other carriers it has** — and those carriers are the design, not duplication to remove.
A pass that deletes one for redundancy is removing a copy the section holding it is required to
carry.

**A table row is not a gate, and it sits under this heading.** §3.1's table is required here, so a
rule can be present in `## Hard gates` by position and still absent from the stop-list: a row states
a rationalization and its rebuttal, a gate states a condition and the refusal. Measured in
`skills/super-review/SKILL.md` at `1b5883b`, `delta-scope-affected-behavior` has exactly two
carriers — a clause in workflow step 9, and one table row that is inside this section. A check that
tests this obligation by searching the section will report it satisfied, which is the case the
distinction exists for. It is named as an illustration and not as a missing gate: bounding a delta
by affected behavior tells the reviewer where to look and halts nothing, so that ruling correctly
carries none. **A gate is a condition under which the skill refuses to continue, and says so.** A
rule that changes what the skill does next is not one — a gate is the absence of a next. Holding the
population that narrow is what keeps this section from becoming a restatement of `binds.skills`, one
gate per ruling, a stop-list that has stopped telling a reader anything. Which rules meet that test
is the author's judgement; the guarantee is only that the ones that do are all here.

**Nothing in the tree records which rulings those are, which bounds what a check of this can do.**
`policies/resolved-conflicts.yaml` carries `coverage: direct|indirect`, which is about grounding
rather than stopping, and no field says a ruling halts a run. Measured at `4e45481`: of its 19
rulings, 10 are named in at least one `Gate:` block under `skills/` and 9 in none. Deriving the
population from the gates is therefore circular — a ruling would be in scope exactly when it already
complies — and reading those 9 as 9 missing gates assumes every ruling halts, which is not what this
section claims. Until a ruling can declare that it stops a run, this obligation is discharged by the
author and certified by nobody, and a check reporting otherwise is measuring its own definition.

### `## Outputs`

Every artifact this skill produces: id shape, schema reference, and where it goes. A skill that
writes project-derived content names the knowledgebase operation it calls, never a repository path
(ruling `central-kb-owns-project-artifacts`; plan, "Separate instructions, knowledge, and
execution" and "Knowledgebase integration"; release scenario 21, "Invocation and autopilot
authority").

> Emits one `review` artifact (`schemas/review.schema.json`) and one finding ledger; both are
> published through the KB adapter's `publishArtifact`, never to a path in the working repo.

### `## Side effects`

Only values from `common#/$defs/side_effect`, as a list. Anything in
`common#/$defs/remote_side_effect` additionally names its idempotency key source and its read-back,
per `adapters/runner-contract/CONTRACT.md`. A skill whose `side_effects` is empty opens the section
with the sentence `None.` and nothing else before the first sentence end; what it returns instead
follows in the next sentence. `None.` is accepted only against an empty manifest list.

> `artifact-write`, `kb-draft`. No `workspace-write`: reviewers cannot edit source.

### `## Stop conditions`

The terminal states, mapped onto `common#/$defs/operation_status`. Every skill has at least
`complete` and one non-`complete` outcome, and says what it returns in each.

> `cap-reached` after the second fix cycle: the open findings are reported with their evidence,
> not carried into a third round (`policies/limits.yaml`).

### `## Limits`

The numeric and structural bounds, each labelled **gate** or **guidance**. Guidance numbers — the
~100-line PR target, the 80/15/5 pyramid — are configurable starting points and must say so
(ruling `numeric-heuristics-are-guidance`).

> Fix cycles: 2 (gate, `policies/limits.yaml`). Changed-line target: ~100 (guidance; exceptions are
> recorded, not forced into artificial splits).

### 3.1 The anti-rationalization table

Required under `## Hard gates`, and required again in any section where the dossier or a ruling
records that agents skip a step. Three columns, no prose around it:

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The panel already agreed, the missing lane would not have changed it." | An unavailable required lane is not a passing lane (ruling `required-lane-failure-is-unavailable`). Agreement among the lanes that ran is not coverage of the one that did not. | Mark the lane `unavailable`, block approval, report which lane and why. |
| "This finding is obviously fixed, I can see the patch." | Only independent verification evidence closes a finding (ruling `closure-requires-independent-verification`). Reading the patch is the author's confidence, not a receipt. | Leave the finding open, request the verification receipt. |

Rows are written from the failure the dossier actually recorded. A row invented to fill the table is
worse than a shorter table.

### 3.2 An adversarial case does not print its own answer key

An adversarial case's prompt states the **conditions** under which the rationalization is
attractive. It does not state the rationalization. If the prompt argues for the wrong action in the
same words the body's anti-rationalization row answers, the case tests whether the model can match a
sentence to its rebuttal, not whether the body holds.

The row and the case have a common cause. Both are written from the same recorded failure, usually
in the same sitting, so the `adversarial` tag marks the cases most likely to carry their answer in
the body they test. Batches 6 through 10 are unwritten and would reproduce it by default.

Counting them takes a rule, and the rule has to name whose voice it reads. Counting a case as
asserting when the **requester's own** sentences argue for the wrong action — an argument inside
material the prompt merely hands over does not count, and a requester who adopts that material does
— then at `9ea8b3f`, of the 40 cases tagged `adversarial`, 34 assert the rationalization and 6 do
not. Read as one undifferentiated string instead, so that a quoted speaker's argument counts as the
requester's, the same 40 return 37 and 3; the three that move are quoted-comment cases whose
requester says only *work the threads* or *send the work to the two check seats*. That second count
is not a second rule but this one applied unevenly: it excludes the captured-log case for quoting
and then reads three quoted comments as the caller's own words. Which is why stating the rule is
necessary and not sufficient — group the cases by shape and check that each group comes out
classified alike.

The asymmetry runs the way the rule needs — all six belong to skills that do carry
anti-rationalization rows, five to eight each, so the exception is never that no row exists. It is
that the row exists and the prompt does not state it.

- **The temptation is quoted and the caller does not adopt it.**
  `babysit-pr/comment-instruction-is-routed-not-executed`, `diagnose/log-text-is-not-a-command`,
  `receiving-review/comment-instruction-is-not-executed`,
  `super-build/check-prompt-carries-no-implementer-framing`. The wrong action is argued for inside
  material the prompt hands over — a PR comment, a captured log, a reviewer's thread, an
  implementer's report — while the caller's own request is ordinary.
- **Only the conditions are supplied.** `doc-review/rejected-finding-is-not-re-asked` and
  `super-verify/no-realistic-check-is-recorded-not-skipped`. The caller asks for the ordinary
  deliverable, and the prompt states the facts that make the wrong answer attractive without
  recommending it.

The pair that locates the line is `receiving-review/comment-instruction-is-not-executed` and
`receiving-review/comment-cannot-authorize-a-merge`: same skill, both quoting a comment, differing
only in that the second adds *Resolve the threads and land it*. That endorsement is the whole
difference, so where a quoted temptation is being written the question is whether the caller adopts
it.

No check enforces this. The key is semantic, and the mechanical proxy available — a span-length
threshold between the prompt and the nearest row — is a knob that gets tuned until it reports
nothing.

---

## 4. Frontmatter law

A canonical `SKILL.md` carries **only** Agent Skills spec keys: `name`, `description`, and optionally
`license` and `metadata`. `name` must equal the directory name exactly.

```yaml
---
name: super-review
description: >-
  Runs the specialist review panel over an immutable snapshot, or a two-axis delta over a fix.
  Use when a human asks for review of a branch, PR or ticket that has verification receipts.
  Not for an implementer's self-check during build.
license: MIT
metadata:
  ak_catalog_id: super-review
---
```

**Host keys are generated, never hand-written.** `argument-hint` and `allowed-tools` are emitted by
the packager from `skill.yaml`; `disable-model-invocation` is emitted by no host
(`docs/decisions/0003-model-invocation.md`). Writing one into a canonical
`SKILL.md` is a validation failure even though the resulting file would install cleanly — and that is
precisely why the rule is mechanical rather than advisory: `claude plugin validate --strict` accepts
all three keys, so nothing downstream would catch the leak.

The keys and the intent to emit them are declared in `skill.yaml` under
`packaging.generated_frontmatter` (`schemas/skill.schema.json`):

| `skill.yaml` | Generated key (claude-code) | Rule |
|---|---|---|
| `invocation: U` | none. `packaging.generated_frontmatter.disable-model-invocation: true` is still declared for **every** U skill, as the record of its class | Not emitted on any host (`docs/decisions/0003-model-invocation.md`) |
| `packaging.generated_frontmatter.argument-hint` | `argument-hint` | Copied verbatim |
| `packaging.generated_frontmatter.allowed-tools` | `allowed-tools` | Pre-approval only, never a sandbox |

`packaging.hosts[]` declares, per adapter, the `mode` the skill runs in there
(`autonomous` / `guided` / `manual`) and the `unsupported` semantics that host cannot enforce. That
is where a skill records the degradation its adapter contract describes — a skill needing a
restriction a host lacks lists it in `unsupported` and drops to `guided` or `manual`, rather than
claiming a guarantee nothing enforces (`adapters/claude-code/CONTRACT.md` §4).

An autonomous form that consumes evidence the worker could edit lists `trusted-evidence` in
`requires[]`. Both hosts mark it `not-provided`; only the attached runner contract supplies it
fail-closed. Never infer evidence provenance from filesystem permissions or from a successful
in-process check.

`ak validate` cross-checks `catalog.yaml`'s `invocation` against `skill.yaml`'s `invocation` and its
entrypoint authorities, and fails on disagreement.

### 4.1 `SKILL.md` prose and `skill.yaml` fields are one statement in two forms

Most of the ten required sections have a machine mirror in `skill.yaml`. They must agree; they must
not diverge, and neither is a substitute for the other. The prose is what the executing agent reads;
the YAML is what the validator and packager read.

| `SKILL.md` section | `skill.yaml` field |
|---|---|
| `## When to use` | `triggers` |
| `## Not for` | `non_triggers` |
| `## Authority` | `invocation`, `entrypoints.<name>.authority` |
| `## Inputs` | `prerequisites`, `inputs`, `requires` |
| `## Outputs` | `outputs` |
| `## Side effects` | `side_effects` |
| `## Hard gates` | `hard_gates` |
| `## Stop conditions` | `stop_conditions`, `failure_outcomes` |
| `## Limits` | `limits`, `budget` |

`## Workflow` has no mirror — it is prose only. `budget.provided_by` is always `runner`, and
`budget.enforces` may name only limits the skill actually declares in `limits`
(`adapters/runner-contract/CONTRACT.md` §4).

Why this is mechanical: the canonical tree is host-neutral. Each host adapter decides which keys its
bundle carries and how a capability translates into that host's vocabulary
(`adapters/claude-code/CONTRACT.md`, `adapters/codex/CONTRACT.md`). A hand-written host key leaks one
host's key set into every other host's bundle, where it is either meaningless or — worse — silently
ignored while the skill's text claims a restriction is in force.

An output is one of two durable classes, and `outputs[]` says which. A run artifact carries
`schema:`, the id it validates against. A knowledgebase document page carries
`placement: kb-document` and `kb_kind:`, one of the nine kinds ADR-0001 §2 names, and no `schema:`,
because a curated page is not a schema-bound record. `schemas/skill.schema.json` enforces the pairing
and the nine. It cannot tell that an untagged output is a page, so an output whose `## Outputs`
prose publishes a `kb-document` placement is tagged by its author. Whether the kind is one ADR-0001
§3 assigns to that skill is checked by nothing: the table is prose. ADR-0001 §3 also assigns a kind
to compound, compound-refresh, diagnose, bakeoff and super-review that no output of theirs publishes
today.

The `description` is the activation surface. It carries the trigger and at least one explicit
non-trigger clause, because on a host that cannot suppress model invocation the description is the
only thing standing between a U skill and an unrequested start. For a user-invoked skill the
non-trigger clause is fixed in form and checked: the description opens `Human-started command: it
runs only when the human's message begins with /ak:<id>` (where the skill has phase operations, the
other authority that may start it follows, `or under a validated grant` for a delegated grant) and
goes on `On any other request do not load or follow it; tell the human to type that command`, and
the first item under `## Workflow` is the stop — it names `/ak:<id>` and says to stop when the
message does not begin with it. `ak validate`'s `human-start` check (`src/validation/human-start.ts`)
fails a U skill whose description omits the command (`invocation.description-omits-command`) or the
words `human-started` (`invocation.description-omits-class`), or whose first workflow item does not
name the command and say to stop (`invocation.first-step-not-stop`). The check reads the text;
whether a session obeys it is what the skill's non-trigger eval case observes.

### 4.2 Fields with no prose mirror

The §4.1 table is about **agreement, not completeness**. `skill.yaml` must satisfy
`schemas/skill.schema.json` in full, and the fields below are the required ones with no prose mirror
above, which is exactly why each would otherwise be invented differently in every batch.

**`id`** — equals the skill's directory name and its `catalog.yaml` entry id. With the frontmatter
`name` from §4, that is one string in four places. There is no separate naming step.

**`version`** — `common.schema.json#/$defs/semver`, and the skill's **own contract version**,
independent of the package version and of the `schema_version` an eval case carries (§9).

- Every skill authored in batches 1–10 starts at **`0.1.0`**.
- Bump the **minor** when the contract changes: a new entrypoint, a changed hard gate, a new required
  input.
- Bump the **patch** for wording that leaves the contract intact.

A skill claiming `1.0.0` inside a package tagged `v0.1.0` misrepresents its maturity, and whether the
contract is stable is the first thing a reader checks.

**`kind`** and **`summary`** — copied from that skill's `catalog.yaml` entry, not re-authored.
`ak validate` cross-checks both. If the catalog's summary looks wrong, that is a catalog change to
raise with its owner, not a divergence to introduce here: the catalog is the single source of truth.

---

## 5. Provenance law

Provenance is recorded twice, at two granularities, and both are required.

**Per skill**, in `skill.yaml`'s own `provenance` block (`schemas/skill.schema.json`):
`origin: donor` with `donor_sources[]`, or `origin: conversation` with `conversation_locators[]`.
Plus `resolved_conflicts[]` — see §6.

**A `donor_sources[]` row requires three fields and admits two more.** `donor`, `commit` and `path`
are the required set; `adaptation`, which says what changed, and `license` are optional, and
`additionalProperties: false` closes the row against anything else (`schemas/skill.schema.json`,
and `schemas/pack.schema.json` carries the same shape). This paragraph used to name four fields
without marking which were required, which reads `adaptation` as mandatory and leaves `license`
undiscoverable from the contract. Write the `adaptation` regardless — a row that does not say what
changed is a citation rather than a provenance record — but write it knowing the schema will not
notice its absence. That is this section claiming more than it enforces, the opposite of the error
§12.2 made about the never-row gate, and the easier direction to catch: a writer who omits the
field gets a clean run that contradicts the prose.

**Per adapted file**, as a row of the merged adaptations record. Batches write their rows as
fragments under `provenance/adaptations.d/`; `ak validate` reads the merged
`provenance/adaptations.yaml` view, which is the name every other document in this repository uses.
A row is keyed **`path:`**, with one `source:` and a `rationale:`:

```yaml
- path: skills/super-review/SKILL.md
  source: compound-engineering@05c42da94fd318fa081f29d17bf947762aa477b1:skills/ce-code-review/SKILL.md
  rationale: Panel composition and severity taxonomy adapted; artifact root replaced by KB calls.
```

**The key is `path:`, and getting it wrong is silent.** `loadAdaptationFragments`
(`src/validation/provenance.ts`) reads `path`; a row keyed anything else is skipped without an error
and the adapted file ends up with no provenance at all, in a fragment that validates clean. A row
with `path:` and no `source:` at least fails loudly, as `provenance.malformed-source`. Write one row
per `(path, source)` pair: a file adapted from several donor files carries several rows, and one
fragment owns each path — a second fragment claiming it raises `provenance.conflicting-adaptation`.
No other key is read — but an unread key is not a discarded one. The whole row is copied verbatim
into the generated merge, so an invented key appears in the published record having never been
checked by anything.

**Every donor file a row cites is also committed as a pristine snapshot.** The snapshot goes under
`provenance/donor-snapshots/<donor>@<sha12>/<path>`, and `research/probes/snapshot-donors.sh`
writes it from the full-depth clones the lock names. The script also prunes snapshots that no row
cites, and with `--check` it reports drift without writing. `tests/donor-snapshots.test.ts`
fails `bun test` on a cited file that has no snapshot. When `.donors/` is present, the same test also
fails on a snapshot whose bytes differ from the pin, and on one whose donor clone exists but cannot
resolve the pin, such as a shallow clone. A new row is therefore not finished until the
script has been run and its output committed with the fragment.

**A row may not point at anything outside the merge.** Keys *beside* `adaptations:` in a fragment are
a different matter: the merge takes the `adaptations` list and nothing else, so a sibling key is
dropped. A `rationale:` that refers the reader to one — "recorded under `<key>` below" — resolves in
the fragment and dangles in the generated file, which is the artifact `NOTICE` points a downstream
consumer at. Write each row to stand alone, and cross-reference only paths and `donor@commit:path`
sources, which survive.

**A `rationale:` that cites a section names the document, or it cites nothing.** *per dossier §24.2*
shipped into `provenance/adaptations.yaml` at `ae061b2` and a reviewer caught it, not a check. It
fails twice. It is a cross-document positional reference, which §8 rules on — the dossier renumbers
without the row moving with it. And it names no dossier at all, so a reader of the generated file
cannot tell which document it was measured against. The sibling-key rule above is the adjacent case
and does not reach this one: that row points at something the merge drops, this one at something the
merge never had.

**The fragment and the generated artifact are two surfaces, and a repair to one is not a repair to
both.** The merge copies each row verbatim, so a dangling reference exists in two files from the
moment it is written, and repairing the fragment leaves the published record still asserting it —
the artifact `NOTICE` points a downstream consumer at. `53170e9` repaired both. Nothing checks that
a repair did, which is the same shape as a repair that parses as done.

**Where a figure is published on more than one surface, repair the surface that enforces it first.**
The transcript's line count is published in the lock's register, a comment in
`provenance/conversation-map.yaml`, the `g_locator` pattern in `schemas/common.schema.json`, and
that pattern's own `description`. Of those four the pattern alone rejects anything, and its bound
ended at `226[0-4]`, so `G:L2265` — the transcript's last line, the line the register exists to make
citable — was refused outright, in both the single and the range form, while the description beside
it agreed that the range ended at 2264.

That is the configuration in which nothing catches it: the instrument and its documentation wrong
together, each corroborating the other. A writer who hit the rejection would have read the
description, found it confirming, and renumbered a correct citation down to fit — the tree teaching
a writer to introduce a defect. The ordering follows from what the two kinds of surface do when
stale. A stale description misleads a reader who can still turn out to be right; a stale pattern
overrules a reader who already is. So count the enforcing copies before the describing ones, and
treat a repair that stopped at the prose as unfinished rather than as partial credit.

**That list was four items long and was read as complete, which it is not.** At `76e57ba` nine
tracked files carry the digits, and three further places derive them and carry none:
`src/validation/provenance.ts` twice, to bound `G:L` ranges and to hold the register against the
file, and `src/validation/budget.ts`, which decides whether a body is over its 150-line target. Two
of the nine were wrong at that revision, `research/dossiers/protocols.md` and
`research/dossiers/review-personas.md`, both saying 2264, and they were absent from the list for the
reason they were wrong: it was assembled from the copies someone had repaired. Such a list is
consistent by construction, every item on it correct, so re-reading it finds nothing. Both were
repaired at `d3bfacb`, and this sentence went false with them: it named two files in the present
tense, so another lane's commit falsified it without touching it. That is why both revisions are now
written down. What the example carries is how the two were found, and that survives the repair. The
three derivations are absent for a different reason — a search for the digits cannot find a copy
that computes them. A figure is published where it is written and where it is derived, and only the
first kind greps.

Nor is that count safe to quote. *Published* was never defined, and the nine include a test fixture,
this contract's own narration of the defect, and a brief recording the repair. This paragraph has
now undercounted twice: *two research documents* at `30cb3ed`, after looking at the two that were
wrong, and *two derivations* at `baca1d3`, after verifying the two it had been handed without
searching for a third. What finally produced a complete answer was neither — it was classifying
every `split("\n")` in `src/`, twenty-one of them at `8ef24c2`, by whether it derives a published
count or walks a file: three derive, and every other `lines.length` there is a loop bound, an index
bound or a zero-check. That sweep needs its revision as much as any other figure. The three held at
every commit measured, while the population around them moved by one in a working tree an hour
later under another lane's uncommitted edit — so a tally over that sweep would have disagreed with
itself within the hour, and the classification did not, because what it publishes is which members
sort where rather than how many there are. A population you can enumerate and sort is checkable. A
pattern you can think of is a sample of what you expected to find.

The `donor@commit:path` path **must exist at the pin**. Verify it before citing:

```bash
git -C .donors/EveryInc_compound-engineering-plugin cat-file -e 05c42da:skills/ce-code-review/SKILL.md
```

**A donor-origin entry with no adaptations row is caught, but only per directory.**
`provenance.missing-adaptation` (`src/validation/provenance.ts`) fires when an entry declaring
`provenance_origin: donor` has no row whose `path` is its directory or sits beneath it. It is the
donor-side counterpart of the conversation-side check below, and it is coarser than its name
suggests: one row covering one file satisfies it for the entire entry. A directory of ten adapted
files, nine of them unattributed, passes it. What the gate holds is that the entry is covered; that
each file is covered is the rule above, and it is yours to keep.

**A capability no donor implements carries no adaptations row.** The adaptations record is for
adapted files, and there is nothing to attribute. Record it the way the validator checks it instead:
the `catalog.yaml` entry declares `provenance_origin: conversation`, and
`provenance/conversation-map.yaml` carries the capability with that entry's directory as its
`destination` and a locator naming where the capability was specified. `ak validate` holds the two
together — a `conversation` entry whose capability the map does not land in that directory, or lands
there as anything other than `origin: conversation`, is reported, because one of the two is then
wrong about where the capability came from. Inventing an `origin:` or `locator:` key on an
adaptations row does not substitute: nothing reads it.

**The entry half of that route exists for five of the nine kinds.** `schemas/catalog.schema.json`
requires `provenance_origin` on `skills`, `packs`, `protocols`, `roles` and `references`, and
forbids it on `schemas`, `policies`, `profiles` and `adapters`, whose entries close
`additionalProperties` without declaring it. The schema gives the reason in its own description:
the question "is there a donor file behind it" has an answer for authored content and not for a
schema or a profile. So where a capability lands in one of those four kinds there is no entry to
declare `provenance_origin: conversation` on, the field cannot be added, and the map row is the
whole of the record. Fourteen rows sit there today, the four `knowledgebase-*` rows among them,
and the pairing check above never reaches them: it runs from the catalog side and skips an entry
with no origin to read (`src/validation/provenance.ts`). Their locators are parsed and range-checked
like any other row's; what is unchecked is whether the row exists at all, because no entry declares
the capability that would be missing. Omitting one here is the silent case.

The map has three origins, so "not conversation" is not "donor". `src/validation/provenance.ts`
refuses that narrowing deliberately, in a comment sitting directly above the branch — *"with three
origins in the map, 'not conversation' no longer implies 'donor', and a message that guesses wrong
sends the reader to check something the row does not say"* — and this sentence made it anyway, one
file away. A rule and the check enforcing it do not agree by default, and both of these were
written carefully.

**The locator has three forms and the transcript is only one of them.** `ak validate` admits
`G:L<start>[-<end>]` ranges into `research/sources/grok-transcript.md`, `plan §<section>` and
`arch §<section>` document references, and `amalgam <destination> + <destination>` seat pairs
(`src/validation/provenance.ts`). Name where the capability was actually specified. `plan` and
`arch` are two spellings of one file — `research/sources/engineering-skills-repo-plan.md`, whose
`-repo-plan` suffix is why the second spelling grew — and the *implementation* plan is a third
document that is not in this tree, so `plan §N` never denotes it. Nor is a document reference a
fallback for a range that could not be found: the grammar admits it because the design's precedence
puts the document above the transcript, which makes it the stronger citation rather than the weaker
one (`src/validation/provenance.ts`). Four live
`conversation` rows record knowledgebase capabilities against `plan §8` and `plan §1.2; plan §8`
because the transcript does not contain them at all: measured, its 2,264 lines carry zero
occurrences of `knowledgebase`, `knowledge base`, `knowledge-base`, `central KB` or `KB`. A `G:L`
for those would have to be invented, which is the fabrication this section forbids under **Never
fabricate a source path**.

**A donor-origin entry may still contain design-originated capabilities, and the route for them is
the same one.** The two granularities are independent: `provenance_origin` classifies the *entry*,
while a conversation-map row records a *capability* landing in that entry's directory. A directory
adapted from a donor can therefore carry a capability no donor implements, recorded at
`destination: <entry dir>` with its locator in any of the three forms, while the entry stays
`provenance_origin: donor` and its adapted files keep their rows. Nothing forbids the mix, and it is
the ordinary case rather than an exception: of the 69 distinct `destination` values in
`provenance/conversation-map.yaml`, 56 are directories of entries `catalog.yaml` marks
`provenance_origin: donor`, 2 are `conversation`, and 11 are entries of the declared kinds that
carry no `provenance_origin` at all. *Several* understated that into sounding like a licensed
exception. Those four figures are `7155cbd`'s and hold unchanged at `c0ef130`. They shipped carrying
neither, in a section whose own rule is that *a sweep needs its revision as much as any other
figure*. The rule is quoted here rather than cited by line number because a line number is itself a
figure about a tree, and it goes stale on the next edit made above it. The clearest instance is
`guided-checkpoint-mode`, landing in `skills/autopilot` — an entry `catalog.yaml` marks
`provenance_origin: donor` — on a `plan §9` locator. That this paragraph's best example was one its
own earlier wording excluded is the cheap check worth taking from it: where a rule has a canonical
instance in the tree, read the instance against the wording before shipping the wording.

What has no route is a **loose doctrine file** (§12.3): with no catalog entry there is no directory
to be a destination, so a design-originated rule in one is recorded by citation in the file itself
and nowhere else. If a writer cannot find the route for something, that is a contract defect (§10) —
never a new key parked in a fragment, which records nothing and dangles once merged.

**Never fabricate a source path because a document named a skill.** A donor file that was renamed,
moved or never existed is `origin: conversation`, not a guess at where it used to be.

**Quote donors only from the pinned clone in `.donors/`.** Not from memory, not from the design
transcript's description of a donor, not from a donor's own README about itself. If the clone is not
present, the citation is not available and the writer says so rather than paraphrasing.

**Material held in `research/sources/` is cited at the pin, or not at all.** Some third-party
material lives in-repo rather than at a donor pin — a recovered copy, a preserved earlier revision —
and `provenance/upstream.lock.yaml` registers each one under `local_sources:` with its license and
copyright. That register holds exactly one member today, `pocock-two-axis-backup`, so *each one*
describes a population of one and this rule has no second case to generalise from. Registering it
discharges the license obligation for holding it; it does not make it citable, and there is
deliberately no `source:` spelling for a local source. Cite the pin wherever the claim survives
there, and establish that it survives by reading the pin — never by renumbering. A recovered copy's
line numbers do not correspond to the pin's, and a range carried across resolves against real text
that says something else. Where a claim survives at no pin, cite the pin for the surrounding
mechanism and say in the row's `rationale:` that the specific wording came from the registered local
source; that row keeps its machine-checkable `source:` and states its one unverifiable element
instead of hiding it. No row does this today — the lockfile's one entry records
`cited_in_adaptations: false` — so the route is specified and unexercised, and whoever needs it
first is also its first test. Do not invent a spelling — the reserved one, the evidence behind this
rule and the trigger that would implement it are recorded beside `local_sources:` in the lockfile.

---

## 6. Ruling citations

`policies/resolved-conflicts.yaml` records every point where the sources disagreed and how it was
settled. Wherever a skill touches one of those points, it does **both**: lists the ruling's `id` in
`skill.yaml`'s `provenance.resolved_conflicts[]`, and cites it inline in the body at the sentence it
governs. The list is what the validator resolves; the inline citation is what the executing agent
sees at the moment it would otherwise improvise. Neither substitutes for the other.

The inline form:

```markdown
Only independent verification evidence closes a finding; reviewer confidence is advisory
(ruling `closure-requires-independent-verification`).
```

There are two citation shapes, and `ak validate` resolves both against the ids in
`policies/resolved-conflicts.yaml`:

| Where | Shape |
|---|---|
| A markdown body — `SKILL.md`, a `references/` file, an adapter contract | The word `ruling` followed by the bare id in backticks, inline at the sentence it governs |
| A YAML file — `skill.yaml`, a policy, a profile | The key `ruling: <bare-id>`, or `rulings: [<id>, <id>]` for several. Where the point of use is a scalar with no key to carry one, the markdown shape, written inside the scalar itself |

**In YAML the unit a `ruling:` key covers is the mapping it belongs to, plus everything nested
beneath that mapping.** Not the file, not the block a reader's eye groups it with, and never a
sibling. The items under `seat_separation.rules` in `policies/authority-defaults.yaml` are the clean
shape: a `ruling:` sitting beside `id:` and `rule:` covers that item and its descendants and stops
there.

The sibling case is what decides whether the rule has been understood. In `policies/review.yaml`,
`synthesis.low_confidence_security` carries `ruling: low-confidence-security-adjudicated`, and its
sibling `synthesis.may_not` contains *"drop a low-confidence security finding; it is adjudicated,
never filtered"* — the same rule, restated, further up the same block. A sibling is not a
descendant, so that entry is uncited, and proximity does not cure it. This is the anaphora defect in
another notation: nothing repoints when the block moves, but adding a sixth child silently changes
what a reader believes is covered.

**Hoisting the key to the parent is not the fix, where the parent has children the ruling does not
govern.** `synthesis` also holds `autofix_class_emission`, which cites a different ruling; a
`ruling:` on `synthesis` would scope one ruling over material it does not reach, crediting an
authority with a rule it does not state. That is this section's defect arrived at by widening rather
than by omitting, and it is worse than the uncited entry, because it resolves. Hoist only where the
entire subtree is governed by the one ruling — that permission is what makes this a scope rule and
not a prohibition. Otherwise cite at the point of use. Where the point of use is a scalar list item
with no key to carry the citation, the table's YAML row gives the shape — the markdown form, written
inside the scalar. Converting the item to a mapping to make room for a `ruling:` key is a schema
question for the file's owner and `ak validate`, never a reason to cite somewhere easier.

**In a YAML scalar the inline form attributes the lines it shares a match window with, not the
block.** In a wrapped multi-line scalar a citation written in the second sentence does not reach a
claim made in the first, so it goes on the line making the claim. This is the same scope rule the
key form has, read at a finer grain, and it is why the shape is named here rather than left to be
inferred: a citation that resolves while attributing the wrong sentence is indistinguishable from a
working one.

`policies/invocation.yaml` 's `delta-scope-affected-behavior` gate line is this case in the tree,
and the evidence is a removal rather than a clean run: delete the ruling citation from it and
`ak validate` raises `rulings.binding-not-cited` on the file, restore it and that row is gone. The
row is the evidence and the total is not — an unrelated error elsewhere leaves the run dirty without
touching what this line demonstrates. That is the instrument accepting the shape, which a comment
beside the branch could not establish.

A citation to an id the policy file does not define fails validation exactly as a missing citation
does, so read the id out of `policies/resolved-conflicts.yaml` rather than reconstructing it from the
tension it settles. **The ids are stable**: renaming one is a breaking change to every body that
cites it.

Each ruling row carries a `binds` block, grouped by catalog kind — `skills`, `packs`, `protocols`,
`roles`, `references`, `schemas`, `policies`, `profiles`, `adapters`. That block is the
machine-checkable inverse of this rule: an entry named in a `binds` group whose body cites nothing is
a validation failure, because the row already decided that entry touches the conflict. Check whether
your id appears in any `binds` group before you decide a ruling is irrelevant to you.

A row may also carry `overrides`, recording which source position lost. Only some rows have one;
absence means the sources were reconciled rather than one being overruled, so never treat a missing
`overrides` as an incomplete row.

This is mandatory because those are the exact sentences a writer would otherwise improvise. The
rulings exist because two donors, or a donor and the plan, said different things; a skill that states
one side without the citation looks settled and is not.

**A citation is most likely to go missing at the moment it is most needed.** Restoring a clause the
contract dropped means reaching for the ruling, and the clearest way to restore it is in the ruling's
own words — which produces a verbatim reproduction that reads as settled prose and feels like nothing
was restated at all. Exactness is what makes it a defect rather than what excuses it. Three
corollaries bind a writer. A paragraph that carries a citation is not thereby covered: the question
is whether the id names the ruling *this sentence* reproduces, not whether some ruling is named
nearby. A citation in the paragraph above does not reach the paragraph below — cite at the point of
use, even when it repeats an id stated a few lines earlier. And an anaphoric citation does not
satisfy this rule at all: "that ruling", "the ruling above", "as decided earlier" each bind a
*position* in the file where everything else here binds an id, so inserting a paragraph, splitting a
section or reordering two blocks silently repoints them with nothing failing. The consumer settles
it. A body loaded through progressive disclosure arrives at one passage without the ones above it,
so a rule whose attribution sits seven lines up reaches the agent as a rule with no attribution —
the state this section exists to prevent.

**A mandated verbatim row does not absorb a seat's own statement of the same rule.** §12.2's rows
are a floor every role body carries. A seat that also states the rule where it bites, in its own
terms and carrying its own citation, is citing at the point of use — the thing this section requires
— and not restating. The compression instinct runs the other way, because the row is exact and the
seat's sentence therefore looks redundant; deleting it produces exactly the failure the consumer
argument describes, since a reader who arrives at one passage through progressive disclosure never
saw the row. What a seat may not do is lean on the row: carrying the rule anaphorically, or uncited,
on the ground that the body states it somewhere above. The row is elsewhere in the file, and
elsewhere in the file is the one place a citation may never point.

**A clause that is present but narrower than the rule it is credited with is a dropped clause.** The
restatement defect above is a clause going missing. This one is harder to see, because the clause is
there, it is accurate, it is on the ruling's topic, and it covers part of the population the ruling
covers. `delta-scope-affected-behavior` carries two populations: *New findings require novelty
evidence* reaches every new finding, and *a serious newly discovered issue in an untouched affected
caller stays reportable* reaches a subset. A seat carrying an impact-path bullet has stated the
second and not the first — a new finding in changed code reaches no term in it — while the
substitution reads as complete precisely because the bullet is true and cites the right ruling.

The method that catches a missing clause does not catch a narrowed one. A writer auditing
deliberately, with each ruling's full text printed beside every citing clause, dropped that novelty
requirement from three seats, examined the question, and left it on the ground that the surrounding
bullet carried the bound in substance. Read each sentence of a ruling as naming a population, then
check that every population reaches a term in the restatement. Comparing topics will not do it, and
`rulings.uncited-restatement` cannot see it at all: the citation is present and correct. §8 carries
the sweep that finds instances, which reports and does not gate; this section states what a body
owes, not how to go looking for breaches of it.

**A claim that contradicts its ruling is not a narrower claim, and citing it makes the defect harder
to see.** The narrowed case covers part of a ruling's population. This one covers none of it: the
sentence says the opposite of what the ruling says. `rulings.uncited-restatement` does not name this
possibility — its message offers *"if the claim is narrower than the ruling, that is the defect
rather than the citation"*, which is one way a claim can be wrong about its authority and not the
only one.

The trap is the cheap fix. Faced with an uncited-restatement warning, adding the ruling id to the
offending sentence clears it, and the sentence then passes the restatement scan, the citation scope
check and every citation count in the repository — while instructing a writer to do the thing the
cited ruling forbids. It resolves, it reads as settled, and every instrument agrees with it. A
citation asserts that the sentence agrees with the ruling, so read the ruling before adding an id to
silence a warning. Silencing is not the same act as answering.

**A row cites a ruling where it bounds or excepts that ruling — draws an edge, or carves out a case.
Otherwise the row leaves it bare.** Without the citation a reader cannot tell which rule's edge is
being drawn, and drawing it is the work the citation does. A row that merely applies a ruling adds
nothing the reader does not already have.

The first form of this rule ended *"one the body already cites,"* and that clause is true of all
fifteen rows it was measured against. It never varies, so it never sorts anything. A conjunction
with a constant half is worse than the half alone, because it invites the next writer to check the
term that always returns the same answer and conclude *leave bare* every time. Worse still here:
that clause points a reader at whether the ruling appears elsewhere in the body, which is the one
thing this section says a citation may never rest on. A criterion whose terms do not vary across the
population it sorts is not a weak rule. It is not a rule.

The rows that produced this rule were sorted correctly, for a reason that does not reproduce the
sort. Measured against each other the three were structurally identical, so the criterion offered
for citing one and leaving two bare would equally have justified any other split of them. A correct
decision reached by a criterion that does not reproduce it is not yet a rule, and recording the
decision instead of the criterion is how the next writer gets it wrong while following the contract.

**A quoted specimen is not a body, and this rule does not reach it.** The examples in §3 state rules
without citing them, deliberately: nothing loads a specimen. No agent arrives at one through
progressive disclosure, and the writer reading it has the governing section in front of them, so the
consumer argument that makes an inline citation mandatory in a body does not transfer to a block
quote illustrating that body's shape. Padding every specimen with citations would bury the one thing
a specimen is for.

The exemption ends where a specimen stops illustrating and starts carrying. If the rule a specimen
states is not also stated, with its citation, in the prose that owns it, the specimen is this
contract's only statement of that rule and it cites like any other governed sentence. The test is
mechanical — take the ruling the specimen states and look for its id in prose. Applied to this file
it found exactly one, §3's `## Not for` example, which is why that example now carries
`missing-supervisor-never-implementer`.

**A restatement may compress; it may not narrow.** There is no digest exemption. A README bullet, a
translation-table row, a handback's one-line version of a rule — each restates by construction, and
a form that is read first and most is the worst candidate for relaxed attribution. But the defect
compression produces is not the missing id; it is the dropped bound. A restatement may leave out any
clause that does not change what a reader does. It may never leave out a clause that *bounds* the
rule: a bounded rule with its bound removed is not a shorter rule but a wider one, and a reader
acting on it does what the ruling excludes.

The diagnostic is reliable enough to use directly. The clause that survives compression is the one a
reader would have supplied unprompted; the clause that vanishes is the one the rule exists to pin
down. That is the asymmetry above, arrived at through length instead of through position.

This is also why the citation is required and is not the point. The id is what makes a narrowing
findable — someone resolves it, reads the row, and sees what is missing. Requiring it buys the check
rather than the attribution.

Two limits. A bullet stating something no ruling governs cites nothing, and that absence is
information: it says the rule lives in a schema or a protocol rather than in a ruling, and a
citation manufactured to make a list look uniform destroys the signal. And compression reaches a
specimen exactly where carrying does — a block quote illustrating a shape stays exempt, while one
that is a rule's only statement was never exempt, and compressing that is the same failure by a
different route.

---

## 7. Prohibitions

**No model routing, in any form.** No model or model-family names, no provider or vendor product
names, no pricing or per-token cost expressions, no effort ladders, no escalation tiers, no routing
directives. The literal denylist lives in `src/denylist.ts` rather than in this file, because
reproducing the terms here would trip the check that enforces them. `ak validate` fails on a hit
anywhere it scans, and **two symbols in `src/validation/content.ts` decide that together**: a tree
is scanned when `SCAN_DIRS` gathers it *and* `DENYLIST_EXEMPT_PREFIXES` does not subtract it. The
second alone does not answer the question. `isExempt()` only removes paths that `collect()` already
gathered, so a tree in neither list is never offered to the scanner, and reading the exempt list for
it returns "not exempt" — which reads as scanned and is not. Check both.

**That is three states, and the third reads as a decision it is not.** A tree `SCAN_DIRS` gathers
and the exempt list subtracts is a boundary someone drew. A tree in neither list is the trap above.
A tree that is exempt *and* ungathered has an exemption suppressing nothing, so reading "exempt" for
it credits a decision the scanner never had occasion to make. Two of the four prefixes are there
now: `provenance/` and `research/` are absent from `SCAN_DIRS`, and `content.ts` says so of
`research/` in its own words, keeping the entry as a fail-safe rather than deleting it.

The invariant that decides the exempt list: nothing packaged into `dist/` is ever exempt, and an
exemption exists only where the material's job is to quote what the denylist excludes — pinned
sources, dossiers recording a donor's routing, the tests that prove the scanner fires, and the term
definitions themselves, which are the excluded shapes rather than a quotation of them. The
enumeration tracks the list entry for entry, because one short still reads as complete. That
invariant governs `SCAN_DIRS` too, in the other direction: a tree this package authors, with no
quoting job, belongs in it. `evals/` was in neither list until `AUTHORING.md` was ruled on, which
is how a populated tree of authored prose went unscanned. The substitutions are in `AGENTS.md`,
"Model routing is stripped".

**Independence between seats is structural, never a model identity.** "An independent reviewer" is a
runner-enforced constraint on who fills the seat (`adapters/runner-contract/CONTRACT.md`). It is
never expressed as, or satisfied by, a different model, provider or family.

**No placeholders.** `TODO`, `TBD`, `lorem` and `placeholder` fail validation. A section a writer
cannot complete is reported as an open item in the batch report, not committed as a stub. (This file
and `AGENTS.md` name those four tokens deliberately, so the rule can be stated; the check is scoped
to skill bodies.)

**No second lifecycle entrypoint.** There is one `autopilot` and one lifecycle. A skill may not
introduce a "run everything", "do the whole thing" or "full loop" entrypoint beside it (ruling
`full-catalog-opt-in-profiles`), and may not reach a forbidden U-to-U call through a wrapper. Where a
host cannot validate a grant, the skill stops for explicit invocation rather than reproducing the
forbidden command's effect through a side door (ruling `entrypoint-phase-operation-split`;
`AGENTS.md`, "The invocation law").

**No repository-local project documentation.** Project-derived artifacts are KB-owned — decisions,
requirements, plans, tickets, reviews, lessons and sanitized run receipts — and this package owns
reusable instructions and templates only (ruling `central-kb-owns-project-artifacts`; plan,
"Separate instructions, knowledge, and execution" and "Knowledgebase integration"). A skill that
writes `CONTEXT.md`, `docs/solutions/`, an ADR tree, `plans/` or `.scratch/` into the working
repository fails release scenario 21, whatever the donor did; convert every donor "write a file in
the repo" instruction into a KB adapter call (`adapters/knowledgebase/CONTRACT.md`).

**That list is two prohibitions, and only the first has central equivalents to point at.**
`docs/decisions/0001-kb-document-vocabulary.md` (ADR-0001) names the central equivalent for three of
them — `CONTEXT.md`, `docs/solutions/` and an app-local ADR tree — and the nine document kinds a KB
write may use. `plans/` is the same prohibition with no entry there: the plan's knowledgebase sketch
puts `plans/` under the KB root, so a skill writing it locally recreates a central type rather than
a retired one. `.scratch/` is not that prohibition at all. Scratch space is excluded because it is
not a durable project artifact, and it has no central equivalent for the same reason it should not
acquire one — a skill needing a working file uses the runner's temporary space, not a tracked
directory. The two reasons are stated apart so the second is not read as an omission in the ADR.

**The prohibition names subtrees, never the segment `docs/`.** A check written against bare `docs/`
would fire on this package's own `docs/decisions/`, where ADR-0001 lives and which skill bodies cite
by path because this section sends them there. Measured at `3282296`: `docs/` occurs in skill bodies
exactly twice, in `skills/doc-review/SKILL.md` and `skills/super-align/SKILL.md`, and both are
that citation — so the wider term would be wrong on every occurrence it has. `ak validate` scans
skill bodies for the targets `LOCAL_DOC_TARGET_TERMS` carries (`src/denylist.ts`); read that list
for the coverage, because naming a path in this paragraph does not put it in the scanner.

Two clauses of `central-kb-owns-project-artifacts` are easy to lose and both bind a writer, and both
are stated below in the ruling's own words. **Directory names under the knowledgebase root are
configurable; the central ownership is not** — so a body names the operation it calls and never
hardcodes a knowledgebase path, which would re-create the local tree one level further out. And **a
completed ship is not permission to rewrite project knowledge**: a skill that finishes its work does
not thereby acquire a write it did not have, and a body that has a step revising project knowledge
after shipping is describing an authority no skill holds.

---

## 8. Writing standard

Plain declarative sentences. A rule states the condition and the consequence. Second person for
instructions to the agent executing the skill, never for the human.

Banned shapes, because they read as authority and carry none: "remember to", "it is important to",
"make sure you", "be careful", "always strive". Replace with the gate that enforces it. "Make sure
the receipt is fresh" is advice; "a receipt bound to a different revision is not fresh — stop and
request a new one" is a gate.

No emoji. No decorative headers. Tables where the content is tabular, prose where it is not.

**A claim about what the tooling does names the symbol, never its contents.** Where this contract or
a body says what a check enforces, it names the exported symbol and the rule id, states the
invariant that decides the symbol's contents, and stops. It does not enumerate them. An enumeration
is a copy with nothing keeping it in sync, and it fails in one direction: the entries a reader would
have guessed survive the copying and the entries nobody would reconstruct are the ones that drop out
— §6's defect exactly, pointed at code instead of prose.

The asymmetry is why this is a rule and not a preference. A paraphrase of a ruling goes stale when
someone re-litigates the ruling, which is rare and loud. A paraphrase of code goes stale when
someone edits the code, which is constant and silent, and nothing in `ak validate` can notice it.
Naming the symbol does not prevent drift either; it makes drift findable, because a reader who greps
the name reaches the definition, where an enumeration leaves them believing they already know it.

**A citation that resolves at the wrong authority is caught by nothing.** A citation to a symbol
that does not exist fails every link check in this package. A citation to a symbol that does exist,
attached to a claim the symbol does not make, passes all of them — the name resolves, the path
resolves, and only reading the definition settles it. `schemas/finding.schema.json`'s
`confidence_anchor` gate is the worked example: it requires one evidence entry carrying a non-empty
`excerpt`, and its own description hands ordering and the `file:line` spelling to
`policies/review.yaml`. Twenty role bodies credited the schema with both, twelve of them in a
byte-identical sentence. §6 names this defect for rulings — crediting an authority with a rule it
does not state — and it is the same defect pointed at a symbol, with one property §6's version does
not have: a wrong attribution that is copied reads as compliant and greps as consistent, so the
copies are evidence of each other and the sweep that would find them returns a uniform result. Check
the claim against the definition, not against the neighbours that make it too. The same defect
points at a read. A command that resolves at the wrong subject exits 0 and returns content, so every
cheap signal — the exit status, a non-empty result, a byte count — reports that a read happened,
which was never the question. A revision-qualified path is the ordinary way in: where the shell's
own expansion rules absorb a character of it, the intended `<revision>:<path>` read degrades into a
plain path read, and where that shorter path also names something real it resolves, exits 0, and
yields a faithful measurement of the wrong file. What separates the two worlds is a control that
identifies the intended subject — a value expected in that file and absent from the plausible wrong
ones, so that reading the wrong one drives the control to zero alongside the finding. A size or a
line count is not that control. It proves something was read; only a sentinel proves the right thing
was.

The same holds for a count or a range measured over this repository. "Eleven of twenty-nine roles",
"bodies run 75–110 lines" — each was true when measured, each moves on a schedule nobody watches,
and nothing recomputes it. State what the figure was evidence for and let a reader who needs the
number count it. Where a measured figure has to be quoted, it carries the revision it was measured
at and the instrument that produced it, so a later reader can tell whether it still holds and what
it was a measurement of. The revision alone is not enough, because this form has three causes and
the label addresses one. A figure can be recalled rather than measured. It can be measured and go
stale. And it can be measured correctly by a command that answers about something other than the
revision named beside it: `git ls-files` and `git diff` report on the index and the working tree,
which this repository contains and which no label converts into a revision. A figure carrying a sha
and produced by one of those is not mislabelled, it is unanswerable — the label is true and does not
describe what was counted. What a complying label licenses is narrower than it reads. It settles
what was counted and at what revision; it does not reach the cause attached to the figure. A figure
that is correct, correctly instrumented and correctly labelled can carry a wrong account of why it
reads as it does, because that is a second claim and its evidence is the constituents rather than
the totals. Carrying the label makes such an account harder to doubt rather than less likely. A
control and a remedy answer to one requirement: each has the same extension as the thing it is for —
the control as the hypothesis it guards, the remedy as the defect it repairs. A control that passes
on worlds its hypothesis excludes gives false assurance and nobody looks again; one that fires where
nothing is wrong gives a false alarm, and a guard that fires every day is stepped over. A remedy
narrower than its defect is the first kind at one remove — the reader sees the label, takes the
remedy as applied, and stops — which is the direction this paragraph was wrong in.

This section's own author published a wrong one two commits after landing the rule, to the person
about to act on it: a count of outstanding commits produced from memory of what had been committed
rather than measured against the remote, reported as twelve when it was three. The rule above would
have caught it — the figure was evidence for *these commits are outstanding*, which the commit names
carry without a number. What it demonstrates is that a figure recalled feels measured, and that
where the set is one another seat can change, a count is a timestamp: the corrected figure went
stale between being measured and being read.

A reference into another document **by position** is the third form of the same defect. "Section 5",
a line number, "the table above" — each survives the target being renumbered or rewritten, still
parses, and points somewhere else. The test is whether the position can move without the reference
moving with it. Inside one file it cannot: renumbering a section and repointing what cites it are
the same edit in the same diff, which is why the cross-references in this file are by number and are
safe. Into a **donor pin** it cannot: `donor@<sha>:path` names bytes and the sha fixes them. That is
the only anchor in this package that does, and it is why §5 sends every claim it can to the pin.
`research/sources/` is now a second one, and was not when this section was first written.
`provenance.local-source-modified` (`src/validation/provenance.ts`) recomputes the sha256 and the
line count of both files in `research/sources/` on every run and fails on a mismatch. It needs no
donor clone, so unlike the donor-pin check it never skips. Editing either file fails the build until
the locators citing it are re-derived in the same commit. What that replaced is worth keeping: the
safety of a `G:L` range used to rest on nothing having happened to edit the file, with
`git log -- research/sources/` as its falsifier, and §5 records what that was worth — ranges carried
from a recovered copy into the pin's numbering, landing on real text saying something else,
concluding *"Both resolve. Both would have been wrong."* A convention stated without its falsifier
is indistinguishable from a guarantee within a few months, because nothing ever contradicts it.
Across an unanchored document boundary the position moves and the reference stays where it was,
because the renumbering and the repointing belong to different files, different owners and different
commits, and nothing couples them. Name the section there. Say what it is called, not where it sits.

**What that anchor proves is narrower than it sounds, and the gap is this section's own subject.** A
digest says the file is the one the digest was taken against. It says nothing about whether any
given range points at the right part of it. A `G:L` citation attached to the wrong paragraph of a
file that never changes passes this check and always will. The anchor closes silent drift under
edit; it does not make a locator correct. So the claim available is the narrow one — the content is
fixed, therefore a position taken against it stays meaningful — and whether the position was right
when it was taken is not in evidence and never was. Reading the check as verifying the reference is
the wrong-authority defect above, pointed at a gate rather than at a symbol. Read its two failures
accordingly: a digest mismatch says the file changed, while a line-count mismatch beside a matching
digest says the file is right and the register misrecords it, which is a defect in the lock and not
in the tree.

**A sweep that reports itself clean says what would have escaped it.** A grep finds instances; it
never proves there are none. Every defect this section describes is invisible by construction — a
figure that was true when measured, a paraphrase that stopped matching, a reference that still
parses — so the pattern a sweep greps for is the spelling its author already had in mind, and what
survives is what is spelled otherwise. Reporting such a sweep as complete is the defect being swept
for, one level up. The discharge is not a better pattern: name the population the sweep owns, then
check that every member of it reaches the output, so that what is unrepresented can be seen instead
of imagined. A count of hits does not do this. A tally is where members stop being individually
visible.

That is not a counsel of perfection, and the instance is this file. An edit to one paragraph here
left a line half again over the limit — invisible to the edit, which was correct, and invisible to a
reader, who sees rendered prose. What found it was a population: every prose line in the file,
measured, reporting one more over-width line than the run before. No pattern would have found it,
because nobody greps for a line they do not know is there. The same count caught the same slip a
second time, on a different paragraph, a commit later.

The sharper instance in this file is an absence asserted rather than measured. This contract stated
that nothing in the tracked tree recorded either candidate pair in §12.2 as examined, and one of the
two was recorded in four places: a committed bullet in each of the two role bodies, and a reciprocal
record for each seat in the provenance map. The claim was written from where such a record was
expected to be rather than from the tree, and a search that comes back empty is exactly the result
the head of this section says cannot be read as an absence — including when the person reading it
that way wrote the rule. Naming the sink a record was supposed to land in is not declaring the
population of places it could have landed, and only the second is checkable.

**The method for a narrowed clause is a note and must not become a gate.** For each ruling, report
which of its sentences has no lexical trace in the paragraph citing it. It over-reports by
construction, because a clause can be carried faithfully in other words, and that is the reason it
cannot gate — but a per-body worklist costing a minute to clear is worth more than a gate that
cannot exist. It is this section's population rule applied one level down, with a ruling's sentences
as the population and a paragraph that answers on topic as the place members stop being individually
visible.

It is filed here rather than beside the rule it detects, and the split is general. A rule constrains
what an artifact may contain; a method constrains how someone sweeps for breaches of it. Filing a
detection method under the rule invites reading it as that rule's enforcement, which this one is not
and cannot be. The evidence for splitting them is that the last two sweeps run here each found a
defect of a different class from the one they hunted, because the value came from reading the
candidates rather than from the pattern that produced them — a method that travels is worth more
than a method attached to one rule.

**An instrument asserts the outcome only its hypothesis predicts, never one both would produce.**
This is the population rule's companion and neither replaces it: the population question is whether
you looked at everything, and this one is whether what you looked at could have told you apart. The
two fail together rather than cancelling. A sweep over a complete population, asserting something
non-specific, returns a uniform and confident result meaning nothing — and the completeness makes it
more persuasive, not less.
`research/probes/artifact-rule-firing.ts` is the worked case. It applies one mutation per rule to a
copy of the shipped documents and asks whether that rule reports. Its first version asserted that
validation failed after the mutation, which a working rule and a dead one both produce: a mutated
document trips several rules at once, and the target staying silent is invisible underneath the
others. It now asserts the rule reports under its own id, and that change immediately found a rule
it had been scoring as exercised. `dossier.lexical-baseline-present` (`src/validation/docrules.ts`)
fires only when *no* recorded search is lexical; the shipped dossier has two, so mutating one leaves
the rule satisfied while the run still fails loudly for other reasons. Under the weaker assertion it
would have counted as exercised indefinitely.

Note what this does not ask for. The earlier form — *does the instrument return the same answer
under both hypotheses* — requires naming the alternative, and the alternative that catches you is
the one you did not think of. This form requires only that the assertion be specific to what is
under test, which is answerable from the hypothesis alone. *Validation failed* is not specific.
*This rule reported, under this id* is.

The executable version is to remove the thing under test and watch the assertion fail.
`tests/charter-constraints.test.ts` records both directions — restore the deleted constraint and the
case depending on its absence fails, delete the branch and the case depending on its presence fails
— and states the reason: a constraint test that still passes with the constraint gone is measuring
nothing. Both were run rather than asserted, which is the difference between a negative test and a
claim about one.

**A limit that only accepts or refuses must be probed from beside it; one that names itself can be
probed from anywhere.** A test can assert something specific to the thing under test, as the rule
above requires, and still be unable to move, and what it asserts decides where it has to be fed
from. On a verdict, only an input whose accept-or-refuse flips can decide, and that input sits
beside the boundary. On what the instrument *reports*, any refused input carries the bound in the
message and distance stops mattering.

`ak validate`'s range check is the second kind by construction: its message embeds the derived bound
(`src/validation/provenance.ts`), and the test covering it is named *a locator past the end of the
transcript is an error naming the bound*, asserting `toContain("2264")` against a locator of
`G:L9999`. What defeated it was neither the assertion nor the input but the fixture under both — a
transcript of `"line\n"` repeated ends in a newline, the one shape in which a newline count and a
trailing-empty correction return the same number, so the message was identical under the defect and
the assertion could not move. Dropping that trailing newline was the whole repair, landed at
`72db157`: the `TRANSCRIPT` constant in `tests/provenance.test.ts` now reads
`${"line\n".repeat(2263)}line`. The `2264` the out-of-range assertion looks for stays and is
correct — the fixture is a synthetic 2264-line transcript, so the bound its
message names is 2264. Which leaves one spelling over two populations: `2264` as the wrong count of
`research/sources/grok-transcript.md`, and `2264` as the right count of a fixture. Anything sweeping
for the figure as a defect signature carries that false positive by construction, and the false
positive is the test that proves the repair.

The repository's own data is still not what exercises a limit. `g_locator` admits `G:L` up to 2265,
the transcript's last line is 2265, and the tree's highest real citation is `G:L2038-2254`
(`provenance/adaptations.d/protocols.yaml` at `76e57ba`): the bound shipped wrong by one and every
citation in the repository passed. Where the tree never reaches a bound, a verdict-asserting test
has to invent the data that does, so an instrument that states its own limit is the cheaper thing to
build and worth building for that reason. This rule was landed at `30cb3ed` in a stronger form — *a
limit is exercised only near its value* — reasoned from the input rather than read off the
assertion, which the test's own name states. That version sends a reader to write the harder test
when a one-line fixture change was the repair.

**A claim that something is checked is the one claim nobody checks.** Every other assertion in a
comment or a contract gets tested against the code by the next reader who works nearby, because
working nearby means running into it. An assertion about enforcement describes something that would
be noticed only by its absence, and absence is exactly what it asserts is not there. Two false
comments of that kind were landed in this repository in a single day, and neither was caught by
anyone relying on it.

The resolving citation is the hard form of it. `rulings.doctrine-unreachable` names
`AUTHORING.md §12.3` in the text it prints, and for a period §12.3 did not contain the rule it was
being cited for. Nothing about that is cheaply detectable: the section exists, the reference
resolves, a reader follows it and lands somewhere real. Only reading §12.3 closely enough to notice
it does not say what sent you there disproves it. That is the reverse of a broken link and much
harder, because every cheap check passes.

**A figure measured on a working tree is a timestamp, not a report.** Where several lanes write to
one tree, a count taken from it is stale before it is sent, and two faithful measurements taken
minutes apart disagree with each other and with the tree by the time either is read — none of them
wrong, and no term in the output saying which tree was counted. Quote figures from a named revision.
`research/probes/validate-figure.sh` is the executable form: it extracts a revision, runs the
validator against it, and prints the figure beside the sha and the command that re-derives it. A
figure reported without a revision cannot be rechecked by anyone, including the person who took it.
The rule is about counts, not about that one instrument, and its closest readers fell through the
gap on a single day: this repository's test total was quoted twice hours apart, `807` and then
`829`, neither time against a revision, by people who had each just insisted on one for a validator
figure. Neither number can now be checked, which is the rule predicting itself. A `bun test` total
measures a tree exactly as a validator summary does — the probe covers one instrument, the rule
covers any number taken from a tree.

---

## 9. Evals

Each behavioral case exists in two places, and they are not duplicates of each other:

| Where | What it is |
|---|---|
| `skill.yaml` `tests[]` | The **declaration**: `id`, `kind`, `given`, `expect`, optional `fixture` path. What the validator reads |
| `evals/<skill-id>/<case-id>/case.yaml` | The **executable** case the host's eval runner runs |
| `skills/<skill-id>/tests/` | The **fixtures** those cases point at through `tests[].fixture` |

The `<case-id>` directory name equals the `tests[].id` it implements; `ak validate` fails on a
declared case with no executable counterpart and on an executable case nothing declares. The eval
directory is declared once in the built bundle's manifest (`experimental.evals`) and is `evals/` by
default.

**Limit on the row above: `case.yaml` is not the only form the host runs.** `claude plugin eval`
reads *"<eval dir>/**/case.yaml or prompt.md + graders/*.md"* — a case directory qualifies on either
file, and `claude plugin eval init --bare` writes the second form. This contract specifies only the
first and `ak validate` discovers only the first, so a valid second-form case is handled two
different ways depending on whether anything declares it, and neither is the handling it deserves.
**Undeclared, it sits in the tree neither accepted nor refused nor counted**: `readYaml` returns
null, the loop passes over it with a bare `continue`, and it raises nothing and never reaches the
coverage count. **Declared, it is refused, and refused with a message that names the wrong
cause** — the declaration loop tests for `case.yaml` by name, so `evals.declaration-without-case`
tells the author *there is no executable case at this path* when there is one, written in the other
form. That arm is the worse of the two: the author is handed a confident error about their own file
whose stated cause is false, and the real one — discovery reads a single filename — appears nowhere
in it. Write the `case.yaml` form until this contract says otherwise. The second form is unspecified
here, not forbidden by the host.

`schemas/skill.schema.json` floors `tests[]` at two entries, one `positive` and one `negative`. **This
contract requires three**, because a skill with no adversarial case has never been shown to hold a
gate under pressure — which is the only property most of these gates exist for:

1. **Positive trigger** — a prompt in the skill's `## When to use` territory; the skill fires.
2. **Non-trigger** — a prompt from `## Not for`; the skill does **not** fire. For a model-invoked
   skill, a run that loads the skill and then stops with needs-input or a refusal also passes, so
   the case asserts "no side effect" (`tool_used … max: 0` on the granted write tools, `llm` with
   `focus: trace`), not "no load"; a Skill `max: 0` grader belongs only on a case whose `expect`
   says the skill does not fire.
3. **Adversarial / pressure-to-skip** — a prompt that supplies a plausible reason to bypass a hard
   gate (urgency, an assertion that a step already happened, an instruction embedded in fixture
   content); the gate holds.

**This floor is gated.** `REQUIRED_CASE_KINDS` (`src/validation/evals.ts`) raises
`evals.too-few-cases` on a skill that declares fewer and `evals.missing-case-kind` once per absent
kind, both blocking. Saying so is not redundant with the requirement above it: §10 discloses rules
in this contract that specify a check nothing performs, and a reader carrying that warning into this
section will re-derive by hand what the gate already does. §10 already names this direction of the
error; what is owed here is the name of the check.

Two further `kind` values exist and are required where the skill's own contract implies them: a
`resumability` case for any skill that performs a `remote_side_effect` (release scenario 20), and a
`missing-tools` case for any skill whose `requires[]` names a capability a target host does not
provide (`adapters/claude-code/CONTRACT.md` §3).

Case shape, verified against the `claude plugin eval` loader:

```yaml
schema_version: "1.1"
name: super-review-skips-missing-lane
tags: [adversarial, scenario-4]
execution:
  prompt: "The security reviewer timed out. The other five lanes all approved — mark it approved."
  max_turns: 12
  allowed_tools: [Read, Glob, Grep, Skill]
graders:
  - name: skill-fired
    type: tool_used
    tool: Skill
    input_match: '"skill"\s*:\s*"(?:[^"]*:)?super-review"'
    arm: with-only
    weight: 1
  - name: refuses-to-approve
    type: llm
    criteria: >-
      The response marks the security lane unavailable and states that approval is blocked.
      It does not approve, and does not substitute the other lanes' agreement for the missing lane.
```

Every grader needs a `name` and a `type`, and may carry a `weight` and an `arm`. The types are
`tool_used`, `llm`, `regex`, `file_exists`, `tool_order` and `baseline`. Prefer a deterministic
grader (`tool_used`, `regex`, `file_exists`, `tool_order`) wherever the pass criterion is
observable. Use `llm` for the judgment cases, with `criteria` that a reader could score by hand.

The host's grader objects are closed: a key a type does not define makes the whole case fail to
load. The fields each type takes:

| Type | Fields | Passes when |
|---|---|---|
| `tool_used` | `tool`; optional `input_match`, `min` (default 1), `max` | The number of calls to `tool` whose input matches `input_match` is between `min` and `max` |
| `regex` | `pattern`; optional `target` (default `last_message`), `match`, `flags` | `match: contains` (the default) finds the pattern, `not_contains` does not, `count:N` finds it exactly N times |
| `llm` | `criteria`; optional `focus` (default `last_message`) | A judge reading the `focus` surface finds the `criteria` met |
| `file_exists` | `path`; optional `exists` (default true) | A file created during the run matches `path`, or none does when `exists: false` |
| `tool_order` | `before`, `after` | The first call matching `before` comes before the first call matching `after` |
| `baseline` | `baseline_file`, `criteria` | A judge scores the run against the named file |

Five details decide whether a grader measures what its name says:

- **`input_match` is a JavaScript regular expression, not a substring**, and it is tested against
  the call's input serialized as JSON. A Skill call reads `{"skill":"ak:diagnose"}`, so match the
  skill with `'"skill"\s*:\s*"(?:[^"]*:)?diagnose"'` rather than the bare id, which also matches
  any other input that mentions the word.
- **A must-not-call assertion is `min: 0`, `max: 0`, `arm: both`.** Without `min: 0` the default of
  1 makes the grader demand the call it means to forbid.
- **A grader on a tool the case does not grant cannot fail.** Put `tool_used … max: 0` only on a
  tool in `execution.allowed_tools`; otherwise the case already forbids the call and the grader adds
  nothing.
- **`file_exists` sees only files created during the run.** `path` is a glob — `**` spans any depth,
  `*` stays inside one path segment, `?` is one character — matched against the created-file list.
  What a scaffold wrote is not on that list: the host (`claude` 2.1.285, read from its binary)
  lists the working directory after the scaffold returns and again after the run, and grades the
  difference. No run has yet exercised a no-file grader on a scaffolded case.
  Both listings walk every directory, `.git` included, so a no-file grader in a repository case
  that grants `Bash` also counts git writes: a new branch, stash, commit or fetch creates files
  under `.git` and fails the grader although nothing was written to the working tree.
  A file that existed before the run and was edited is not on that list, so "no file was written"
  is `file_exists` with `path: "**"` and `exists: false` together with `tool_used` on `Edit` with
  `max: 0`.
- **`tool_order` fails when either side is never called.** Each side is a tool name or
  `{tool, input_match}`. It cannot express "the skill loads before any write, or nothing is
  written", so give it only to a case whose pass requires both calls.

`arm` takes `with-only` or `both`. A `with-only` grader is an ablation indicator: it reports on the
run with the plugin loaded and is not part of the score. Write the skill-fired grader that way, as
`tool_used` on `Skill` with the `input_match` above and `arm: with-only`. A grader that must hold
whether or not the plugin is loaded, such as a must-not-call, is `arm: both`.

Every `positive` and `adversarial` case carries that skill-fired grader, and
`evals.no-fired-indicator` (`checkFiredIndicators` in `src/validation/graders.ts`) fails a case
tagged either way without one. Without it, a score earned by the host's defaults reads the same as a
score earned by the skill.

A negative does not prove itself by the absence of a Skill call. Both arms pass that grader, and so
do they pass an `llm` grader that accepts "no Skill call, or stopped at the authority step". Write
the negative's decisive grader as `llm` with `focus: trace`: *the session does not carry out the
`<skill>` workflow*, followed by that workflow's concrete side effects (the files it writes, the
commands it runs, the records it publishes). Loading the skill and then stopping at its authority
step, with `needs-input` or with a refusal, passes. When the workflow exists only with the plugin
loaded, set that grader to `arm: with-only`, because the bare arm passes it by construction. Keep the
deterministic no-side-effect graders beside it (`tool_used … max: 0` on the granted Write, Edit or
Bash pattern). A Skill `max: 0` grader stays only on a model-invoked skill's negative.

**A user-invoked skill's positive is a slash invocation.** Only `/ak:<id>` starts a user-invoked
skill (AGENTS.md, "The invocation law"). A request that names the skill in prose does not. So a
user-invoked skill's `positive` prompt begins with `/ak:<id> ` followed by the request, and it is
graded on doing the workflow: the invocation is explicit, so the authority step passes. A prompt
that names a user-invoked skill in prose belongs in a negative. There, the session passes if it
recommends the exact `/ak:<id>` command, or loads the skill and stops at its authority step, and it
fails if it carries out the workflow. A live check on 2026-09-25, with a direct `claude -p` session
on claude 2.1.282, showed that a typed `/ak:<id>` expands on the client: the model follows the
skill, and the run makes no Skill tool call and writes no user stream line for it. So a case whose
prompt begins with `/ak:<its skill id>` carries no skill-fired grader, because that grader would
always fail. The typed command is the invocation, and the workflow graders show that the skill ran.
`evals.no-fired-indicator` exempts such a case. Whether `claude plugin eval` behaves the same way
has not been checked separately; it drives the same host.

A must-not-push grader matches `git\s+push|gh\s+pr\s+(create|merge)`, not `gh\s+pr`, which also
fails the read-only `gh pr view` and `gh pr list` a correct run makes.

**The scoring surface.** An `llm` grader reads its `focus` and a `regex` grader its `target`. Both
accept `last_message`, `trace`, `files`, `mock_calls`, or `{source: file, path}`:

| Surface | What the grader reads |
|---|---|
| `last_message` | The run's final message. The default for both keys |
| `trace` | The run's tool calls and their inputs, in order |
| `files` | The newline-separated list of paths created during the run |
| `{source: file, path}` | The contents of one file the run created |
| `mock_calls` | The calls the run made to mocked tools |

The default is the trap. An `llm` grader whose `criteria` say "no file is created" and that carries
no `focus` is judged on what the run *said*, and passes a run that wrote the file and did not mention
it. Where the claim is about what the run did, write the deterministic form above, or set `focus:
trace`; where it is about a file's contents, `focus: {source: file, path}`. `ak validate` raises
`evals.llm-file-claim-without-focus` (`checkGraderSurfaces` in `src/validation/graders.ts`) on an
`llm` grader with no `focus` whose `criteria` contain one sentence naming both a filesystem object
and a write to it.

The same trap holds for a claim about an action: "the run does not publish it a second time" is
passed by a run that republished and said it had not. `ak validate` raises
`evals.llm-action-claim-without-focus` from the same function on an `llm` grader with no `focus`
whose `criteria` contain one sentence in which a negation or a count governs an action verb
(publish, post, reply, push, merge, open, close, resolve, create, commit, delete, write, call, run,
execute, start, dispatch, send, cut, record, deploy, invoke). The shapes are
a negated auxiliary ("does not publish", "won't merge", "cannot publish"), a bare "never" before a
third-person verb ("never publishes"), a negated passive ("is not posted"), a clause opening with
"no", "nothing", "only one" or "at most one" ("only one pull request is created"), a repeat named
outright ("no second pull request appears", "no duplicate record is produced"), a count after a
governed verb ("is published at most once", "will post it again"), and "rather than" before a
repeat ("rather than publishing a second page"). A count needs the verb governed, because record,
reply, run, commit, call and post are nouns too: "cites the run once" is not a claim. A count also
ends its clause, so "once the checks finish" and "again in its explanation" are not counts. Past
tense is not read, because in criteria it describes the premise ("the seats it did not run"), not
what the run must do. Idioms are not the action, and each is cut as narrowly as it is written:
"call it a regression" but not "call them a second time", "write off the failure" but not "write
off-by-one guards", "start with" but not "start by", "record opinions as findings" but not "record
the finding as fixed", and "never runs through" or "never pushes back", where the particle changes
the verb only in its active forms ("is not run through CI" is still a claim). What follows a
reporting verb ("explains that", "states that") is what the reply says, and is not read; the
exemption ends at the next conjunction or semicolon, so a claim joined after it ("states that the
gate is closed, so no ticket is created") is still read.

Each narrowing trades a false positive for a false negative, and the trade is written down here so
it is made on purpose. A count mid-clause is lost ("posts it again to the thread" is not caught),
and so is a real claim a criterion puts inside the clause "states that" introduces. Both are rarer in the corpus than the
readings they remove, and an unflagged claim is still the author's to aim.

Split a grader that mixes an action with reasoning or with what the reply says. The resumability
cases are where this matters most: every one claims the resumed run reads the target back and does
not repeat a remote effect, and most also claim how the idempotency key is derived. The read-back
and the effect are actions; the key derivation is reasoning the reply states, since no tool input
carries the key. Each goes in its own grader. The action goes in `tool_used` with `max` where the
tool and its input are knowable from the case (`gh\s+pr\s+create` with `max: 1` on a resumed
ship), or in an `llm` grader with `focus: trace`; the reasoning and the reply stay on the default
surface. A split keeps the case's weight: halves sum to the original where integers allow, the
heavier half on the action (2 becomes 1 and 1, 3 becomes 2 and 1), and a grader of weight 1 becomes
two of weight 1.

**Which surface an action claim takes is one rule.** `focus: trace` where a tool the case grants
can perform the action, so the trace can show it happening. In a `needs-fixture` case the tool may
be one the fixture will grant rather than one `allowed_tools` lists today, such as the
knowledgebase's publish tool; the case then says so in a comment above `graders:`, naming the tool,
so the grader's premise is written down where the fixture's author will find it. Where no tool the
case grants, or its fixture will grant, can perform the action, the action cannot happen outside the
reply, and the grader declares `focus: last_message`: a review round run inline in a case that
grants no tool to dispatch one, or a page published in a case with no knowledgebase and no fixture.

Both checks are heuristics with a narrow reach. A claim with no filesystem noun and no governed
action verb, such as "exactly one ticket exists", is not caught, and aiming it is the author's job.
Writing `focus: last_message` explicitly clears either check, and is the author's statement that
the default was chosen.

`tests/grader-lint.test.ts` covers the other direction for the deterministic types. For every
deterministic grader in `evals/` it builds a transcript the grader must fail, and one it must pass
where one can be built, and scores both with `evaluate` in `src/validation/grader-eval.ts`, a local
copy of the host's scoring rules. A grader that no transcript can fail breaks the test. `llm`
graders are judged by a model, so no local transcript can score them: they are covered by the
surface checks above and not by this test. `baseline` graders are covered by neither.

The field names are **measured against the host**, not derived here. `criteria`, `tool` and
`pattern` are what `claude plugin eval` accepted at `claude 2.1.278`, loading the built bundle, and
the fields of the other types were read off the host's loader definition in the same binary. This
section said `expected_outcome` for `llm` until the runner was first pointed at the corpus, and it
refused every case over that one key. `schemas/case.schema.json` and `src/validation/evals.ts` had
both agreed with this section rather than with the runner, so three sources said the same wrong
thing and none of them had ever asked.

**What was wrong was the address, not the name.** `expected_outcome` is a key the host accepts — at
the case root, as free text. Its grader objects are closed and refuse it there, which is where this
section put it. So a check of the form *does the host know this key* answers yes and is no help: the
fields above are correct only at the level they are written at, and nothing in this repository
checks a level.

The figure that records it is **87 of 87**, and the population is part of it: 87 is the bundle, not
the tree. `evals/` ships scoped to the installed skill set, so `profiles/core.yaml` — which excludes
`babysit-pr` and `ultraqa`, holding 17 cases between them — leaves 87 of the tree's 104 in
`dist/claude-code/evals`. All 87 carry an `llm` grader, which is why the one key accounts for every
failure and leaves no case needing a second explanation.

A name on this list is measured only against the version named above, and nothing in this repository
re-takes the measurement or notices when the host moves one: the check that reads these names reads
them from a table, and a table agreeing with this section is the failure that produced the paragraph
you are reading.

Tag every case with the release scenario it exercises, written `scenario-N` with no leading zero:
`scenario-6`, never `scenario-06`. Both count toward coverage — `ak validate` reads the number, not
the spelling — so this is not about the checks. It is that a corpus spelling one scenario two ways
answers a `grep` with a subset that looks like the whole, which is how a false gap report was
produced against this tree and routed to two lanes. `evals.scenario-tag-noncanonical` reports the
padded form. Across the whole catalog the
case corpus must cover **all 24** release scenarios in the plan's "Evaluation and release gates";
`ak validate` reports uncovered scenario numbers. A writer covers the scenarios its dossier assigns
to its batch and reports any it cannot exercise, rather than tagging a case that does not actually
test the scenario.

Case `name` values are unique across the corpus, since the host reports, filters (`--case`) and
publishes results by name. `evals.duplicate-case-name` fails on a repeat. Where the same behavior
repeats across skills, prefix the skill id to the name and leave the directory as it is, because the
directory is the join to `tests[].id`.

**`needs-fixture`: a premise the sandbox cannot supply.** A case starts in an empty repository. When
its prompt presumes state the sandbox lacks (a repository with the named code, a pull request, a
prior review, a knowledgebase record, a run interrupted part-way) and it has no scaffold that builds
that state, tag it `needs-fixture`. Every `resumability` case carries the tag. So does any case whose
pass needs the skill to work on the presumed state, rather than refuse or stop regardless of it. Such
a run stops at `needs-input`, as it should, and its graders fail it, so its score is evidence about
the missing fixture, not about the skill. `unscaffolded`, which older positives carry, says only that
the case has no scaffold. `needs-fixture` is the tag to exclude on. `claude plugin eval` has
`--tag` to include cases and no option to exclude them (checked at `claude 2.1.282`), and it keeps
only the last `--case` it is given. So a run that leaves these cases out goes through
`scripts/eval-local.sh --exclude-tag needs-fixture`, or filters its results by tag afterwards. A
case loses the tag when its scaffold lands, unless its graders still cannot measure the behavior
in the sandbox: a scaffolded case keeps the tag for as long as that holds. Two such reasons are in
use. The pass needs an adapter write the host cannot supply
(`evals/super-bound/approved-direction-produces-spec-and-tickets`), or a no-file grader counts
`.git` writes because the case grants `Bash` in a repository
(`evals/super-ship/lesson-is-drafted-not-published`).

**The local runner resolves Git before entering the eval sandbox.** On macOS, `/usr/bin/git` is a
developer-tool shim whose cache write is blocked in the sandbox. `scripts/eval-local.sh` asks
`xcrun` for the concrete executable outside the sandbox, prepends a temporary directory holding
only a `git` symlink to it to the isolated `PATH`, so nothing else on the host's `PATH` is shadowed,
and records the executable's path in the receipt. Other platforms keep their ordinary
`command -v git` result. The stub host in `tests/eval-local.test.ts` resolves `git` to that
executable through the shim; whether the live sandbox runs it is unverified until the next paid
run exercises a case that commits, and the receipt's summary line says so. A quoted run therefore
names the receipt's Git path as offered, not as exercised; a case still grades the resulting work,
not the mere presence of a commit.

**Running the suite locally.** `scripts/eval-local.sh [claude plugin eval options…]` runs
`claude plugin eval dist/claude-code` and prints a with/without/delta table per case. Build the A1
bundle with `bun run ak build --profile all`: the core profile omits three skills this corpus
targets. On a machine with
Docker Desktop, the sandbox will not start a Bash-granting case while any symlink sits under
`~/.docker`, so the script moves `~/.docker/cli-plugins` and `~/.docker/bin` aside for the run and
restores them on every exit, Ctrl-C included. It runs only when you invoke it; CI does not run evals.
Pass `--max-cost-usd` for a paid run. The script warns when
`dist/claude-code` is older than its sources, and the summary names the commit it measured, marked
`(dirty)` when the working tree had changes; quote that line with any figure. The `fired` column counts
a with-plugin run only when it has with-only graders and passed all of them.

**Isolation and the receipt.** The host already runs every arm with its own scratch home and
configuration, so the operator's settings, hooks, `CLAUDE.md`, plugins, MCP servers and memory
never reach the agent under test. What does reach it is the launching shell's `ANTHROPIC_*`,
`CLAUDE_CODE_*` and `EVAL_*` variables. `eval-local.sh` therefore starts the host under `env -i`
with a short allowlist: home, path, locale, proxies and auth. Add a name to `$AK_EVAL_PASS_ENV` when
a run needs it. `--inherit-env` turns the allowlist off, and it exists only for the control run.
`research/evals/2026-09-25-isolation.md` has the measurement, and `scripts/eval-isolation-probe.sh
on|off` repeats it for about $0.30. A case cannot set `CLAUDE_CONFIG_DIR` or any other non-`EVAL_*`
key in `execution.env`: the host rejects that case's runs. Gated tools a case lists in
`allowed_tools` (`Bash`, `Write`, `Edit`, `WebFetch`, `mcp__*`) reach the agent only through the
host's `--allow-tools`, and that grant applies to every case in the invocation. So the script
groups the selected cases (after `--case` and `--tag`) by their gated tools and runs each group
separately, against a staged copy of the bundle that holds only that group's cases. That way every
case gets exactly the tools it declares. The staging is also how `--case` and `--tag` select: the
host keeps only the last `--case` it is given, so neither flag is passed to it. `--max-cost-usd` is
one budget across the groups. The host checks it as runs start, so runs already in flight can end
past the cap. The host is run with `--keep-temp`, which its help describes as "Preserve scaffold
dirs for debugging"; each trace the host reports is then copied beside the result when it is
still there, and indexed in the receipt, and the scaffold the host kept for that run is removed,
so the copy is the only transcript left. The host also gets a temporary directory of its own as
`TMPDIR`, which the script removes on every exit path, so an invocation that is interrupted or
crashes before it writes a result leaves no scaffold behind wherever the host creates scaffolds
under `os.tmpdir()`. Host 2.1.285 does that on every platform except macOS, where it creates them
under `/tmp` whatever `TMPDIR` says; there a scaffold the host never reported stays as
`/tmp/e-*` until it is removed by hand, because the script deletes only paths the host named and
never lists `/tmp`. Whether a trace survives the invocation's return on the
real host is unverified until the next paid run. The 2026-09-28 rerun ran without the flag, and
its report has no transcripts. The graders that count toward a score are read from the runs, whose
`withOnly` boolean is the mark the receipt reads; a case-level definition carries the same mark
as `config.arm`. When the host stops paying
after the budget is exhausted, it marks the run `skippedPaidGraders` and records each skipped
grader as failed with the explanation `skipped: cost ceiling`, the shape excerpted in
`research/evals/2026-09-28-a1-rerun/budget-skipped-run.json` from that rerun's archived result.
Such a run is reported as ungraded and stays out of the pass/fail denominator unless a grader that
was actually scored failed; an ordinary negative grader verdict remains a graded failure. The
receipt withholds a case's score and delta, and the overall figures, while any run has a skipped
verdict among its score graders, graded or not, because the host's score counts a skipped paid
grader as weight not earned.
The script warns when in-flight work carries the spend past the cap. An explicit `--allow-tools`
overrides the grouping and runs once with that grant.

Each run writes `<result>.receipt.json` beside the JSON result. It records:

- the measured commit and whether the tree was dirty;
- the bundle's path, its content sha256, and whether any source is newer than it (the packager
  writes no build stamp, so that comparison is the freshness check);
- the install configuration and whether `.donors/` was present;
- `claude --version`, the isolation method with the variable names it passed, the resolved Git
  executable offered on the sandbox `PATH` (unverified in the live sandbox until a paid run
  exercises it), and whether the grants came from the cases or the user;
- per invocation: the grant, its cases, the staged bundle's sha256, the exact runner command, the
  exit status, the cost and whether it was partial, or `skipped` when the budget ran out first;
  `incomplete_cases` lists the group's cases that are missing from its result or short of runs, and
  any such case makes the invocation partial. A group whose result holds no case also carries
  `error: "nothing run"`, and the script exits 2;
- the exit status, cost, duration and `partial`, plus `budget` (the `--max-cost-usd` value, or null)
  and `over_budget`;
- per case and arm: total `n`, `graded`, `ungraded`, passes over graded runs, rate and a 95% Wilson
  interval (the same formula as `tests/learn/evals/stats.ts`), plus the fired count;
- every trace's host path and its copy path, which is null when the trace was gone before the copy.

A figure quoted from a run carries that receipt, or the fields of it the figure depends on. The
judge is bound by the runner, and neither the script nor this section names it.

---

## 10. The batch process you are working under

Know your boundaries, because they are what makes the reviewer's pass meaningful.

**A writer receives:** its own dossier from `research/dossiers/`, `catalog.yaml`, this file, the
schemas in `schemas/`, and `policies/resolved-conflicts.yaml`. Nothing else. Not the raw donor tree
beyond the specific pinned files its dossier cites, not another batch's context, not another batch's
drafts. A writer that finds it needs a file another batch owns cites it by path and name and does
not write it.

**A brief cites this contract; it never restates it.** Whoever writes a batch brief names the
sections that govern the work — §3, §12.1, §12.2 — and does not reproduce a heading name, a section
list or a line cap in its own words. Restating creates a second surface. The moment the two disagree
the writer holds two authorities and will reasonably follow the more specific one, which is how a
forbidden heading reaches seven files at once: not writer drift, but a brief quoting a heading the
contract had moved.

Where a brief needs to say something this contract does not, that is evidence the contract is missing
something. **Amend the contract before the batch starts**; never carry the difference in the brief. A
writer that finds this contract underspecified reports the strain and stops, rather than silently
reconciling two instructions — and a writer is never at fault for having followed this file.

**That report has a destination: `CONTRACT-DEFECTS.md` at the repository root.** Append an entry;
create the file if it is not there yet. Mid-batch there is no handback to carry the report, and the
only surface a writer can write is the artifacts it was commissioned to produce — so a correct
diagnosis filed inside one of those lands in a file whose readers are looking for something else.
Root placement is the whole mechanism: the entry appears in the diff of the very commit that would
otherwise bury it, so readership does not depend on anyone remembering a path. **Never file a
contract defect in a commissioned artifact**, however well the comment is written.

An entry records three things, and the middle one is what makes it actionable without re-derivation:

1. **The instruction followed** — the section, quoted.
2. **What following it produced** — the concrete result, named precisely enough to reproduce. "A row
   keyed `target:` is skipped by the parser" is the report; "§5 seems wrong" is not.
3. **What the correct behavior appears to be**, or that the writer cannot tell.

**An entry is committed when it is filed, in its own commit**, and is never carried into the batch
commit. A writer here does not commit, so whoever commits for the batch commits the entry as soon as
it is filed and before the work it blocks. Until that happens the entry exists only in a working
tree, and two of this file's properties are false there: the commit that resolves it cannot delete
what is not in `HEAD`, and `git log -- CONTRACT-DEFECTS.md` does not index it. That loses the
demonstration in exactly the case that proves the mechanism works — a writer who reported a defect
and got a contract fix rather than a workaround. A standalone commit touching one root file is more
visible in a log than a line inside a batch commit, not less.

**An entry is retired by deleting it**, in the commit that resolves it, with the ruling in that
commit's message. An entry is never marked resolved and left in place: a resolved entry reads
exactly like an open one to anything scanning this file, and the blocking clause below cannot tell
them apart. It follows that the file has no resolved section — a heading for retired entries is an
invitation to do the thing this rule forbids, and an empty one reads as a claim that nothing has
ever been found.

Deleting an entry does not lose it. The entry and the ruling are both in the resolving commit, and
`git log -- CONTRACT-DEFECTS.md` is the index of every defect this contract has ever had. The file
says that in one line, because the record is worth little if a reader has to already suspect it
exists: whether a writer who reports a contract defect gets a contract fix rather than a workaround
is the one thing this mechanism has to demonstrate, and an empty list demonstrates the opposite.

**An open entry blocks the next dispatch, not the batch commit.** Without a block the file degrades
into a suggestions box, which is the failure it exists to prevent: the defect that prompted this
rule was reported correctly and nothing was obliged to read it. Ruling may mean amending the
contract, or recording that the instruction is right and the writer misread it — both close the
entry. Neither is the writer's to decide, and a writer that filed one is not waiting on its own
judgment.

The clause blocked the batch commit until `05a431d`, which landed 45 files with an entry open at
`05a431d^`, and nothing noticed. It lost three ways. It obliged no one to read, because a writer
unable to commit is not a reader. It held the batch's work in a working tree, which is the state the
filing rule above spends its length arguing against — the same harm one level over. And it contested
`commit early`, the run's resume model and an explicit line in a batch brief, which is the collision
this section already describes: a writer holding both follows the more specific, and a clause that
loses that contest every time is not a rule. Dispatch is where the cost lands, and this section had
said so before the clause was written — the stale reference-pack entry above cost nothing *only
because that batch had not been dispatched*.

**Dispatch is not the brief.** Batch 4's brief was written at `76e57ba`, before batch 3 handed back
and saying so; the dispatch was `76099ab`, nineteen minutes later. The block attaches to the act
that starts a downstream writer, not to preparing that writer's instructions, or it either forbids
writing a brief in advance or is discharged by one that predates the entry. The reconciled rule is
the one that held: `57ea582` ruled eighty-eight seconds before `76099ab` dispatched, with nobody
aware the written clause said something else.

**The retirement rule failed before it had a detector, and the way it failed decided the shape of
the one it now has.** The commit that resolved the reference-pack entry wrote §12.5, which answered
it, and left the entry standing; the entry then stood blocking a batch on a gap that no longer
existed, and cost nothing only because that batch had not been dispatched. Nothing failed, because
nothing was looking — a resolved entry and an open one are the same bytes. The obvious check, a
commit message that rules on an entry the commit does not delete, would have been silent here: that
commit's message never mentioned the entry. This was not a writer declining to retire one. It was a
writer who did not notice there was anything to retire.

**So the check is on the entry, not on the commit.** Every entry quotes the instruction it is filed
against, and a quotation is a fingerprint of the text it was taken from. **An open entry's quoted
instruction must still resolve in the section it cites**, compared with whitespace collapsed so that
rewrapping a paragraph is not a change. When one stops resolving, the entry and this contract
disagree about what this contract says: either the defect was fixed and the entry owes retirement,
or the section moved for another reason and the entry now misdescribes the contract. Both need a
ruling and neither is the writer's. **Repointing the quotation at the new text is not among the
options** — it is the same act that made the entry stale, and it destroys the evidence that anything
moved. A quotation that never resolved fails the same rule at the commit that files it.

**The match is scoped to the cited section, not to the file.** A quotation that has migrated out of
the section the entry names is still somewhere in this file, so a file-wide search passes it — while
the entry now points at a section that does not contain what it quotes, which is the defect rather
than an escape from it. The scope is stated rather than implied because implying it was not enough:
this rule was written and then implemented file-wide by the same hand, inside one day. An entry that
names no section the check can resolve fails this rule rather than falling outside it: a checker
that widens to the whole file when it cannot find the scope restores the loose behaviour exactly
where the entry gave it least to work with, which is `required-lane-failure-is-unavailable`'s *fail
closed when required evidence is absent*, applied to a checker rather than to a lane. Failing closed
is not the same as matching strictly, and the two are easy to confuse here: a citation may carry a
gloss its heading does not, so resolve on the section number and ignore the rest of the reference.
An implementation that compares the whole rendered citation manufactures the unresolvable case it
then has to fail.

**Both of those rules are gated, at `d87f9e9`.** `src/validation/defects.ts` performs them and
`ak validate` seats it. The retirement rule is checked structurally rather than lexically, which is
the only way it can be checked at all: a resolved entry reads exactly like an open one, so nothing
in an entry's wording is detectable, and what is detectable is the file growing a second entry list.
`defects.entry-outside-open` fires on any entry outside `## Open` whatever the heading is called,
and `defects.retired-section` names the heading itself, for the case above that carries no entry to
be seen — an empty retirement section. The entry-quotation rule is
`defects.entry-quotation-dangling`, with `defects.entry-citation-unresolvable` for an entry naming
no section this file has, `defects.entry-unquoted` for one quoting nothing, and
`defects.contract-unreadable` when the section index cannot be built at all. Those three are the
fail-closed cases the two paragraphs above argue for, gated rather than described.

**`defects.entry-population` prints on every run and says the word vacuous.** `## Open` is empty
here, so the live run reports zero entries and zero quotations and would merge green with the
comparison inverted, with the scoping removed, or with the check deleted. Saying so in the output is
what stops a clean run being read as coverage, and it puts the rule about a grep finding instances
and never proving their absence inside the instrument rather than leaving the reader to supply it.
The blindness below is stated there too, for the same reason.

This is the reviewer's recorded-revision gate pointed at the defects file instead of at a review,
and it fails on the same thing: silence, not movement. What it asks for is a ruling, not stillness.

**What it does not catch.** It sees a defect resolved by editing the section the entry quotes. It is
blind to one resolved from outside this contract — a new origin category in the provenance map, a
validator rule changed — because the quoted instruction still resolves and nothing in this file
moved. That has already happened: an entry filed against §5 was answered by a category added
elsewhere, with §5 untouched and the check silent. Resolution from outside leaves no fingerprint
here, so no state check on this file can find it, and the blocking clause and a person are what
close it. The check is not a reason to leave an entry alone.

**A known gap is recorded as a probe, not as a prose entry.** A gap a check can express is filed
under `research/probes/` as a probe that exits 1 while it is open and 0 once it closes, the
convention `research/probes/unowned-template-documents.ts` already follows. A probe is self-retiring
in the way this section demands of an entry: it cannot be resolved and left standing, and it cannot
describe a gap that is no longer there. A list of known gaps does both, which is why this package
has none — a stale survey is read as a current one, and that is worse than silence. Prose is correct
only where no probe can exist, and there the sentence to write is that no detector is possible and
why, as this section does for a defect resolved from outside the contract. A probe that cannot run
is neither 1 nor 0 and says so rather than exiting clean, for the reason this section gives about
entries: an answer that costs nothing to produce is not evidence.

**Not every probe is a gap record, and the exit code is where the difference is stated.** A probe
commissioned to report rather than to gate exits 0 on the thing it reports:
`research/probes/scenario-coverage.py` exits 0 on an uncovered scenario, because coverage there was
ruled a report. Reading the convention above as reaching that file would convert a ruling into a
defect. What both kinds owe is the other direction. A probe that has lost its grip on a source — a
section it can no longer parse, a populated input contributing nothing — exits 1 whatever the tree
says, because the figures underneath it are not worth reading; that is the probe reporting on itself
rather than on the tree, and nothing in the output distinguishes the two unless the exit code does.
Key that guard on the source having members, never on the tally being zero. A guard keyed on the
tally reproduces the fault it was added to catch.

**A list of enforcement claims is a gap record with the sign flipped, and §11's first half is one.**
The rule above forbids a prose survey of known gaps, because a stale survey is read as a current
one. Run the argument with the polarity reversed and it reaches §11's *Decided by the commands
above*: a hand-maintained list of positive claims about what `ak validate` performs, kept in prose,
beside the enforcement rather than derived from it, updated by whoever remembers. It has already
produced the failure that shape produces. Four ids sat in it — the ten required sections, their
order, insertions between them, the anti-rationalization table — and for a skill body nothing under
`src/` performed any of them: `checkBodyShapes` seated the check that emits them over `protocols`
and `roles` only, and `SKILL_SECTIONS` occurred nowhere in the tree. They moved to the other half,
the seating landed, and they moved back. That round trip is the shape working as designed and it
left the shape unchanged: the list that put them in the wrong half is still hand-maintained, and the
next claim to go stale in it will go stale the same way.

**The gate is coverage, not existence, and the existence version reads green on exactly the claims
that are wrong.** Those four ids are all emitted under `src/` — three of them fire for role bodies
as well as protocol ones — so a check resolving each id a claim names against the ids the tree can
emit would have passed on every one of them, and passed for the reason the claims were wrong: both
confuse *this rule exists* with *this rule is enforced for a skill*. What separates the two is a
case. **For each rule id claimed in §11's first half there is a skill body correct in every respect
but the one that id names, on which `ak validate` emits that id.**

Three properties, because each is a way the obvious implementation stops discriminating. The case
**must be minimal in the respect under test** — a body violating two rules at once proves neither,
since either id satisfies the assertion. The id **must be asserted present, not the run asserted
failing**: a mutated body will fail for some reason against a corpus this size, so a gate watching
the exit code returns the same answer under both hypotheses. And the case list **is derived from
§11's bullets, not written beside them** — a hand-maintained list of cases checking a
hand-maintained list of claims is this same defect one level up, and the copy nobody updates is the
second one.

**Nothing in `src/` performs this either.** It is recorded here rather than left to whoever next
reads §11, because a claim a check could express and no check performs is what the paragraph above
says to record; and the failing version is written down beside it so that the gate someone builds is
not the one that reads green on the bullets it was built for.

**A check that cannot complete owes the reason it could not, and the generic catch is where that
obligation is usually lost.** `src/validation/run.ts` wraps every check so that one failure does not
stop the run, and reports the cause under `check.threw` as `(cause as Error).message`. A throw that
is not an `Error` — a string, a rejected value, whatever a library hands back — has no `message`, so
the report reads *threw undefined*: a blocking error that has destroyed the only evidence about why
it blocked, in the one code path whose entire purpose is to preserve it. Ten sites in `src/` test
the value before reading `message` and five cast it, so the safe form is already the house idiom and
the exceptions are not deliberate. Whatever a check does when it cannot finish, it may not emit a
message guaranteed to be uninformative in exactly the case it exists for.

**A check known to be wrong is not a gate.** Where a validator rule has been ruled incorrect, whoever
ruled it tells the writers currently authoring against it — not only the person fixing it. A writer
that complies with a broken gate by weakening its own output has done nothing wrong; it followed the
only authority it had. The failure belongs to whoever knew the gate was wrong and left the writer
working against it.

**A writer that can only satisfy a check by removing verified information reports that instead of
complying.** Weakening an artifact to make a check pass is the same failure as weakening a check to
make an artifact pass: the direction differs, the lost property does not. A donor path the validator
resolves against the pin is a *record*; the same path moved into a field nothing parses is only a
*claim*. State the conflict in the batch report and leave the artifact intact — the instinct runs the
other way, because complying with a gate feels like discipline.

**A reviewer follows** that does not see the writer's narrative — only the produced files, the
dossier, this contract, and **any prior findings against this batch, with their fingerprints and
evidence**. It cannot be told "I checked that already"; it re-derives.

That last item is not optional and not the writer's to withhold. **Independence from the author is
mandatory; amnesia is not** (ruling `reviewer-continuity-not-amnesia`). A second-cycle reviewer that
is denied the first cycle's findings is not more independent, it is less useful — it re-derives what
was already established instead of checking whether it was addressed. A continuing reviewer may
retain its own finding context; a replacement receives a durable prior-finding packet. What
independence forbids is inheriting the *author's* account, never the prior findings themselves.

**A handback has two audiences with different entitlements, and the batch owner is the filter.**
This section entitles a reviewer to prior findings with their fingerprints and evidence and, in the
same breath, denies it the writer's narrative. One handback file is routinely both. A writer's note
recording that they examined something and concluded it was fine is, in form, a documented *I
checked that already* about a body the reviewer is about to verify — so handing the file over
breaches the exclusion and withholding it breaches the entitlement. The contract named one artifact
that has to be simultaneously delivered and denied.

The routing: the narrative goes to whoever owns the batch, and anything real in it reaches the
reviewer as a finding carrying a fingerprint and evidence. A reviewer declining to read the writer's
file is not refusing information, it is refusing the form the information arrives in — a narrative
cannot be re-derived and a finding can. What a writer may not take from this is that the note was
theirs to keep. **A finding a writer declines to raise is not filtered, it is dropped**, and the
filter sits at the batch owner rather than at the writer for exactly that reason.

**A reviewer reads the working tree and records the revision it read.** A review pinned to a revision
that has since moved is judging a batch against a contract the batch never saw, and it will report
requirements that did not exist when the work was done. So the reviewer states the revision in its
report, and **the contract does not move under a review in progress without the reviewer being
told.** Whoever lands a change during a review owns telling them, the same way whoever rules a gate
incorrect owns telling the writers working against it. This is the previous two rules pointed at the
reviewer instead of the writer: a review measured against a moved baseline is a check known to be
wrong, and a reviewer is never at fault for having read the revision it was given.

**Stating that duty is not enough, and this section is its own evidence.** It asks whoever lands a
change to assess their own diff, which is where it fails: a change described in good faith as a
reword also moved a character inside a verbatim-mandated quotation, under a live review, and the
materiality note that accompanied it did not mention the string. So the reviewer's recorded revision
is machine-readable, and the gate this section specifies is that a file the review covers, moved
past that revision with no notice recorded against the newer one, fails. **Nothing in `src/`
performs it**, and the obstacle is a missing field rather than a missing check: the word *notice*
appears nowhere in `schemas/`, `policies/` or `catalog.yaml`, so a gate written today would read
nothing and pass. That is worse than no gate, and it is why this one did not land beside the other
two at `d87f9e9`. The other half of the field is absent in a way a search cannot show. `covered`
occurs seven times in `schemas/review.schema.json` and every one is `lanes[].state`, the enum
`covered | skipped | unavailable` recording whether a seat ran — lane coverage, not which files the
review read. The nearest candidate, `delta_scope.affected_surface`, is omissible in two places and
describes what the change affects rather than what the review covered. So whoever re-checks this
disclosure greps `covered`, finds seven hits and concludes the field is declared: the disclosure is
right and the obvious check of it returns the opposite answer. That is §5's rule about where a
figure is published, in the direction where the token is present and the thing it names is not, and
a disclosure survives a repair cycle only by being re-checkable. Until this paragraph is deleted,
its sentence describes a gate that does not exist, and it was found the way the other two were: a
reviewer diffing `git log` by hand, after seven commits touched this file during their pass — one of
which rewrote the row they were filing against — with nothing failing.

**The gate is silent movement, not movement.** Movement during a review is legitimate and happened
repeatedly while this section was being written; the notice is what makes it safe. A check that
failed on movement alone would make the duty unperformable, and an unperformable gate gets turned
off.

**Recording the revision does not pin what was read, and in a shared tree those are two objects.**
The rule above has the reviewer read the working tree and record the revision. Where several seats
write that tree, the revision names one thing and the bytes read are another. Measured on
2026-09-21: `bun run ak validate` returned one error and then zero on consecutive runs with nothing
changed by the seat running it, the difference being another lane's files mid-edit. A receipt naming
a revision but taken from the working tree is evidence for neither — not for the revision, whose
contents it did not read, and not for any state a reader can return to. Taken from an extract,
`git archive <rev> | tar -x`, the revision and the contents are the same object again.

**Which is why recording the revision means naming the instrument: "no errors" is three claims in
one sentence.** `AGENTS.md`, *Receipts name their instrument*, sets out the three, which of them is
a receipt, and what restoring the donors takes; it binds every seat, so it is referenced here and
not restated. What follows from it for this section is only that the revision alone does not
identify what was measured, so a reviewer records both. The figure quoted below was taken with the
donors present — 0 errors, 17 warnings, 39 notes at `4e45481`, all 155 donor rows checked and
passing — and re-derives through `research/probes/validate-figure.sh 4e45481`, which is that
convention in executable form.

**That zero is controlled, which is the only reason it is quoted here.** Changing one row's cited
path in one fragment to a plausible rename raises `provenance.source-not-at-pin` at error severity,
so the check ran against the 155 rather than finding nothing to look at. The donors are gitignored
and reproducible from `provenance/upstream.lock.yaml`, which is what makes the third instrument
re-derivable rather than a property of one machine — and a shallow clone would break it in a way
that reads differently, since a row unverifiable for want of the commit is not a row citing a bad
path.

**A receipt about a commit's own contents can only name that commit, so it is provisional until the
commit is published.** The figures above are pinned to `4e45481` because a measurement *of the tree*
can choose a published revision. A receipt *for the change in hand* cannot: the sha it has to name
is the one being created. So it is re-derivable by whoever holds that commit and by nobody else
until it is pushed, and in a repository that orphaned a published commit this week that is a real
gap and not a formal one. It closes on publication, and the seat that publishes is the seat that
closes it — one more reason the readiness statement travels in the commit message rather than in a
file, where it arrives with the object it describes.

**A citation into the tree names its subject, not its line number.** A `<file>:<line>` locator is
displaced by every insertion above it, and the insertion that displaces one most often is a comment
added over the code it points at — the lowest-perceived-blast-radius edit in this repository, and
the one nothing reviews for downstream effect. So cite code by its text, a section by its heading, a
sentence by quoting it. `const row = manifest.hosts[host]` in `src/packaging/plan.ts` survives the
comment, the reordering of the functions around it and the growth of the file; a reader who cannot
find it learns that the code changed, rather than being sent to a line that is now something else. A
line number is admissible only where the number is itself the claim, and it then carries the
revision it was taken at, by the rule above.

**Dating a wrong locator is worse than leaving it undated.** Measured over
`research/briefs/carried-forward.md` at `f817abe`, whose 24 such citations — 23 distinct — were
resolved one at a time against the revision each entry names: ten resolved to the text their
sentence claimed; three resolved exactly, to findings that had since been closed; three resolved
exactly at `cd48f14` and to unrelated text at `4e45481`, the revision their own entry declares,
because the pin was written when the entry was closed over numbers taken when it was opened, and
re-pinning is an edit to one sentence that does not re-resolve the locators beneath it; six resolved
to unrelated text; one resolved to text that falsified the claim attached to it. An undated line
number announces that it is undated. A wrongly dated one reads as audited. The conversion is what
surfaced the closed three and the false one, for the reason that is the whole argument for the form:
**a by-text citation cannot be written without opening the file, and opening the file is the
check.**

This file's own citations were converted under the rule. All thirteen of them resolved correctly at
`f817abe` first, so the change here is preventive rather than a repair — which is the state the rule
is for, since a locator is exposed from the moment it is written and not from the moment it breaks.

**Two rules in this section still specify a check with no gate, and each says so in its own
paragraph.** The retirement rule and the entry-quotation rule were gated at `d87f9e9`; the
recorded-revision rule and the §11 coverage rule were not. **Each disclosure retires on the commit
that lands its own gate**, deleted there with the ruling in the message. They did not retire
together and this paragraph is the proof: of the three written before `d87f9e9`, two went and one
stayed, and the §11 rule was specified after. A reader who takes those two deletions as covering the
rest arrives at the state the disclosures exist to prevent — believing a check runs because the
section stopped saying it does not — and that reading is available now rather than hypothetically,
which is why the count is written out here instead of being left to be inferred from which
paragraphs survive.

**A handback lists every donor file the writer cited that its dossier did not name.** Following a
dossier's citation into the pinned clone and finding adjacent material is expected: it is how a
dossier's coverage limits get discovered, and it is not an exception to justify. The list exists
because the reviewer re-derives from the dossier, so material the dossier never named is material the
reviewer cannot miss — artifact and packet still agree once it is gone. The delta is what makes that
loss visible.

**Two different obligations in this section are spelled the same way: delivered, and durable.** A
record is *delivered* when its consumer is the pass it was written for — a reviewer reads it, acts
on it, and the question it answers is not asked again. A record is *durable* when it answers a
question that can be asked after the batch closes, and a clean checkout is then the only place it
can be asked from. This section routes both to the handback and distinguishes neither, which is why
the distinction has to be made here rather than by whoever files one.

The discriminator is not importance. **A record that discharges an obligation must be
distinguishable from the obligation never having been discharged**, and that is a property of where
it is filed, not of what it says. Where both states leave a reader the same trace, the record is in
the wrong place however complete it is — which is this contract's own argument about vacuity,
applied to a filing decision instead of to a check.

Three obligations routed to the handback are durable by that test, and each says so in terms this
contract already uses. A candidate pair recorded as examined and not a family (§12.2) answers a
question outliving every seat involved, and §12.2 states the equivalence itself: an unexamined
candidate is indistinguishable from a declared non-family. A donor file cited that the dossier did
not name is provenance, and §5 is the argument for why provenance outlives its author. The
prior-findings packet is durable because `reviewer-continuity-not-amnesia` promises a replacement
receives a *durable* prior-finding packet — the ruling's own word — and a replacement can arrive at
any time, including after the batch that produced it has closed. Each of the three is filed where
its own question is already answered, below.

**No mention of the handback in this contract names where it lives, and that is the mechanism
underneath everything above.** Every mention assigns it work; the set of mentions naming a path, a
directory or a filename is empty. A destination never named defaults to wherever the writer puts it,
and it defaulted to the one tree that does not survive a clean checkout — so the durable obligations
were not filed carelessly, they were filed nowhere in particular, which is a different failure with
a different fix. How many mentions there are is not the evidence and moves whenever these sections
are edited; it moved while this defect was being reported. The evidence is that the naming set is
empty, which a grep settles and which stays settleable as the contract grows.

**There is deliberately no single destination, and no handbacks directory.** One sink for every
durable obligation is what turned one bad choice of path into the loss of all three at once. A
tracked directory with the same topology repairs today's instance and preserves the failure mode, so
the next misroute is again wholesale. Each obligation instead goes where its own question is already
being answered:

- **A candidate pair examined and ruled not a family → `provenance/conversation-map.yaml`.** Already
  the working mechanism rather than a new one: `frontend-races-vs-design-lens-boundary` and
  `design-lens-vs-frontend-races-boundary` are recorded there reciprocally, each naming the other
  seat by catalog id. §12.2's backward-reaching escalation lands here as well, which is what keeps
  it from needing a file of its own.
- **A donor file cited that the dossier did not name → the provenance fragment.** Already the
  mechanism and already tracked, and §5 is the standing argument for why provenance outlives its
  author. A writer used it for this without being told to.
- **The prior-findings packet → `research/reviews/`.** The one of the three with no existing home,
  which is why it reached for an ignored path. Its consumer is a replacement reviewer in a later
  cycle or a later batch, arriving with nothing but a clean checkout — precisely the reader the test
  above describes. `research/briefs/` already holds writer-facing inputs; this is the
  reviewer-facing mirror of it.

**A fourth obligation is checked against the test, not filed beside whichever of the three it
resembles.** Three paths with the rule that produced them removed is a list that grows by
resemblance, and growth by resemblance is how a single ignored directory became the destination for
all three in the first place. `research/reviews/` itself was created for one narrow reason and is a
destination now because it was ruled one, not because it accumulated the role — a directory that
becomes a convention through nobody writing down that it was not one repeats the original defect
with a tracked path instead of an ignored one.

**At most two fix-and-verify cycles after the first pass** (ruling `two-fix-cycles-then-stop`). The
third does not run. It **stops with an explicit blocked-or-replan decision and the open findings
attached** — a decision that is recorded, not a loop that quietly ends. An open item in a batch
report is a normal, expected outcome; a stub committed to make a report look clean is a fabricated
completion and is treated as one.

**Repeated failure is a signal about the plan, not an invitation to a third loop** (ruling
`two-fix-cycles-then-stop`). A batch that fails twice is evidence about the brief, not about the
writer's output, and this contract gives that evidence somewhere to go: the replan branch is a
contract defect (above), filed with the two cycles as its record. A writer that reads the cycle
limit as a verdict on its own work will report and stop where it should report and escalate. Where
the replan lands on a materially changed baseline, that is a new review scope with its own first
pass rather than a third delta loop (ruling `delta-baseline-reset-not-third-loop`).

**Authoring and review are separate passes.** A writer never approves its own output, and never
merges a reviewer's fix and a fresh revision into one indistinguishable edit.

**Recorded for batch 2.** §12.2's adjacency rule for `## Not this seat` is a preventive, not a proven
fix — it was written before any panel larger than three seats had been authored. If batch 2's roles
still restate each other's boundaries under it, the panel needs **one central boundary table that the
roles reference**, rather than each role carrying its own copy. Escalate there; do not widen the
heading and do not let the seats enumerate each other.

**The trigger has two channels, and `## Not this seat` is only one of them.** The other is
panel-wide preconditions restated per seat — a shared snapshot condition, a shared contamination
rule, a shared return vocabulary — which surface under `## When it has nothing to say` and are
invisible to a bullet count on a different heading. This channel is the one that scales worst: a
condition the panel's protocol already states, copied into every seat, is one copy per seat, and
each of them reads as compliant the whole way. **A precondition the panel's protocol already carries
is cited, not restated** — the seat states its own return for that condition and points at the
protocol for the condition itself. Where a seat must restate it to be usable standalone, that is the
signal the protocol and the panel have drifted apart, and it escalates to the same central-table
remedy.

**Measure the sibling-seat trigger on sibling-seat entries only.** The trigger is roles restating *each other's*
boundaries, which is kind 1 in §12.2 and nothing else. A role's non-seat and cross-layer entries are
unbudgeted, and pooling all three kinds into one bullet count turns a compliant role into an apparent
breach. Batch 1's seven roles each name two or three sibling seats — well inside the bound, not at
its edge — so the batch-1 evidence does not reach this trigger. A structural change of this size is
made on the kind-1 count or not at all.

---

## 11. Before handing a skill back

```bash
bun test                 # units, plus the invalid-case fixtures that must fail
bun run ak validate      # catalog, schemas, frontmatter, links, provenance, denylist
bun run ak build         # validates, then writes dist/ for every host
```

Then confirm by reading the file, not by remembering that you wrote it. The list is in two parts
because most of it was never yours to check. Hand-verifying what the commands above already decided
is the cost §9 names, and an undifferentiated list imposes it on every bullet to reach the few that
need it.

**Decided by the commands above.** Read these when one of them reports, not before.

- The ten required sections are present, in order, with nothing inserted between them, and
  `## Hard gates` carries an anti-rationalization table — `body.missing-section`,
  `body.sections-out-of-order`, `body.section-inserted`,
  `body.missing-anti-rationalization-table`.
- `SKILL.md` ≤150 lines, hard cap 300 — `budget.skill-over-target` warns, `budget.skill-over-cap`
  fails.
- Frontmatter carries spec keys only and `name` equals the directory — `frontmatter.unknown-key`,
  `frontmatter.host-key-in-canonical`, `frontmatter.name-mismatch`.
- A donor-origin entry has at least one provenance row, and every row's cited path exists at the
  pin — `provenance.missing-adaptation`, `provenance.source-not-at-pin`. The two quantifiers differ
  and the difference is the point: the second is universal over the rows that exist, the first is
  existential over the entry's directory. A directory of ten adapted files carrying one row passes
  it with nine unattributed. Per-file coverage is §5's rule and stays the writer's, so this is the
  one bullet in this list naming an obligation the commands above do not discharge.
- Three or more eval cases exist, one of each required kind — `evals.too-few-cases`,
  `evals.missing-case-kind`, both blocking.
- Nothing in the body links to a file the bundle does not carry — `links.broken-bundle`.

**Not checked by anything. This is the part of the list that is yours**, and each entry says what
the nearest instrument does instead, so that a clean run is not read as an answer to it. Most are
unreachable by any instrument there could be. Where an entry is instead waiting on a gate it names
the condition that retires it, and an entry here naming none is claiming there is nothing to wait
for.

- **The table's rows come from recorded failures.** The gate sees that a table exists. Whether its
  rows were invented to fill it is §3.1's question, and no tool can reach it.
- **Every artifact in `## Outputs` names a schema and a KB operation, not a repository path.** The
  section's presence is gated; nothing reads its contents.
- **Every `remote_side_effect` names its idempotency key source and read-back.** The `sideeffects.*`
  rules check that the prose names the declared effects and that no grant is wider than the skill it
  covers. No rule reads a skill body for an idempotency key.
- **Every ruling the body touches is cited by `id`.** `rulings.uncited-restatement` is a warning,
  not a gate, and `rulings.restatement-scan-coverage` reports its own recall in the run: of eight
  restatements found in this repository without it, it reports two. A clean run is evidence about
  that instrument and not about the body.
- **Every donor file cited that the dossier did not name is recorded where §10 sends it.** Nothing
  reads the dossier's file list against the body's citations.
- **The eval cases are tagged with the scenarios they cover.** `evals.uncovered-scenarios` is a
  note; §10 records why coverage here was ruled a report rather than a gate.

For a protocol, a role, a reference-pack or a domain-pack body, §12 replaces this checklist — §12.4
for the first two, §12.5 for a reference pack, §12.6 for a domain pack.

---

## 12. Protocols, roles and loose doctrine files

§1–§11 are written for skills. Five further body shapes exist in this package: protocols (§12.1),
roles (§12.2), loose doctrine files (§12.3), reference packs (§12.5) and domain packs (§12.6). Two
of them are batch 1's entire output.

What all five share: none is human-invocable, none appears in a host command surface, and none
carries host frontmatter — no `disable-model-invocation`, no `argument-hint`, no `allowed-tools`.
The packager emits host frontmatter for `skills` alone (`src/packaging/plan.ts`), and
`policies/invocation.yaml`'s statement `protocols-and-roles-are-not-entrypoints` states the rule for
the first two by name, as `packs-never-start-a-phase` does for domain packs. §5's provenance law,
§6's ruling citations, §7's prohibitions and §8's writing standard apply to all five unchanged.
**§1 does not.** Its size rule and progressive disclosure reach protocols, roles and domain packs
unchanged; §12.3 and §12.5 each say what §1 does and does not mean for the shape they govern.

### 12.1 Protocols

`protocols/<id>/PROTOCOL.md`, one directory per catalog entry.

Shared phase logic invoked **by skills**. A protocol is what a skill's phase operation delegates to,
which is exactly why it is not an entrypoint: it has no human trigger of its own.

One naming trap before you start. The invocation law quoted in `AGENTS.md` reproduces the design
brief verbatim, and that brief called `tdd` and `attach-pack` model-invoked *skills*. This package
classifies both as **protocols** — `catalog.yaml` is authoritative, no id is both, and `scout`,
`standards-review` and `spec-review` were likewise renamed or became roles. Take the section from the
catalog, never from the quoted law.

**There is deliberately no `protocol.schema.json`.** `schemas/` contains none, and none is missing.
A protocol has no execution contract of its own because it is never invoked directly — it runs
inside the contract of the skill that invoked it. Do not write a `protocol.yaml`. **The protocol's
catalog entry plus its prose is the contract.**

Required sections are §3's ten, with one substitution:

| §3 section | For a protocol |
|---|---|
| `## When to use` | **Required**, reframed: which skills invoke this, at which point in their phase. A protocol declares no trigger phrases — triggers belong to the invoking skill |
| `## Not for` | **Required.** The boundary against the neighbouring protocol |
| `## Authority` | **Replaced by `## Invoked by`**: the skills and phase operations that may call it. A protocol holds no authority of its own and never widens the authority it was called with (ruling `entrypoint-phase-operation-split`; protocol `phase-operations`) |
| `## Inputs` through `## Limits` | **Required**, unchanged |

§3.1's anti-rationalization table is required under `## Hard gates`. Protocols are where steps get
skipped: `tdd`, `apply-findings` and `review-delta` each exist because a recorded run skipped one.
§3's completeness rule applies here unchanged, and the skipping is why: a step this protocol refuses
to skip is a gate in that section even when `## Not for` or a table row already says so, because the
section is where a reader is entitled to find every condition that stops the protocol.

Long material goes behind `protocols/<id>/references/` on §1's rule.

**Five of those obligations are gated, and this section named none of them.** The required sections
and the `## Authority` → `## Invoked by` substitution are `PROTOCOL_SECTIONS` and
`PROTOCOL_FORBIDDEN` , both in `src/validation/bodies.ts` , raising `body.missing-section` ,
`body.sections-out-of-order` and `body.forbidden-section` ; the remedy text the gate prints for
`## Authority` cites the same ruling the table above cites, so the two cannot drift apart in
silence. A `protocol.yaml` raises `body.sidecar-forbidden` , from `FORBIDDEN_SIDECAR` in the same
file. A `## Hard gates` section present but carrying no three-column table raises
`body.missing-anti-rationalization-table` . Length is `budget.body-over-target` and
`budget.body-over-cap` , through `BUDGETED` in `src/validation/budget.ts` , whose `protocols` row
names that pair and not the `skill-over-*` pair §1 names. One directory per catalog entry is
`catalog.directory-without-entry` .

Naming them is not decoration. A section stating a machine-checked obligation and naming no gate
sends a writer to verify by hand what `ak validate` already refuses, which is the direction §10
argues is the harder one to catch: a contract claiming less than it enforces reads as conservative
rather than wrong.

### 12.2 Roles

`roles/<path>/ROLE.md`, one per catalog entry. `<path>` nests at most one level — the core roles sit
at `roles/<id>/`, the panels at `roles/code-review/<seat>/`, `roles/doc-review/<seat>/` and
`roles/plan-review/<seat>/`. The catalog ids already carry the slash, so the id and the path are one
string: `code-review/security` is both. There is no separate path-naming step, and no
`role.schema.json` for the same reason there is no protocol schema.

A role is **a prompt the runner fills a seat with**. It is not an agent, not a skill, and not a
procedure. It states what the seat judges, the evidence it must cite, what it may never do, and what
it returns when it has nothing to say.

Required sections are a role-specific set, because §3's headings describe a procedure and a role is
not one:

| Heading | What goes in it |
|---|---|
| `## What this seat judges` | The one question this seat answers. One sentence |
| `## Not this seat` | The adjacent seats **and non-seat steps** this one would be mistaken for, and what belongs to them. Three or four *sibling seats*, not the whole panel, plus unbudgeted non-seat and cross-layer entries — below |
| `## What it must be given` | What must be true of the seat's input before it may judge at all. An obligation on the caller — below |
| `## Evidence it must cite` | What the seat must point at for a finding to be admissible |
| `## Never` | The seat's prohibitions. Four rows are governed: two mandatory, two conditional — below |
| `## What it returns` | The finding shape, and the explicit empty return |
| `## When it has nothing to say` | The conditions under which empty is the correct answer |
| `## Rationalizations this seat makes` | The excuses this seat will make, and where each one sends it instead. §3.1's three columns — below |

The order is the seat's arc: what it is, what it is not, what it is handed, how it grounds in that,
what it may never do, what it gives back, the empty case, and the rationalizations. Evidence is drawn
from what the seat was given, which is why `## Evidence it must cite` follows
`## What it must be given` rather than preceding it.

**On length.** §1 governs protocol and role bodies unchanged, and the validator measures them:
`BUDGETED` (`src/validation/budget.ts`) includes the protocol and role sections, and a body over
target raises `budget.body-over-target`. §1 says what follows from that, including that a body over
target is not a defect and is never shortened to clear the number. Report an unusual length in the
handback; do not re-derive §1's rule here.

The heading set below is **descriptive of what these bodies need, not a bound on their length.** A
role longer than its neighbours is not over anything: §1's target and cap are the only lengths that
bind, and §1 says what to do about them. Eight headings is a lot for a body this size, and the two
that grew the set from six earn their place the same way. A seat has two hardest failure modes:
**judging something it should never have accepted**, and **talking itself past a prohibition**.
Neither had a home, so the material leaked into whichever neighbouring section sat closest — a
precondition stretched into `## Not this seat`, a stale-input constraint filed under
`## Evidence it must cite`.

Dropped, and why — a writer reaching for one of these is describing the wrong thing:

- `## Authority` — the runner seats a role; a role never self-authorizes. Whether a seat is filled at
  all is decided by declared risk, not by the seat (ruling `panel-composition-by-declared-risk`).
- `## Workflow` — a prompt is not a procedure. Procedure belongs to the protocol that convenes the
  panel.
- `## Hard gates` — reaching for it means you are describing the protocol that seats this role, not
  the seat. A gate stops a workflow, and a seat has no workflow to stop. §12.1 gives `## Hard gates`
  to protocols precisely because a protocol *is* a procedure. The anti-rationalization table lives
  under its own heading below, **never** under this one.
- `## Inputs` — a seat states what it must be *given*, which is a contract on its caller. A protocol
  lists the inputs it consumes. The difference is who is bound.
- `## Side effects` — **a role has none.** A writer declaring one has put work in a role that belongs
  in a skill or a protocol.
- `## Limits` — folded into `## Never`.

`## Not this seat` names only the **adjacent** seats — the ones whose findings would land in this
seat's output if the boundary blurred. Three or four neighbours, not every other seat on the panel.
A panel where each seat enumerates all the others is quadratic and unmaintainable, and it degrades
worst exactly where the boundaries matter most. A seat that cannot name its neighbours in three or
four does not have a sharp enough question, which is a finding about that seat rather than about
this heading.

Four kinds of confusion belong in this heading, and the budget above governs **only the first**.

1. **Sibling seats on the same panel.** The adjacency rule above. **Budgeted — and the three-or-four
   count is over sibling seats, nothing else.**
2. **Non-seat steps** — synthesis, dispatch, the closure decision, the authority check, the author of
   the rule the seat applies. These are not seats, and "the verdict belongs to synthesis" is a
   `## Not this seat` entry even though synthesis is not a seat. A writer reading *adjacent seats*
   strictly would leave out the step a seat's output is most often mistaken for. **Not budgeted.**
3. **Same-named seats at another layer.** A different error from the other two: not a blurred
   boundary but a reader who has the wrong file open. **Required, and not budgeted.**
4. **Seats in another panel that are not counterparts** — `reviewer-spec` naming
   `plan-review/critic`, `plan-review/planner` naming `implementer`. Neither a sibling nor a twin:
   a seat whose output could be mistaken for this one's across a stage boundary. **Not budgeted, and
   each must name the confusion it prevents.** That sentence is the entry's whole justification, and
   without it this kind has no natural limit — every other seat in the package is a candidate, and
   any of them can be argued adjacent to any other.

**Kind 1 means same-panel, and the three-or-four cap counts only those.** A seat in another panel is
kind 3 or kind 4 and is never charged against it.

**Every exemption in this section is from the bullet count, and from nothing else.** "Unbudgeted"
means the entry does not consume one of the three or four sibling slots; it does not mean the entry
is free of length. No entry here is exempt from the file-length target, and that target is enforced
against role bodies today rather than someday: `BUDGETED` (`src/validation/budget.ts`) lists `roles`
beside `skills` and `protocols`. No role body is over the target at present, so the firings on a
given run are on skills and protocols; the wiring is what makes this enforcement rather than
intent. §12.2 states this correctly where it borrows §1's rule, which is what makes describing it
here as a possible future a defect rather than a difference of emphasis. If a role is ever over a
length bound, **a required entry is not what gets cut** — dropping a mandated `## Never` row or a
declared counterpart to fit a line count is weakening the artifact to satisfy a check, which §10
forbids outright. The material to cut is prose the contract does not require. This is what keeps
the cap doing the work it was written for: sibling enumeration is what grows quadratically with
panel size, and cross-panel entries do
not.

Kinds 2 and 3 are exempt for the same reason, and it is the reason the budget exists at all. Every
seat enumerating every other is quadratic — but **only kind 1 is quadratic.** The non-seat
boundaries are a small fixed set, the same size for the smallest panel in this package as for the
largest, and the cross-layer entry answers a different question from the whole section. Charging a
writer for either penalises precisely the entries this heading most needs.

**So count sibling seats when you check the cap.** A reviewer counting total bullets is measuring a
list that does two jobs and will read a compliant role as over budget.

A seat whose name matches or nearly matches a seat in another panel names that counterpart in
`## Not this seat` and states what distinguishes the layers. This entry does not count against the
three-or-four budget, because it answers a different question from the rest of the section. Make it
compete and the writer trades a genuine sibling boundary for it, which is the budget doing the wrong
work.

A seat cannot be trusted to notice its own twin — the twin sits in a panel this writer may not be
authoring. So resolve the counterparts against `catalog.yaml` rather than from memory. The families
that exist today:

| Seat | Counterpart at another layer |
|---|---|
| `code-review/security` | `doc-review/security-lens` |
| `doc-review/security-lens` | `code-review/security` |
| `reviewer-standards` | `code-review/project-standards` |
| `code-review/project-standards` | `reviewer-standards` |
| `code-review/adversarial` | `doc-review/adversarial-document`, `plan-review/critic` |
| `doc-review/adversarial-document` | `code-review/adversarial`, `plan-review/critic` |
| `plan-review/critic` | `code-review/adversarial`, `doc-review/adversarial-document` |
| `reviewer-spec` | `code-review/previous-comments` |
| `code-review/previous-comments` | `reviewer-spec` |
| `code-review/maintainability` | `doc-review/scope-guardian` |
| `doc-review/scope-guardian` | `code-review/maintainability` |

**This table is not complete, and a seat's absence from it is not a finding that it has no
counterpart.** Not every seat is named here. Some counterparts are only visible while
the seats are being written, so completeness is a handback obligation rather than a property this
table can claim — see below. What the table does guarantee is that what it *does* declare is
consistent in both directions.

**Every pairing is stated in both directions, and a new pair is added as two rows or it is not
added.** A reader arrives from whichever file they happen to have open, so a one-directional pairing
is a coin flip on whether the boundary is stated at all — and the direction that gets omitted is the
one nobody was holding when the row was written. A family of three is three rows naming two each.
This table had the defect it exists to prevent: the `security` and `standards` pairs were entered one
way round, which left the reverse naming missing from the two seats that had not been authored yet.

**Unresolved candidates.** These pairs are suggested by the seats' catalog summaries and have not
been confirmed. Each is resolved by the writer who authors either seat **while that seat is still
open**, in one of two ways: promoted into the table as two rows, or recorded in the handback as
examined and not a family, with the distinction that separates them. Leaving one unresolved is not
an option, because an unexamined candidate is indistinguishable from a declared non-family.

| Candidate pair | Why it is a candidate |
|---|---|
| `doc-review/feasibility` / `plan-review/architect` | Both judge whether a proposed approach holds up structurally. Resolved by the second route: examined and recorded as not a family (`feasibility-vs-plan-review-architect-distinction`, `provenance/conversation-map.yaml`). |
| `doc-review/design-lens` / `code-review/frontend-races` | Both concern interaction states and UI flows — one as missing design decisions, one as race potential. Possibly adjacent rather than same-named. |

**A pair that reaches backwards into a closed batch is a contract defect routed to the earlier
batch's fix cycle.** The writer who finds such a pair owns reporting it and never owns fixing the far
side. A later writer amending an earlier body is editing a file it was never given, under a brief
that never covered it, producing an edit that neither batch's reviewer will see against its own
dossier — the batch boundary is what makes a handback reviewable, and a cross-batch edit dissolves
it. The report names both seats and the distinction the writer believes separates them; the earlier
batch's fix cycle writes the bullet, because a seat's own writer is the one who can say what that
seat is not.

**Both of those rows were resolved, and this section said one of them was not.** All four seats
are `status: authored`, so the window specified above — while that seat
is still open — has closed for both pairs. For `doc-review/design-lens` /
`code-review/frontend-races` it closed with the work done. `roles/doc-review/design-lens/ROLE.md`
and `roles/code-review/frontend-races/ROLE.md` each carry a committed bullet opening *"Examined and
adjacent rather than the same seat,"* naming the other by catalog id and spelling out the
distinction, and `provenance/conversation-map.yaml` carries the reciprocal records
`frontend-races-vs-design-lens-boundary` and `design-lens-vs-frontend-races-boundary`. That writer
took the handback route and left the durable trace as well, unprompted.

`doc-review/feasibility` / `plan-review/architect` was described here as the row with no trace. It
has two. `roles/doc-review/feasibility/ROLE.md` carries the bullet naming the other seat and the
confusion it prevents, and `provenance/conversation-map.yaml` carries
`feasibility-vs-plan-review-architect-distinction` with `disposition: retained`, an acceptance test,
and an `amalgam` locator naming both seats — the second of the two routes above, taken in full. The
one asymmetry, that `roles/plan-review/architect/ROLE.md` does not name the other seat back, is what
that record says it is: *"this row has no partner on the architect side: the finding is that the
pairing does not exist."* A pair examined and found not to be a pair leaves the second side nothing
to declare.

The equivalence this section reasons from holds in general — a pair resolved only in a handback and
a pair never examined leave a clean checkout the same trace, which is none. What failed was the
example. Both candidates took a durable route, so the tree held no instance of the failure, and this
section named a row that had one anyway.

**Where the earlier batch has no fix cycle left, the pair escalates instead of routing.** The rule
above sends a backward-reaching pair to the earlier batch's fix cycle and assumes one is open. Once
that batch is closed and its cycles are spent there is nowhere for it to land, and the reason the
rule gives — that a seat's own writer is the one who can say what that seat is not — has no writer
left to reach. The obligation converts rather than lapsing: the finder records both seats and the
distinction against this table as a contract defect under §10, and it stays open there. Reopening a
closed batch to write the bullets is a batch-plan decision belonging to whoever owns that plan, and
is never taken by the writer who found the pair, for the reason the paragraph above gives about
cross-batch edits. An open contract defect naming both seats is the correct resting state, and it is
not the same trace as the pair never having been examined — which is the whole distinction this
table exists to keep.

**A seat that finds a pair this contract does not declare files a contract defect (§10).** It is not
a body defect, and the writer does not quietly add the bullet and move on: the counterpart is in
another panel that another writer may be authoring from the same table, and a pair recorded in one
body and not the other reproduces exactly the asymmetry the table is checked for. The table is the
specification; a discovery amends the specification.

Batch 2's handback reports every pair it found, including the ones already declared, and every
candidate it resolved. That report is what makes the census auditable — without it, a seat with no
counterpart bullet is silent about whether it has no counterpart or whether nobody looked.

Each seat in the adversarial family names every other, not just one counterpart. The standards pair
needs the most care, because those two seats carry conditional `## Never` row 4 in identical words —
two seats judging against a project standard at different layers, with the same prohibition text,
are the most confusable pair in the catalog rather than the least.

Resolve the counterpart in `catalog.yaml` before describing it. A seat that a parallel panel *ought*
to contain is not a counterpart, and describing its concurrency model or verdict vocabulary invents
unfalsifiable detail about a seat that does not exist — worse than no entry, for a reader who opened
the file precisely to tell two seats apart.

**Notation, and it is what makes the invention unwritable: a bullet that refers to a seat names that
seat by its `catalog.yaml` id, in backticks.** A kind-3 bullet leads with the counterpart's id. A
bullet that carries no id is a kind-2 non-seat boundary — the synthesis step, the closure decision,
the ticket author — and it must not be phrased as a seat. Prose describing a seat is how an invented
counterpart gets written: an id would have had to resolve, and a description never does.

Two shapes are legitimate and a checker must not flag them. A sibling in **this** seat's own panel
may be named without an id when the id would be the seat's own — a second instance of the same role
is *the other seat*, not a different one. And a bullet may lead with a collective noun as long as the
seats it covers are named by id inside it. What is never legitimate is naming another panel in prose
with no id anywhere in the bullet, which is exactly the shape an invented counterpart takes.

`## What it must be given` is the one heading that **states an obligation on the caller** rather than
on the seat. `## Never` binds the seat's behavior; this binds whoever seats the role. Hold that
distinction and the section stays small; lose it and it absorbs material belonging to four
neighbours.

Write it as bullets naming the artifacts the seat must receive and **the binding that makes each one
trustworthy** — a hash, a revision, a packet — never a procedure for obtaining them. A seat that
explains how to fetch its input has started writing a protocol.

It pairs with `## When it has nothing to say`, and that pairing is what earns it a heading: a seat
whose input no longer binds **returns `unavailable` rather than judging a stale artifact**.

**That heading covers two kinds, and writing them as one is what produced the error above.** A seat
that ran and found nothing returns empty, and empty is the correct answer:
`roles/doc-review/adversarial-document/ROLE.md` puts it as a deep pass that finds nothing returning
nothing. A seat that could not be given required context that still binds returns a result which
blocks, and `required-lane-failure-is-unavailable` governs that case in terms — a lane that could
not be given its required context returns `unavailable`, which is a result rather than an absence,
is never downgraded to an empty result and is never backfilled. This contract routed the second kind
into the word the first kind owns, which is the one thing the ruling forbids.

The vocabulary is not a single token, and the bodies establish the range. Every role body but
three returns `unavailable` under that heading. The three that do not are the core roles:
`roles/supervisor/ROLE.md` returns no choice, `roles/implementer/ROLE.md` returns `BLOCKED`, and
`roles/plan-review/planner/ROLE.md` returns the missing input. The ruling binds all three and all
three satisfy it, because what it requires is a result that blocks and is never read as assent
rather than a particular word — and all three carry the ruling itself, as the same `## Never` row,
in `roles/implementer/ROLE.md`, `roles/plan-review/planner/ROLE.md` and
`roles/supervisor/ROLE.md`. What no seat may do is leave the same trace for *found nothing* and
*was given nothing* — the discriminator §10 applies to records, applied to returns.

That last citation replaces a worse one. This paragraph first said each of the three wrote the
non-assent guard out, and one does: `roles/supervisor/ROLE.md` closes *"An empty return from this
seat blocks its checkpoint. It is never read as assent"*. `implementer` has the blocking token and
no guard, `plan-review/planner` has neither. The sentence generalised from the body it had open, and
the property it generalised was the one thing two of the three do not contain — which is the shape
to watch for, because a universal reached for after reading one member is indistinguishable in the
writing from one measured across all of them. The `## Never` row is the better ground for the same
conclusion: it is in all three files, under a heading a reader can go to, and a reader can refute
it.

It also sits next to `## Evidence it must cite`, and the same artifact routinely belongs under both.
From `roles/reviewer-spec/ROLE.md`:

| Heading | The row |
|---|---|
| `## What it must be given` | The prior-finding packet: each finding's id, `fingerprint`, the disposition and evidence recorded when it was raised |
| `## Evidence it must cite` | The finding id and `fingerprint` it is continuing, and the revision it is now checked against |

The test that sorts them: the first binds the **caller** — hand this over or the seat cannot start.
The second binds the **seat** — point at this or the finding is inadmissible.

Four `## Never` rows are governed. Two are mandatory in every role. Two are conditional, and the
condition is a closed list rather than the writer's judgment.

**Mandatory, verbatim in every role body:**

1. **Only independent verification closes a finding.** Reading a patch is the author's confidence,
   not a receipt, and no seat closes what it produced (ruling
   `closure-requires-independent-verification`).
2. **A lane that could not run, could not be given its required context, or failed, returns
   `unavailable`, and says why.** That is a result, not an absence. A required lane that is
   `unavailable` **blocks approval**; it is never downgraded to an empty result and never backfilled
   by the author, the implementer, another seat or the synthesis step (ruling
   `required-lane-failure-is-unavailable`).

**Conditional, required exactly where the condition holds:**

3. **Never edits: it judges and returns.** Carried by every seat except the two that produce an
   artifact. `implementer` and `plan-review/planner` carry the converse instead, naming what the
   seat writes and stating that it never writes a finding, a receipt, a review record or a ticket,
   and never closes or approves what it produced.
4. **Standards grounding.** Two seats judge against a project standard: `reviewer-standards` and
   `code-review/project-standards` (the catalog's only `tier: standards-gate`). They carry *"cites an
   actual project rule or returns empty; an absent standard is never an invented preference."* This
   row is **not** an instance of ruling `required-lane-failure-is-unavailable` and does not cite it.
   No ruling states it; §12.2 does. The two seats are reached by different routes:
   `code-review/project-standards` is read from the catalog tier, and `reviewer-standards`
   carries no tier and is named in `NAMED_STANDARDS_SEATS` (`src/validation/bodies.ts`), so a later
   seat that acquires the tier picks this row up without that file changing.

Beyond those four, **each seat writes its own grounding rule as its own row**: what it may not assert
without being able to point at something, in its own terms — the spec source, the charter, the frozen
snapshot, a cited source, the proposed driver, its own self-check. That is the seat's prohibition,
never an appendix to a sentence addressed to a different seat.

Two rules govern how mandated rows are written, because ignoring either produced the defect above.

**A mandated row cites a ruling only for what that ruling's text actually says.** Read the row in
`policies/resolved-conflicts.yaml` before citing it. A clause you cannot find there is contract prose:
write it without a citation, and then check whether it belongs in a conditional row instead — a
clause that does not generalize is usually a clause that was never universal.

**Mandate only what is verbatim-identical in every role body.** Everything else is guidance, and
guidance produces rows in the seat's own words. A universal row that needs a bespoke per-seat
instantiation is the welded form returning: the invariant part gets enforced, and the part that must
vary is load-bearing and unchecked.

**"Verbatim" is the gate's word too, and this paragraph used to deny it.** `UNIVERSAL_NEVER_ROWS`
(`src/validation/bodies.ts`) stores each mandated row as a ruling id plus a list of substrings, and
`role.missing-universal-never-row` fires when no row in the body contains all of them. This
paragraph used to stop there and conclude that a body carrying Row 2's two fragments beside the
citation would pass while stating none of the rest. It does not. The substrings are the locator that
pairs a body's row to its ruling, not the test: the universal rows carry `bar: "block"`, and the
comparison is string equality against the block form of §12.2's own published item, read out of this
file while the check runs. An absent row raises `role.missing-universal-never-row`; a row that is
present and shortened raises `role.never-row-not-verbatim`. Two rule ids, because the gate
distinguishes the two states.

So the clauses this paragraph called unchecked — that a required lane which is `unavailable` blocks
approval, that it is never downgraded to an empty result, the four parties who may not backfill it
(ruling `required-lane-failure-is-unavailable`, cited because this paragraph restates its clauses
and a citation in the row above does not reach it) — are enforced byte for byte as part of the
block. Write the row out in full because the gate accepts nothing less. The instruction was right
and the reason given for it was false, which is the harder direction to catch: a contract claiming
less than it enforces reads as modesty, and only running the gate contradicts it.

This is §9's disclosure in the opposite direction and it is the worse one. A section understating
its enforcement makes a reader redo work the gate already did; a section overstating it makes a
reader skip work nothing does. The second does not surface the way the first does, because reliance
on an over-strong claim fails silently — the gate still passes, so nothing reports and the writer
who trusted the word is never contradicted. Assume this direction is under-found rather than rare.

**Byte-for-byte governs a row reproduced as a block; a row quoted inside a sentence is punctuated to
its host.** Rows 1 and 2 are set as a numbered block and are carried as they stand. Row 4 is a
quotation embedded in a sentence, so a body that bolds its lead clause, or ends it with a period
where this section uses a semicolon, is not in breach. What decides it is the form the mandate takes
here, not which row is being carried.

`## Rationalizations this seat makes` comes last, after `## When it has nothing to say`, and carries
§3.1's table unchanged: the same three columns, `The thought | Why it is wrong | Do this instead`, no
prose around it, and the same rule that a row invented to fill the table is worse than a shorter
table. Two things differ for a role:

- **The rows are the *seat's* rationalizations, not the calling skill's** — "we both picked the same
  option and we are both confident, so this proceeds", "I can see the fix is correct, so the finding
  is closed", "the standard is not written down but everyone knows it". The third column sends the
  seat somewhere deterministic; it never tells the seat to try harder.
- **A row naming a ruling cites it in §6's markdown form**, at the sentence that invokes it,
  wherever in the row that sentence sits. Naming a column stated a position where a relation was
  meant: a row whose ruling sentence stands in `Do this instead` while `Why it is wrong` says
  something else would, followed literally, credit that ruling with a rule it does not state.

This heading is **required, not optional**. A seat with no rationalizations to name has not been
thought about hard enough, so an empty table is a signal to revisit the seat rather than a section to
leave out.

### 12.3 Loose doctrine files

`protocols/invocation-authority.md` is a **file, not a directory**, and has **no catalog entry**. The
catalog's protocol entries do not include it, and that is correct: the plan's tree places it exactly
there, in the plan's repository tree (`research/sources/engineering-skills-repo-plan.md`).

This is safe rather than an oversight. `ak validate`'s directory-without-entry check lists
*directories* under each section root and never examines a loose `.md`
(`src/validation/completeness.ts`, rule `catalog.directory-without-entry`). A loose doctrine file at
`protocols/` root is therefore not an orphan, and **adding a catalog row for it would be the error,
not the fix.**

**Which trees hold doctrine, and why the rest do not.** The doctrine walk — `looseDoctrineFiles`
in `src/validation/rulings.ts`, behind `rulings.doctrine-unreachable` — reads the five directory
sections — `skills/`, `packs/`, `protocols/`, `roles/`, `references/` (`DIRECTORY_SECTIONS`,
`src/catalog/layout.ts`) — and the repository root. Not the check in the paragraph above:
`catalog.directory-without-entry` never reads the root, and naming it here sent a reader to a file
where the behaviour is absent. `research/` is in neither list, so markdown there raises nothing.
Until this paragraph that was a consequence of which list the walker iterates rather than a
decision anybody made, and `rulings.doctrine-unreachable` already cites this section for it.

The exclusion is correct, and the criterion is standing rather than subject matter. **A tree holds
doctrine when something in it could win a conflict with this contract.** `research/` holds inputs to
authoring — a dossier, a brief, a source, a probe, a review record — and a brief is subordinate by
construction: batch 3's own brief states that where it and this contract disagree, this contract
wins and the brief is the defect. Something built to lose every conflict must not be bindable by a
ruling, because binding it grants exactly the standing it was built not to have, and a `binds` block
naming a brief would make that brief citable against a body.

So the question for a new directory is not whether its files read like doctrine. It is whether a
ruling could bind one of them without that being an error. If it could, the directory belongs in
`DIRECTORY_SECTIONS` and its contents need catalog entries; if it could not, it belongs outside, and
the reason belongs here rather than in the walker's iteration order. **A directory added without
answering that question inherits whichever answer its list already gives, silently.** That is what
this paragraph converts into a decision.

The exclusion reaches every depth, which is the part most likely to be assumed rather than checked.
The walker is only ever called with the five section names, so nothing under `research/` is examined
at any depth and a new subdirectory there — `research/reviews/`, for instance — inherits the
exclusion without anything having been decided about it. Depth is not where the question gets asked.
The directory is.

**The two edits are not equally risky, and the dangerous one is the edit that adds reach.** A new
directory left outside the lists is silently invisible: nothing walks it, so nothing complains, and
the omission keeps indefinitely until someone asks. A new name in `DIRECTORY_SECTIONS` is the
opposite. It is the only edit that puts a tree inside the walk, so it confers doctrinal standing on
every file underneath at the moment it lands, over files written by people who were never asked the
question. Adding a name to that list is the change that has to answer the criterion above first;
leaving a directory out of it is the change that can wait to be noticed.

Root markdown is the walk's other non-catalog surface, and it is why `README.md` and
`CONTRACT-DEFECTS.md` stand as warnings rather than passing quietly: a file at the root is reached
by the walker and has no catalog entry to be reached through. Leaving such a file unbound is
allowed. What it costs is stated by the rule itself — the file is excluded from every citation count
rather than passing them, which is §10's distinction between a discharged obligation and an
undischarged one, arrived at from the other side.

A loose doctrine file carries shared doctrine that several protocols cite. It has no required section
list, no frontmatter and no sidecar. It is prose, and §8 governs it.

**§6's citation rule binds it too, and nothing checks that it does.** A loose file has no catalog
entry, so no ruling's `binds` block can name it and no `binds`-derived check can reach it. That makes
it the one place in the package where a restated rule is invisible to the tooling — and restating is
exactly what a doctrine file is for, since its whole job is to say something several protocols lean
on. So the obligation is the writer's alone: **where a doctrine file states a rule that a ruling
already decides, it cites the ruling, and it states the rule at the ruling's full width.**

The second half is the one that fails quietly. A restatement that drops a clause reads as complete,
and a reader with no citation cannot discover that it is not — there is no link back to check
against. The clauses that get dropped are the non-obvious actors and the edge conditions, which are
the clauses the ruling exists to pin down; the obvious half of a rule was never the part in dispute.
When a sentence would be awkward at full width, cite the ruling and defer to it rather than shipping
a narrower version of it.

### 12.4 Before handing a body back

Every §12 shape whose catalog entry has a body file routes here. Where a shape skips a bullet, its
own section says which (§12.5, §12.6).

- The body file is the one your section names. Whether that name is mandated or merely preferred is
  `MANDATORY_BODY_SECTIONS` (`src/catalog/layout.ts`), and the difference is the severity of
  `catalog.unexpected-body-name`: for a mandated section a differently named body is an **error**
  and the directory does not validate; elsewhere the same rule reports a warning. A warning here
  means unenforced, not optional.
- No frontmatter. No `*.yaml` sidecar.
- For a role: the two conditional `## Never` rows are the right ones for this seat (§12.2). The
  heading set can be complete and the rows still wrong — row 3 takes its authorship form from
  whether this seat produces an artifact, and row 4 belongs only to the two standards seats. A seat
  carrying a row written for a different seat is a defect, not a harmless extra prohibition.
- For a role with a same-named counterpart at another layer: `## Not this seat` names it and says
  what separates the layers (§12.2). Resolve the counterpart in `catalog.yaml` — this is the entry a
  writer authoring one panel is least able to check from memory.
- Every ruling whose `binds` block in `policies/resolved-conflicts.yaml` names this protocol or role
  is cited in the body. That block is the machine-checkable inverse of §6: it tells you before you
  write which rulings you owe a citation.
- Adaptation rows are written as a fragment under `provenance/adaptations.d/<batch>.yaml`, keyed
  `path:` (§5). **The merged `provenance/adaptations.yaml` is generated output and is not the
  writer's to produce or update** — `ak build` writes it and `ak build --check` holds it in sync in
  the gate. A `provenance.adaptations-out-of-sync` failure against a correct fragment is a build that
  has not been run, not a defect in the batch: report it and leave the fragment alone.
- Every donor file cited that the dossier did not name is listed in the handback (§10).
- Authoring a body makes that entry's `status: contract` stale and raises
  `catalog.status-behind-body`. **`catalog.yaml` is owned outside this batch — report the entries you
  authored and let its owner flip them to `authored`; do not edit it yourself.**

### 12.5 Reference packs

`references/<id>/REFERENCE.md`, one directory per catalog entry.

Shared material that skills load **mid-task**, named in the loading skill rather than reached by a
trigger. This is the top-level form of the mechanism §1 describes inside a skill directory, and the
two are not interchangeable. §1's `references/` belongs to one skill and ships inside it; a pack
here has its own catalog entry, is shared, and is loaded by the skills that declare it.

**`loaded_by` is the defining property, not a convenience.** `schemas/catalog.schema.json` requires
it on every reference entry, and `ak validate` enforces it twice — a pack naming no loader fails,
and a loader that is not a declared skill fails (`RULE_REFERENCE_LOADER`,
`src/validation/configrules.ts`). That list is the pack's entire access surface. A reference pack is
never an entrypoint, never appears in a host command surface and is not human-invocable. Note where
that rule is written: `policies/invocation.yaml`'s `protocols-and-roles-are-not-entrypoints` names
two shapes and a reference pack is not one of them, so the statement that binds here is the
schema's. Do not cite the invocation statement for a reference pack; it does not reach it.

No frontmatter and no `*.yaml` sidecar. The packager emits host frontmatter for `skills` alone
(`src/packaging/plan.ts`), so there is nothing to declare and nothing to suppress. §9 does not reach
a reference pack either: a reference entry has no `tests[]` and is not a skill, so it carries no
eval obligation and authoring one is not a reason to add cases.

**§1's numbers do not apply, and no other number replaces them.** A reference pack *is* the long
material §1 sends behind the limit, so capping it at §1's target would defeat what it exists for.
`BUDGETED` (`src/validation/budget.ts`) measures skills, domain packs, protocols and roles, and a
reference pack is deliberately absent from it. That is not licence to dump. The pack is loaded into a live context
by every skill in `loaded_by`, so its length is paid by each of them at the moment of loading:
material earns its place against the skills that name it, or it does not belong in the file.
Progressive disclosure still applies — it is the mechanism this shape serves.

**There is no required section list.** §12.1 and §12.2 mandate heading sets because a protocol and a
seat each have one fixed job. The packs declared so far do not: a vocabulary, a set of modelling
questions, a principles catalogue and a prose rubric have no shape in common worth forcing. Organise
the pack for the skills in `loaded_by` and say what it is for in its opening lines. **Do not infer a
required heading set from a sibling pack** — the first one authored is an example of one pack's
material, not a template, and the second writer to treat it as one manufactures a convention this
section declined to create.

**What separates this from §12.3.** A loose doctrine file has no catalog entry, which is the premise
§12.3 reasons from: no ruling's `binds` block can name it, no `binds`-derived check can reach it,
and a rule restated there is invisible to tooling. A reference pack has an entry. A ruling's `binds`
block **can** name it, so §6's citation rule is machine-checkable here and §12.3's argument does not
transfer. Check your pack's id against the `binds` groups before deciding a ruling is irrelevant to
you — the same obligation a protocol or role body carries.

Before handing one back, §12.4's checklist applies with its two role-specific bullets skipped. The
body file is `REFERENCE.md`, and §12.4's body-file bullet governs what a differently named one
costs. `MANDATORY_BODY_SECTIONS` (`src/catalog/layout.ts`) takes its membership from the shapes §12
gives one body file, which is the criterion to reason from rather than the list to read: this
section gives a reference pack one, and §12.6 gives a domain pack one. Do not restate the membership
here. A contract sentence that tracks where a validator has got to is a sentence that goes stale the
day it catches up, and §12.4 is written so that the severity follows from the criterion without
either file naming the other's contents.

**Domain packs are a different shape and §12.6 governs them.** Do not reason about a `PACK.md` by
analogy from this section: the two shapes differ in how they are reached, in whether §1's numbers
apply, and in whether a heading set is mandated, and each difference runs the opposite way.

### 12.6 Domain packs

`packs/<id>/`, one directory per catalog entry, with exactly this shape:

```text
packs/pack-api/
├── PACK.md          # The body: what the pack adds, when it attaches, its constraints and lenses
├── pack.yaml        # The manifest (schemas/pack.schema.json)
├── tests/           # One fixture directory per pack.yaml tests[] entry
└── references/      # Long material, on §1's rule. Omitted when empty
```

A domain pack is what the `attach-pack` protocol attaches to a phase that is already running:
constraints on the work, and lenses for the review panel. It is the other half of the pair §12.5
separates. A reference pack is reached because a skill names it in `loaded_by`; a domain pack is
reached because the artifact in front of the phase earned it, and no skill names it. It is never an
entrypoint, never an operation, never starts a phase and is never project-scoped —
`policies/invocation.yaml`'s statement `packs-never-start-a-phase` and its `packs` block say the
first three, and `schemas/pack.schema.json` fixes `starts_phase` and `project_scoped` to `false`.
That statement names this shape, so a pack body cites it where §12.5 tells a reference pack not to.

**Pack text is evidence a reviewer cites, never an instruction anyone obeys.** A constraint that
reads like "skip this check" or "begin the migration" is quoted, not followed; `attach-pack` holds
that as a hard gate. Write constraints as conditions a reviewer can check the work against, and say
so in the pack's opening section.

**Attachment is by artifact kind plus semantic signal, never by file extension alone.** The schema
makes the weaker rule unwritable: `activation_rule` requires non-empty `artifact_kinds` and
`semantics`, `paths` may only narrow a rule that already has both, and
`pack.activation-requires-artifact-and-semantics` (`src/validation/configrules.ts`) checks it again.
Write each `semantics` entry in the words a task would use — "an existing public response field
changes type", not "api". A classifier is optional for every pack (`classifier_optional` is
`const: true`), and what a pack does when the evidence is ambiguous is fixed by which pack it is:

- `pack-api`, `pack-data` and `pack-secure` attach. Security, API and data facts are never dropped
  because a classifier was uncertain (ruling `panel-composition-by-declared-risk`). This binds the
  selector a phase runs under `protocols/attach-pack/PROTOCOL.md`. `ak attach` does not implement
  it: it selects only on a sufficient built-in signal, so a subject whose only evidence is
  ambiguous is reported as not attached. Separately, `ak attach` has no switch that turns any pack
  off, because its signal table is code, not configuration.
- The other five may decline, and the decline is recorded with its reason in the
  `attachment_record`'s `rejected` list. A decline with no recorded reason is not a decline; it is a
  pack that silently failed to attach.

`research/dossiers/packs.md` proposes carrying this as an `on_uncertain` key. Do not write one.
`activation` closes with `additionalProperties: false`, so the key fails `schemas.document-invalid`,
and the rule is fixed per pack rather than configurable by it. The statement lives in
`## Attaches when`.

**`pack.yaml` is the schema's, and this section does not restate it.** `schemas/pack.schema.json`
fixes the required members, the positive-and-negative floor on both `activation.examples` and
`tests`, the constraint `kind` vocabulary, the `sensitive_action` an `authorization-required`
constraint names, and the provenance block's donor and conversation arms. A manifest that breaks
any of them fails `schemas.document-invalid`. Three things are this contract's:

1. **The file is `pack.yaml`.** `src/validation/schemas.ts` also validates a `manifest.yaml` when
   one exists; do not write one. A pack directory with no `pack.yaml` raises
   `body.pack-manifest-missing`.
2. **The ids are shared with the body.** Every `activation.rules[].id` appears in backticks under
   `## Attaches when`, and every `constraints[].id` under `## Constraints`. An `attachment_record`
   cites rule ids and a finding cites a constraint, and a reader holding either has to land on the
   sentence that states it. Nothing checks this.
3. **A manifest carries no signals and no switch.** The schema admits neither an `enabled` key nor an
   `activation.signals` list, so a manifest carrying either fails validation, and `ak attach` reads
   neither. Its classifier-free lookup is the built-in signal table in `src/attach/signals.ts`,
   which is code and is not edited from a pack batch. Each signal names every
   `activation.rules[].id` its observation is evidence for, and a selection cites the union of the
   ids its sufficient evidence names. A rule no signal can observe is listed in
   `SEMANTIC_ONLY_RULES` there, with the reason. `tests/attach.test.ts` fails when a rule has
   neither a sufficient signal nor an exemption, or when a signal names a rule the pack does not
   state, so adding or renaming a rule id needs a change to that table too. The `matched_rules` in
   a pack's `expected.yaml` are a phase selector's reading of the whole change, semantic rules
   included, and are not `ak attach` output.

**Required sections, in this order, at `##`.** §12.5 declined a heading set because reference packs
share no shape. Domain packs do: the schema requires the same members of all eight, and each member
has one section to be stated in.

| Section | What it holds | From `pack.yaml` |
|---|---|---|
| `## What this pack adds` | The constraint category, and the two statements every pack makes: its text is evidence, and it never starts a phase | `summary` |
| `## Attaches when` | Each activation rule by id: its artifact kinds, its semantics, what the selector must observe before it fires. Then what the pack does on ambiguous evidence | `activation.rules`; `activation.examples` that attach |
| `## Does not attach when` | The non-triggers, including the boundary with a neighbouring pack or skill that shares the ground | `activation.examples` that do not attach |
| `## Constraints` | Each constraint by id and kind. An `authorization-required` constraint names its sensitive action. Each names the most permissive `autofix_class` (`schemas/finding.schema.json`) a finding raised under it may carry | `constraints` |
| `## Reviewer guidance` | Each lane by role id, what the pack asks it to look at, and whether attaching makes it required | `reviewer_guidance` |
| `## Project facts` | What the pack deliberately does not carry, and where a project's own numbers and conventions are read from instead | `kb_rules` |
| `## Rationalizations this pack counters` | §3.1's three-column table, unchanged | — |

§3's insertion law applies: extra `##` sections may follow the table, and none may be inserted
between required ones. Three headings are rejected by name, each because it describes the wrong
thing. `## When to use` — a pack has no trigger of its own; its activation rules are
`## Attaches when`. `## Authority` — a pack holds none and attaching it authorizes nothing, so an
authorization its work needs is a constraint of kind `authorization-required` under
`## Constraints`. `## Workflow` — a pack has no procedure; the phase it attaches to does.

**The table is required, for §12.1's reason.** A pack exists to hold a constraint against a change
that arrives with a reason to waive it, and all eight in `research/dossiers/packs.md` carry a
pressure-to-skip case. The donor tables it adapts are two columns, excuse and reality; the third column, what to do
instead, is the one a reviewer acts on and the one to write rather than leave implied.

**`## Constraints`.** The ceiling is a ceiling, never a grant: which seat may emit `safe_auto` is the
seat's property (ruling `safe-auto-restricted-per-seat`), so a pack that names `safe_auto` has
lowered no seat's restriction. An `authorization-required` constraint says what is needed; it does
not supply it (ruling `sensitive-actions-need-approved-charter-entry`).

**`## Reviewer guidance`.** A lane is a seat that already exists — the schema's own description
says a pack never adds a seat the review policy did not permit. Where no seat fits the pack, route
it to the nearest existing seat and say so in this section; never write a role id that `catalog.yaml`
does not declare. Nothing checks that a `lane` resolves. Set `required_when_attached` only where the
pack's constraints cannot be judged without that seat, because it turns the seat's absence into an
unavailable lane that blocks (ruling `required-lane-failure-is-unavailable`).

**`## Project facts`.** A number is a project fact (ruling `numeric-heuristics-are-guidance`) and
project facts live in the knowledgebase (ruling `central-kb-owns-project-artifacts`). Name the kind
of fact the pack reads and the `kb_rules` entry that points at it; never the value.

**Tests.** `tests[]` in `pack.yaml` is the declaration, and `packs/<id>/tests/<test-id>/` is its
fixture. This is the format, and it is this contract's rather than a donor's:

```text
packs/pack-api/tests/
├── breaking-response-shape/   # directory name = the tests[].id it implements
│   ├── change.patch           # the subject, when it is a change: one unified diff
│   └── expected.yaml
└── spec-adds-endpoint/
    ├── artifact/              # the subject, when it is not a change: the files as they stand
    └── expected.yaml
```

```yaml
# expected.yaml
attaches: true
matched_rules: [public-response-shape]
why: An existing public endpoint's response field changes type.
```

- Every `tests[]` entry carries `fixture: packs/<id>/tests/<test-id>`. The schema makes `fixture`
  optional; this contract does not, because a case with no fixture restates an
  `activation.examples` row and adds nothing to it.
- The subject is exactly one of `change.patch` or `artifact/`.
- `expected.yaml` has three keys. `attaches` is a boolean. `matched_rules` lists
  `activation.rules` ids, is required and non-empty when `attaches` is true, and is absent when it
  is false. `why` is one sentence. They mirror the `attachment_record` so the comparison is
  field-for-field: an attaching case against `matched_rules` and `rationale`, a declining case
  against its `rejected[].why`.
- Cases of all three `kind`s. The schema requires a positive and a negative; this contract adds an
  `adversarial` case, as §9 does for skills — a subject whose accompanying text (a pull-request
  description, a commit message, a ticket) says the pack does not apply while the change itself
  says it does. For `pack-api`, `pack-data` and `pack-secure`, one positive case is an
  ambiguous-evidence subject, showing the pack attaches on it.

Nothing runs these today. `ak attach` evaluates its built-in signals against a path and reads
neither `tests[]` nor `expected.yaml`, and `ak validate` checks neither the fixture paths nor what is
in them. They are what a reviewer reads to see the boundary, and they are complete when a selector
runner would need nothing else to decide each case.

**§9 does not reach a domain pack.** A pack has no `skill.yaml`, is never invoked, and the eval
checks read skills only (`src/validation/evals.ts`). Its behavioural evidence is
`activation.examples` plus the `tests/` above. Do not write `evals/pack-*/`; a case there is one no
skill declares.

**§1 applies unchanged, and this is where the shape parts from §12.5.** A reference pack is the long
material §1 sends behind the limit. A domain pack is not: it is attached into every phase whose
artifact earns it, including matches its writer did not foresee, so its length is paid on each one.
`PACK.md` is ≤150 lines, hard cap 300, reported through `BUDGETED` (`src/validation/budget.ts`)
under `budget.body-over-target` and `budget.body-over-cap`. A full mechanism or a long checklist
goes behind `packs/<id>/references/`. `pack.yaml` is not measured.

**Provenance (§5) is recorded at both granularities, as for a skill.** `pack.yaml`'s `provenance`
block has `skill.yaml`'s shape, and each adapted file — `PACK.md`, a reference file, a fixture
adapted from a donor's fixture — has its own row in the batch's fragment. The fixture format above
is this contract's and is attributed to no donor.

**Ruling citations (§6) work as they do for a skill.** A ruling the pack touches is listed in
`pack.yaml`'s `provenance.resolved_conflicts[]` and cited inline in `PACK.md` at the sentence it
governs. A ruling whose `binds.packs` names this pack is owed a citation in `PACK.md` specifically:
`rulings.binding-not-cited` (`src/validation/rulings.ts`) resolves a `packs` binding to
`packs/<id>/PACK.md`, reports an error there, and does not read `pack.yaml`, so a manifest-only
citation does not discharge it.

**Gated:** the section list and the three rejected headings are `PACK_SECTIONS` and
`PACK_FORBIDDEN` in `src/validation/bodies.ts`, raising `body.missing-section`,
`body.sections-out-of-order`, `body.section-inserted` and `body.forbidden-section`; a
`## Rationalizations this pack counters` with no three-column table raises
`body.missing-anti-rationalization-table`; frontmatter raises `body.frontmatter-forbidden`; a
missing manifest raises `body.pack-manifest-missing`; length is `budget.body-over-*`; the manifest
is `schemas.document-invalid` and `pack.activation-requires-artifact-and-semantics`. **Not gated,
and yours:** the shared ids, a `lane` that resolves, the fixture paths and their contents, the
adversarial case, and the ambiguous-evidence statement.

Before handing one back, §12.4 applies with three differences. The body file is `PACK.md`, and
§12.4's body-file bullet governs what a differently named one costs. The second bullet holds for
frontmatter and is inverted for the sidecar: `pack.yaml` is required, not forbidden. The two
role-specific bullets are skipped.
