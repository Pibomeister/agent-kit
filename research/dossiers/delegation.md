# Research dossier — delegation and slop avoidance

Sources:

- `research/sources/delegation-rubric-red-yellow-green.md` — report 1, cited as `D:Lx-Ly`.
- `research/sources/slop-avoidance-agent-prs.md` — report 2, cited as `S:Lx-Ly`.
- `research/sources/mission-brief-risk-tiering-and-slop-avoidance.md` — mission brief "Risk Tiering
  and Slop Avoidance", cited as `B:Lx-Ly`. It sets this dossier's requirement boundaries and
  dispositions.

The three copies are byte-identical to the supplied inputs. Their line ranges below are
1-based against those committed copies. The reports contain model names and routing comparisons;
that material remains legal here because `research/` is denylist-exempt.

Every current agent-kit path cited below was verified with
`git cat-file -e HEAD:<path>`. Planned references that do not exist at `HEAD` are described as new
W4 destinations rather than cited as current files. This dossier records the brief's dispositions;
it does not create the D1–D9 rulings the brief says W2 must decide.

---

## Disposition map

| Requirement | Disposition | Destination | Existing surface at `HEAD` |
| --- | --- | --- | --- |
| R1 | Folded | Secure/data/API pack attachment, authority policy, and autopilot | `packs/pack-secure/PACK.md`; `packs/pack-data/PACK.md`; `packs/pack-api/PACK.md`; `policies/authority-defaults.yaml`; `skills/autopilot/SKILL.md` |
| R2 | New reference pack | New delegation reference plus ticket record | `schemas/ticket.schema.json`; `schemas/project.schema.json` |
| R3 | Folded | Full-review readiness and a new ruling | `skills/super-review/SKILL.md`; `src/lifecycle/gate.ts`; `policies/review.yaml` |
| R4 | Folded | Authority defaults and autopilot charter checks | `policies/authority-defaults.yaml`; `schemas/charter.schema.json`; `skills/autopilot/SKILL.md` |
| R5 | Folded | PR preparation and verification evidence | `skills/super-ship/SKILL.md`; `skills/super-verify/SKILL.md`; `schemas/verification.schema.json` |
| R6 | Deferred | Future outcome ledger; record join keys now in gate evidence | `src/lifecycle/gate.ts`; `schemas/verification.schema.json` |
| R7 | New reference pack | New structural-checks reference, project-declared commands, verification receipts | `schemas/project.schema.json`; `skills/super-verify/SKILL.md`; `roles/code-review/maintainability/ROLE.md` |
| R8 | Covered; aggregation deferred | Review synthesis and closure policy | `policies/review.yaml`; `skills/super-review/SKILL.md` |
| R9 | Deferred | Define the factor in delegation guidance; compute it later | `schemas/ticket.schema.json`; `roles/code-review/learnings/ROLE.md` |
| R10 | Folded | Ticket readiness in bounding and coherence review | `skills/super-bound/SKILL.md`; `roles/doc-review/coherence/ROLE.md`; `schemas/ticket.schema.json` |
| R11 | Folded | Assumptions on tickets plus bounding and scope checks | `skills/super-align/SKILL.md`; `skills/super-bound/SKILL.md`; `skills/super-build/SKILL.md` |
| R12 | Folded | Ticket slicing and data-change constraints | `skills/super-bound/SKILL.md`; `packs/pack-data/PACK.md` |
| R13 | Folded | Test pack, TDD, project-declared evidence, and verification | `packs/pack-test/PACK.md`; `protocols/tdd/PROTOCOL.md`; `schemas/project.schema.json`; `skills/super-verify/SKILL.md` |
| R14 | Folded; new ruling required | Host-conditional advisor consultation: required for yellow-owner/Red, recommended for yellow-agent, silent for Green | `skills/super-bound/SKILL.md`; `skills/super-verify/SKILL.md`; `skills/super-review/SKILL.md`; `schemas/verification.schema.json` |

---

## R1 — sensitivity sets a class floor

**Report source.** Report 1 defines four sensitivity classes and their minimum outcomes at
`D:L21-L34`, then specifies path, content, data-classification, dependency, and raise-only semantic
detectors at `D:L48-L56`. The Red overrides cover authentication and token validation, money
calculation or movement, irreversible data changes, cryptographic choices, permission models, and
secret storage (`D:L34-L34`; summarized at `D:L201-L208`).

**Disposition: folded.** Per `B:L71-L71`, derive the floor from attached packs and required
sensitive actions. The current base is `packs/pack-secure/PACK.md`, `packs/pack-data/PACK.md`, and
`packs/pack-api/PACK.md`; authorization stays in `policies/authority-defaults.yaml` and delegated
checkpoint decisions stay in `skills/autopilot/SKILL.md`.

**Gap and destination.** Payment paths already activate security review, but amount calculation,
capture, refund, payout, and reconciliation are not a named sensitive action. Whether money
movement gains its own action is the brief's D5 question (`B:L85-L85`) and belongs to W2, not this
dossier.

**Repository discrepancy.** The brief says pack attachment is never dropped (`B:L29-L29`). At
`HEAD`, each cited pack says ambiguous evidence attaches under the phase selector, while also
stating that the `ak attach` command selects only on a sufficient built-in signal. The dossier
preserves that distinction instead of resolving it.

No report number is needed to enforce the floor; sensitivity is a rule, not a score threshold.

## R2 — additive, evidenced factors

**Report source.** Report 1 defines reversibility, size/diffusion, complexity/history, spec clarity,
and verification strength on 0–3 scales, with verification subtracted, at `D:L177-L199`. The base
formula spans 0–15 and proposes Green 0–3, Low Yellow 4–6, High Yellow 7–9, and Red 10–15
(`D:L190-L199`).

**Disposition: new reference pack.** Per `B:L72-L72`, the scoring procedure and class vocabulary
belong in a new delegation reference, with the result recorded on the ticket. Existing inputs to
build on are bounded file changes and write ownership in `schemas/ticket.schema.json`, and advisory
project guidance in `schemas/project.schema.json`.

**Guidance, not gate.** The 0–3 scales, equal weights, 0–15 total, and cut points are starting
figures to calibrate. Report 1 itself says they are not empirically derived (`D:L199-L199`), and
`B:L63-L63` applies ruling `numeric-heuristics-are-guidance`. They may become project guidance or a
project-chosen mandatory constraint; they do not become catalog-wide gates.

## R3 — ticket-time and merge-time assessment

**Report source.** Ticket time predicts who does the work; merge time uses the actual diff to decide
review (`D:L256-L265`). Merge time may raise the class automatically, while lowering requires a
named human and recorded reason (`D:L260-L264`). A mismatch involving an unpredicted sensitive
area or two size bands pauses for triage (`D:L263-L265`).

**Disposition: folded.** Per `B:L73-L73`, recomputation belongs in `skills/super-review/SKILL.md`
readiness, backed by a new ruling. `src/lifecycle/gate.ts` already binds gate records and receipts to
revisions and diff hashes, and `policies/review.yaml` already makes confidence advisory and closure
evidence-bound.

**Gap and destination.** Neither a merge-time re-score nor a human-only lowering record exists at
`HEAD`; W2 and W3 must define them before the body changes. The report's "two size bands" rule is
guidance to calibrate, not a universal trigger.

## R4 — human involvement follows the class

**Report source.** The four authorship and review modes are specified at `D:L210-L219`: Green has
no blocking review except compliance cases, Low Yellow has one independent standard reviewer, High
Yellow is owner-approved and owner-reviewed, and Red is human-authored with a second domain or
security reviewer. The merge-readiness table adds proposed review and rollout behavior at
`D:L267-L282`.

**Disposition: folded.** Per `B:L74-L74`, the class-to-checkpoint map belongs in
`policies/authority-defaults.yaml` and is enforced through `skills/autopilot/SKILL.md` against
`schemas/charter.schema.json`. The brief's target mapping is class-specific delegated checkpoints,
not permission to bypass sensitive actions (`B:L150-L159`).

**Fixed boundary.** `merge` and `deploy` remain sensitive for every class (`B:L226-L226`). Green
therefore means a charter may delegate eligible pre-merge checkpoints and PR opening; it never
means a class silently authorizes merge. The report's sample 10% Green audit and reviewer counts
(`D:L214-L217`) remain project-calibrated guidance.

## R5 — evidence bundle on every agent PR

**Report source.** Report 1's structured bundle includes the ticket and both classes, factors,
predicted versus touched sensitive areas, decisions, commands and results, fail-before/pass-after
evidence, diff coverage, security scans, rollback, examples or screenshots, and unverified limits
(`D:L284-L296`).

**Disposition: folded.** Per `B:L75-L75`, add the missing class, factors, sensitive-area comparison,
and rollback method to `skills/super-ship/SKILL.md`. Build on the acceptance-to-evidence work in
`skills/super-verify/SKILL.md` and the command, result, revision, criterion, and weakened-check
fields in `schemas/verification.schema.json`.

**Guidance, not gate.** The report's 80% and 90% diff-coverage figures and scan policies
(`D:L269-L282`) are common-practice defaults that the report explicitly says to tune. They are not
catalog-wide merge gates.

## R6 — outcome calibration

**Report source.** Report 1 proposes per-class and per-task tracking of 14- and 30-day reverts,
change failures, rework, review rework, escaped defects, triage misses, overrides, and time to merge
(`D:L298-L311`). It proposes quarterly re-fitting and widening autonomy one task category at a time
(`D:L313-L315`).

**Disposition: deferred.** Per `B:L76-L76` and `B:L214-L220`, the repository has no delivery-outcome
ledger. W3 may add the class and implementer host to existing gate evidence so future outcomes can
be joined through `src/lifecycle/gate.ts` and `schemas/verification.schema.json`; the ledger and
calibration reporting themselves stay out of this mission.

**Why excluded now.** The brief limits the mission to the fields that make later joins possible.
The report's 14/30-day windows, quarterly cadence, and 30–50-PR promotion example
(`D:L302-L315`) are calibration proposals under ruling `numeric-heuristics-are-guidance`, not
prerequisites for the current catalog.

## R7 — diff-scoped structural checks

**Report source.** Report 2 recommends per-function delta semantics: fail a new function over the
configured threshold or a worsened function ending over it, while reporting lesser increases
(`S:L23-L35`). It also covers duplication, dead code, type-aware semantic rules, and import
boundaries (`S:L33-L45`), then summarizes where checks run at `S:L176-L195`.

**Disposition: new reference pack.** Per `B:L77-L77`, add a structural-checks reference that tells a
project how to declare diff-scoped commands and tells `skills/super-verify/SKILL.md` how to consume
their receipts. `schemas/project.schema.json` is the current project-record surface;
`roles/code-review/maintainability/ROLE.md` is the current judgment surface.

**Tool boundary and figures.** This mission ships no Stryker, jscpd, or complexity configuration
(`B:L210-L212`). The reports' examples—complexity 15, clone sizes, 400 lines, 10 files, and coverage
or mutation percentages (`S:L29-L35`; `S:L181-L193`)—are figures to calibrate. A structural command
blocks only when the project declares it as a mandatory constraint; otherwise its receipt is review
evidence.

## R8 — advisory, raise-only probabilistic review

**Report source.** Report 2 makes probabilistic review advisory and raise-only, unable to clear a
deterministic failure or lower a class (`S:L47-L58`). It proposes aggregating five runs or using a
separate verification pass, and rewriting or retiring narrow rules after low acceptance
(`S:L58-L60`).

**Disposition: covered; aggregation deferred.** Per `B:L78-L78`, the principle already exists in
`policies/review.yaml`: synthesis may only worsen a grade, confidence is advisory, independent
verification closes findings, and unavailable required lanes block approval. `skills/super-review/SKILL.md`
is the existing execution surface.

**Why part is excluded.** Multi-run aggregation and acceptance-rate pruning are explicitly deferred
by `B:L218-L218`. The report's five-run majority and roughly 50% acceptance after 30 findings are
operational proposals, not catalog gates (`S:L58-L60`). Learned defect models and automated landing
funnels are also excluded as scale-dependent (`B:L216-L216`).

## R9 — transparent defect-propensity factors

**Report source.** Report 2 proposes size, diffusion, hotspot overlap, prior-fix density, and
per-function complexity delta (`S:L82-L96`). It suggests hotspot calculation over 6–12 months and
quarterly calibration, and asks teams to record author kind (`S:L92-L98`).

**Disposition: deferred.** Per `B:L79-L79`, define the factor in the new delegation guidance but
defer hotspot and prior-fix computation. `schemas/ticket.schema.json` is the current evidence-bearing
ticket surface; `roles/code-review/learnings/ROLE.md` is the existing historical-knowledge review
surface.

**Why excluded now.** Hotspot computation is named as a non-goal, and learned defect models require
data this setup does not have (`B:L79-L79`; `B:L216-L216`). The report's top-decile, 6–12-month, and quarterly
figures are project-calibration guidance. The brief further narrows authorship storage to class and
host without naming a model (`B:L148-L148`); W2/W3 must settle that vocabulary rather than copying
the report's model-specific examples.

## R10 — spec readiness score

**Report source.** Report 2 scores acceptance criteria, interfaces, examples, non-goals, an existing
pattern, and a verification path from 0–2 (`S:L102-L119`). It proposes 9/12 with no zero on the first
three for Green, plus a deterministic vague-term pass.

**Disposition: folded.** Per `B:L80-L80`, record readiness on the ticket, add the procedure to
`skills/super-bound/SKILL.md`, and add the lens to `roles/doc-review/coherence/ROLE.md`.
`schemas/ticket.schema.json` already holds acceptance criteria, bounded changes, and named
verification but has no graded readiness fields at `HEAD`.

**Guidance and gap.** The six criteria are the reusable mechanism. The 9/12 cut point and no-zero
rule are starting guidance under ruling `numeric-heuristics-are-guidance`. Required edge/error
examples, an existing-pattern reference, and a vague-term result are absent at `HEAD`; W3 owns the
record shape.

## R11 — approved assumptions, questions, and scope

**Report source.** Report 2 requires a pre-edit plan naming files, interfaces, tests mapped to
criteria, assumptions, open questions, and out of scope (`S:L121-L136`). Behavior-affecting
assumptions become criteria or non-goals before coding; the diff is later compared with the approved
plan.

**Disposition: folded.** Per `B:L81-L81`, add assumptions to the ticket and a resolution step to
`skills/super-bound/SKILL.md`. Build on the direction and out-of-scope work in
`skills/super-align/SKILL.md`, the bounded ticket surface in `schemas/ticket.schema.json`, and the
no-silent-scope-expansion behavior in `skills/super-build/SKILL.md`.

**Gap.** At `HEAD`, tickets do not carry an assumptions list that must resolve to a criterion,
non-goal, or open item. W3 defines the field; W5 authors the behavior. This dossier does not import
the report's repository-local `PLAN.md` convention because agent-kit already has structured plan and
ticket artifacts.

## R12 — stacked, ordered, reviewable slices

**Report source.** Report 2 proposes approximately 400 changed non-test lines or 10 non-test files
per PR, then orders work as pure refactor, schema expand, flagged behavior, consumer, backfill, and
schema contract (`S:L138-L150`). Contract removal is a separate human-reviewed change.

**Disposition: folded.** Per `B:L82-L82`, put stack ordering and ticket slicing in
`skills/super-bound/SKILL.md`, with expand/contract and destructive-data constraints in
`packs/pack-data/PACK.md`.

**Guidance, not gate.** The 400-line, 10-file, and five-PR-depth figures are starting points to
record per project, never validation failures by themselves. The ordering rule is retained because
it describes reversible delivery boundaries rather than a universal number. No stacked-PR tool is
adopted by this mission.

## R13 — test strength and independent oracles

**Report source.** Report 2 distinguishes diff coverage from changed-line mutation strength and
describes fail-before/pass-after, property-based tests, contract tests, protected critical-path e2e,
no weakened assertions, and test-author separation (`S:L152-L172`). The reference setup summarizes
their proposed execution stages and thresholds at `S:L181-L193`.

**Disposition: folded.** Per `B:L83-L83`, extend `packs/pack-test/PACK.md` and
`protocols/tdd/PROTOCOL.md`; let the project declare mutation commands and protected paths through
`schemas/project.schema.json`; consume their receipts in `skills/super-verify/SKILL.md`.

**Current surface and gaps.** The test pack and TDD protocol already require observed red,
prove-it-for-fixes, no weakened tests, and evidence that the suite ran. At `HEAD` there is no
changed-line mutation evidence, independent acceptance-test oracle for unreviewed work,
property-based requirement for parsers/money/dates, or protected critical-path e2e list.

**Tool boundary and figures.** The report's 80% diff coverage and 60–70% mutation figures are
calibration guidance, and no mutation-tool configuration ships. The durable rule is that a project
may declare the command as a mandatory constraint; otherwise the receipt informs testing review.
LLM-generated mutants are excluded because the report itself places them at a scale this setup does
not have (`B:L216-L216`; `S:L195-L199`).

## R14 — host-conditional advisor consultation

**Source.** The captain added this requirement after the mission brief: use Claude Code's
experimental advisor capability to obtain a second judgment at risk-scored decision points. The
official documentation is [Claude Code advisor](https://code.claude.com/docs/en/advisor). It
describes a model-driven, server-side consultation tool intended for moments such as committing to
an approach, repeated errors, and completion checks. It is host-specific, may be unavailable under
some providers, and consumes a full-transcript consultation budget.

**Disposition: folded; new ruling required.** The captain selected: "Require for owner/Red;
recommend for agent-Yellow." In repository vocabulary, when the host offers an advisor tool,
yellow-owner and Red work require consultation at named decision points, yellow-agent work
recommends it, and Green remains silent. Required consultation is recorded as evidence. The likely
destination is host-conditional language in `skills/super-bound/SKILL.md`,
`skills/super-verify/SKILL.md`, and `skills/super-review/SKILL.md`, with
`schemas/verification.schema.json` as the current evidence surface on which W3 can build.

**Boundary.** Consultation supplies another judgment; it does not grant authority, lower a class,
clear deterministic evidence, or substitute for required independent review. The authored rule must
remain model-free and correct on hosts with no advisor. It adds no public entrypoint. Because the
three likely skill bodies already exceed the 150-line target or approach their 300-line cap, W5
should keep the shared detail in reference or policy material and add only the shortest operational
hook to each body.

**Chosen boundary.** The required-versus-recommended split follows class: required for yellow-owner
and Red, recommended for yellow-agent, and absent for Green. Evidence is required where consultation
is required. W1 records the choice without writing a ruling, schema, or skill body.

---

## Cross-cutting exclusions

- **No catalog-wide numeric gate.** Every score, threshold, count, time window, and cadence above is
  report guidance to calibrate under ruling `numeric-heuristics-are-guidance` (`B:L63-L63`;
  `B:L227-L227`). A project can separately promote a named check to a mandatory constraint.
- **No new public entrypoint.** The requirements fold into existing lifecycle skills, policies,
  packs, protocols, and new references; the brief explicitly rejects a second run-everything command
  (`B:L219-L219`).
- **No tool configuration.** agent-kit consumes project evidence; it does not ship Stryker, jscpd,
  or complexity configuration (`B:L210-L212`).
- **No outcome system yet.** R6's ledger and calibration reporting are deferred; only future join
  keys are in scope (`B:L217-L217`).
- **No probabilistic-review aggregation yet.** R8's multi-run aggregation and rule-acceptance pruning
  are deferred (`B:L218-L218`).
- **No hotspot computation or learned model.** R9's factor may be described, but its computation,
  learned defect models, and automated landing funnels are deferred (`B:L79-L79`; `B:L216-L216`).
- **No automatic scorer yet.** The deterministic scorer waits until the delegation reference has
  been exercised on real tickets (`B:L99-L99`; `B:L220-L220`).
- **No model-routing contract.** Report model names stay in research. Authorship evidence in catalog
  surfaces must use the model-agnostic vocabulary W2/W3 settle (`B:L224-L225`).
- **No implicit merge or deploy authority.** Both remain sensitive actions independent of class
  (`B:L226-L226`).
- **No advisor-derived authority.** A host advisor can add judgment evidence but cannot lower the
  class, authorize a sensitive action, or replace an independent required lane. Hosts without the
  tool remain valid targets.

## Captain decisions

The supplied mission brief ends before its D1–D9 decision section. A captain review reconstructed
the missing choice surfaces from the brief, both reports, and the current repository. The captain
submitted the following selections; the choice labels are reproduced verbatim from that review:

| Decision | Captain's selection | Consequence for W2/W3 |
| --- | --- | --- |
| D1 | Two bound snapshots | Keep ticket-time and merge-time assessments, with named human lowering evidence. |
| D2 | Project guidance | Keep factor semantics central and weights/cut points project-configurable and advisory. |
| D3 | Research-report origin | Attribute adapted capabilities to the checked-in reports with exact report citations. |
| D4 | Criteria on each ticket | Record each readiness criterion and its evidence, not only a total. |
| D5 | Add a money-movement action | Add explicit authorization vocabulary for amount calculation, movement, and reconciliation changes. |
| D6 | Structural-checks reference | Keep command declaration and receipt semantics in a dedicated reference. |
| D7 | Whenever work ships without human code review | Require acceptance tests derived before implementation by a seat other than the implementer. |
| D8 | Author kind plus host | Record human/agent authorship and the host adapter, never a model. |
| D9 | Build alongside the schema | Implement the deterministic scorer with the record schema. |
| D10 | Require for owner/Red; recommend for agent-Yellow | On supported hosts, require and evidence advisor consultation for yellow-owner and Red, recommend it for yellow-agent, and keep Green silent. |

**Recorded discrepancy.** D9's selection conflicts with the mission brief's explicit W7 deferral
until the delegation reference has been exercised (`B:L99-L99`; `B:L220-L220`). W1 does not choose
which instruction wins or start the scorer; W2 must reconcile the captain's later selection with the
brief before W3 or W7 acts. D1–D8 and D10 refine the brief without changing W1's file scope.
