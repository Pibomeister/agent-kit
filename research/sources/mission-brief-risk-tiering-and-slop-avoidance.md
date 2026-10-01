# agent-kit Mission Brief: Risk Tiering and Slop Avoidance

Sep 28, 2026 · @Eduardo Picazo

## Mission

Tomorrow's session adds two things to agent-kit: a per-ticket delegation class that decides which checkpoints a charter may delegate, and project-declared slop checks whose results arrive as verification evidence. Everything else the two research reports ask for should be mapped onto machinery agent-kit already has, not rebuilt.

Most of the reports' requirements already exist under other names. `ak attach` with its never-dropped packs is the risk manifest. The ten sensitive actions cover most of the Red overrides. The `tdd` protocol's observed red step is fail-before/pass-after, and `pack-test` already forbids weakened tests. The real additions are a delegation record, a spec readiness score, test-strength evidence, independent test oracles for unreviewed work, and the rulings that make them legal under the existing contract.

The end-of-day target, in the repository's own order of work:

1. The two reports sit in `research/sources/`, with a dossier mapping each requirement to a disposition.
2. The new rulings, release scenarios and contract amendments are committed before any authoring, as `AUTHORING.md` §10 requires.
3. Schema changes land with invalid-case fixtures that must fail.
4. New catalog entries sit at `status: contract`, with a batch 11 brief written.
5. One vertical slice is authored with evals: ticket-time delegation in `super-bound`, backed by a new delegation reference pack.

Everything ships through `git push no-mistakes <branch>`.

## Current state of agent-kit

At `eef96dd` (merged 2026-09-28), agent-kit is a catalog of engineering instructions, not an application. `catalog.yaml` declares 33 skills, 8 packs, 8 protocols, 34 roles and 5 references, and the `ak` CLI validates, packages and runs pack attachment. The README still says 7 protocols and 29 roles; the catalog is authoritative.

The lifecycle runs `super-align` → `super-bound` → `super-scout` → `super-build` → `super-verify` → `super-review` → `super-ship`. `autopilot` is a human-started supervisor pair that decides only the checkpoints its immutable charter lists.

| Mechanism | Where | What it already does for this mission |
| --- | --- | --- |
| Pack attachment | `src/attach/signals.ts`, `ak attach <path>` | Path, content and field regex signals select packs, with a recorded rationale. `pack-api`, `pack-data` and `pack-secure` are never dropped for want of a classifier; a manifest may add signals, never remove them |
| Sensitive actions | `schemas/common.schema.json`, `policies/authority-defaults.yaml` | `merge`, `deploy`, `production-credentials`, `destructive-data`, `dependency-add`, `public-contract-change`, `trust-boundary-change`, `scope-expansion`, `force-push`, `history-rewrite`. No charter grants these by default |
| Delegable checkpoints | `schemas/charter.schema.json` | Ten categories a charter may hand the supervisor pair: `align-answer`, `spec-approval`, `ticket-approval`, `build-go`, `finding-adjudication`, `delta-closure`, `ship-pr`, `ci-repair`, `lesson-publication`, `plan-conflict-ruling` |
| Project record | `schemas/project.schema.json` | `guidance` holds the \~100-line PR target and 80/15/5 pyramid, with `enforcement` pinned to `advisory`. `mandatory_constraints` holds hard project constraints that may block `build`, `review` or `ship`, each naming its required evidence |
| Ticket | `schemas/ticket.schema.json` | Goal, non-goals, acceptance criteria, `allowed_changes`, `write_ownership`, named verification per criterion |
| Receipts and gates | `schemas/verification.schema.json`, `src/lifecycle/gate.ts` | Receipts carry argv, exit status, output digest, revision, supported criteria and `weakened_checks`. Gate records (`build-checks`, `verify`, `review-full`, `review-delta`, `review-readiness`, `ship-preflight`) bind to a revision and diff hash; `super-ship` refuses stale ones |
| Test discipline | `protocols/tdd`, `packs/pack-test` | Observed red before green. `behavior-has-test`, `prove-it-for-fixes`, `no-weakened-tests`, `suite-actually-ran` |
| Review panel | `policies/review.yaml`, `roles/code-review/*` | Correctness always runs; testing and maintainability fire on diff evidence; security and adversarial seats come from attached packs. Synthesis may only worsen a grade |
| Evals | `evals/<skill>/<case>/case.yaml` | Prompted cases with `llm` and `tool_used` graders. The 2026-09-28 calibration puts the scorer at κ 0.747 against a two-reviewer consensus, with no human labels yet |

The repository's working method decides how tomorrow runs: research goes to `research/sources/`, a dossier maps it, rulings and contract amendments come first, catalog entries start at `status: contract`, a batch brief commissions the bodies, and each body ships with evals. `AUTHORING.md` §10 forbids a brief that restates or departs from the contract; a difference means amending the contract before the batch.

Baseline measured today, in a Linux sandbox without `.donors/`: `ak validate` reports 0 errors, 20 warnings, 144 notes and 121 skill-style warnings, with the donor-paths check skipped. `bun test` reports 2,307 pass, 47 fail and 1 skip; every failure is in the `child-guard`, `eval-local` and `rollback` suites, which points at the environment. Neither figure is a receipt under `AGENTS.md`, because the instrument was not `research/probes/validate-figure.sh` with `.donors/` copied in.

## What the two reports require

The reports reduce to thirteen requirements: six from the delegation rubric (report 1) and seven from the slop-avoidance setup (report 2). Each is a rule, a number to calibrate, or an external tool a project runs.

| # | Requirement | Report | Kind |
| --- | --- | --- | --- |
| R1 | Sensitivity sets a floor. Auth flows, token validation, money movement, irreversible data changes, crypto choices, permission models and secret storage force Red at any size | 1 | Rule |
| R2 | Additive factors, each 0–3: reversibility and blast radius, size and diffusion, complexity and history, spec clarity, verification strength (subtracted). Base 0–15 maps to a class | 1 | Number |
| R3 | Score twice: at ticket time on predictions, at merge time on the actual diff. Merge time may raise the class automatically; lowering it needs a named human | 1 | Rule |
| R4 | Human involvement per class: Green, no blocking review plus sampled audit; Low Yellow, one standard review; High Yellow, approved plan and domain-owner review; Red, human-authored | 1 | Rule |
| R5 | Every agent PR carries an evidence bundle: computed class and factors, sensitive areas touched versus predicted, commands and results, tests shown failing before the change, diff coverage and SAST, rollback method, what could not be verified | 1 | Rule |
| R6 | Calibrate per class on revert, rework, change-failure and triage-miss rates; re-fit at least quarterly; widen autonomy one task category at a time | 1 | Rule |
| R7 | Structural checks scoped to the diff: cognitive complexity fails a new function over the limit or a worsened one ending over it; duplication, dead code and import boundaries on changed code | 2 | Tool, number |
| R8 | LLM review is advisory and raise-only; runs are aggregated before a finding moves a class; rules with low acceptance are rewritten or retired | 2 | Rule |
| R9 | Defect propensity as a transparent formula: size, diffusion, hotspot overlap, prior fix density, complexity delta. Record who authored each PR | 2 | Number |
| R10 | Spec readiness score: six criteria at 0–2 each (acceptance criteria, interfaces, examples, non-goals, existing pattern, verification path); Green needs 9 of 12 with no zero on the first three | 2 | Number |
| R11 | A plan with Assumptions, Open questions and Out of scope is approved before coding, and the diff is checked against it | 2 | Rule |
| R12 | Stacked PRs near 400 changed lines or 10 files, ordered refactor, schema expand, behavior behind a flag, consumer, backfill, schema contract | 2 | Rule, number |
| R13 | Tests: fail-before/pass-after, diff coverage, mutation score on changed lines, property-based tests for parsers, money and dates, human-owned critical-path e2e, acceptance tests written from the spec by a seat other than the implementer | 2 | Rule, tool, number |

Both reports call every threshold a starting point to calibrate against the team's own revert and rework data. agent-kit's contract already treats numbers this way (ruling `numeric-heuristics-are-guidance`), so no number from either report enters a skill body as a gate. Numbers go in the project record, as `guidance` or as a `mandatory_constraints` entry the project chooses to make blocking.

## Gap analysis

One requirement is already covered, eight fold into existing skills, packs, protocols or policies, two need new reference packs, and two are deferred. None needs a new public entrypoint. Dispositions use the vocabulary of `provenance/conversation-map.yaml`.

| # | agent-kit today | Gap | Disposition |
| --- | --- | --- | --- |
| R1 | `pack-secure`, `pack-data`, `pack-api` attach and are never dropped. `trust-boundary-change`, `destructive-data`, `public-contract-change` and `production-credentials` need an approved charter entry | An attached pack does not stop a delegated `build-go`. A change to how money is calculated or reconciled is not a sensitive action: `pack-secure` attaches on payment paths, but its authorization constraint does not name amount logic | Folded: the class floor is derived from attached packs and required sensitive actions |
| R2 | Inputs exist: `allowed_changes` and `write_ownership` (diffusion), `pack-data` irreversibility detection, `guidance.pr_size`, receipts | No scoring procedure and no class vocabulary | New reference pack `delegation`, plus a ticket field |
| R3 | Gate records bind to revision and diff hash; `super-ship` refuses stale gates. `ak attach` works on paths | No merge-time re-score. No rule that lowering a class needs a human | Folded into `super-review` readiness, with a new ruling |
| R4 | Delegation is per checkpoint in the charter. `merge` is always a sensitive action | No map from class to delegable checkpoints. Green cannot mean "no human merges" without a sensitive grant | Folded into `policies/authority-defaults.yaml` and `autopilot` |
| R5 | `super-verify` acceptance-to-evidence matrix, receipts, `super-ship` PR preparation | The class and its factors, predicted versus touched sensitive areas, and the rollback method are not in the PR body | Folded into `super-ship` |
| R6 | The learning runtime reads session observations; no delivery-outcome ledger | No revert or rework tracking per class | Deferred. Record the class and the host on gate records now so outcomes can be joined later |
| R7 | `code-review/maintainability` judges dead code, indirection and coupling; `simplify` reduces complexity with behavioral evidence | No project-declared diff-scoped commands and no receipts from them | New reference pack for structural checks, project record entries, run by `super-verify` |
| R8 | Synthesis may only worsen a grade; confidence is advisory; only independent verification closes a finding; a failed required lane is `unavailable` | None in principle. Run aggregation and rule-acceptance pruning are absent | Covered. Aggregation deferred |
| R9 | `code-review/learnings` checks the lesson corpus. No churn or hotspot input | Hotspot overlap and prior fix density | Deferred. Define the factor in the `delegation` reference; compute it later |
| R10 | `super-bound` zero-context check bans "handle the edge cases" tickets; `doc-review/coherence` flags ambiguity where readers would diverge | No graded criteria. No required edge-case example, no existing-pattern reference, no vague-term pass | Folded into `super-bound` and `doc-review/coherence`; score recorded on the ticket |
| R11 | `super-align` hard gate, spec approval bound to its hash, `allowed_changes`, no silent scope expansion in `super-build` | No assumptions list on the ticket that must become criteria or non-goals before approval | Folded: ticket field plus a `super-bound` step |
| R12 | Vertical slices sized for one context window; wide refactors as expand, migrate in batches, contract; exclusive file ownership | No ordering rule for schema expand, flagged behavior, consumer, backfill and contract, and no rule that contract is its own gated ticket. Size stays guidance | Folded into `super-bound` slicing and `pack-data` |
| R13 | Observed red, `prove-it-for-fixes`, `no-weakened-tests`, `suite-actually-ran`, `weakened_checks`; `code-review/testing` flags weak and implementation-coupled assertions | No mutation evidence on changed lines. No oracle independent of the implementer for unreviewed work. No property-based requirement for parsers, money and dates. No protected critical-path e2e | Folded into `pack-test` and the `tdd` protocol; the project record declares the mutation command and protected paths |

R1 hides the one gap that may need an enum change. If money-movement logic should need an approved charter entry, `sensitive_action` gains a member, which touches `schemas/common.schema.json`, `policies/authority-defaults.yaml` and every charter fixture. Decision D5 below covers it.

## Workstreams

Seven workstreams cover the gap table; W1 to W3 must land before any body is authored, and W7 waits until the reference pack has been exercised.

| W | Workstream | Touches | Done when |
| --- | --- | --- | --- |
| W1 | Research ingestion and dossier | `research/sources/` (both reports), new `research/dossiers/delegation.md` | R1–R13 each have a disposition and a destination; exclusions say why |
| W2 | Rulings, release scenarios, provenance route | `policies/resolved-conflicts.yaml`; `research/sources/engineering-skills-repo-plan.md` §10 and a new section; `AUTHORING.md` only where a gap shows | New rows pass `ak validate` (binds, scenario, ids); scenarios 25–28 exist; no open entry in `CONTRACT-DEFECTS.md` |
| W3 | Schemas | `ticket.schema.json`, `project.schema.json`, the gate record, `verification.schema.json` only if `probe` cannot carry a measured score | Valid and invalid fixtures pass and fail as intended under `bun test` |
| W4 | Reference packs | `references/delegation/`, a structural-checks reference (name settled at kickoff) | Within the §12.5 rules, linked from the bodies that load them |
| W5 | Bodies and policy | `super-bound`, `super-align`, `super-review` readiness, `super-ship`, `doc-review/coherence`, `pack-test`, `pack-secure`, `pack-data`, `protocols/tdd`, `policies/authority-defaults.yaml`, `autopilot` | Entries at `status: contract` and a batch 11 brief tomorrow; bodies authored in the batch |
| W6 | Evals | `evals/<id>/<case>/case.yaml` for every changed body | The six cases below exist; the vertical slice passes its three |
| W7 | Deterministic scorer | `ak delegation` in `src/`, with tests | Deferred until the reference pack settles (D9) |

### W2: proposed rulings and scenarios

Four rows, each citing the scenario that tests it. The first two may merge if their `binds` groups turn out identical.

- `delegation-class-is-authority-not-finding`. The class decides which checkpoints a charter may delegate for one ticket. It is computed from artifact evidence, never from a classifier's confidence, and it is never a finding. Project numbers may raise it; only a named human may lower it, with a recorded reason. It coexists with `numeric-heuristics-are-guidance`: exceeding `guidance.pr_size` may raise the class and still yields no finding.
- `sensitive-surface-sets-the-floor`. A never-dropped pack that attaches, or a sensitive action the ticket requires, sets a minimum class that no other factor lowers.
- `unreviewed-work-needs-independent-oracle`. When no human reviews before ship, acceptance tests are written from the ticket's criteria, before implementation, by a seat other than the implementer. The implementer may not change them without a recorded decision.
- `project-checks-block-only-as-constraints`. Structural and mutation checks block only when the project declares them in `mandatory_constraints`. Otherwise their receipts are evidence for the maintainability and testing lenses.

New release scenarios for plan §10:

1. (25) A ticket that touches a trust boundary is not built under a delegated `build-go`, however small the change.
2. (26) A diff that touches a sensitive area its ticket did not predict raises the class and stops delegated closure.
3. (27) A size or complexity number set as guidance may raise a class but never becomes a finding; set as a mandatory constraint, it blocks with named evidence.
4. (28) A `green` ticket's acceptance tests were not written by its implementer, and a test that kills no mutant on changed lines does not count as verification strength.

### W3: proposed ticket fields

The ticket gains a `delegation` block written by `super-bound` and rewritten by the readiness gate. The key is `class`, never `tier`: `ladder-tier-assignment` in `src/denylist.ts` matches `tier: low` and `tier: high`, and would match `tier: low-yellow`.

```yaml
delegation:
  class: yellow-agent        # green | yellow-agent | yellow-owner | red
  stage: ticket              # ticket | merge
  floor:
    packs: [pack-data]
    sensitive_actions: []
  factors:                   # 0-3 each, every score cites evidence
    reversibility: {score: 2, evidence: ["pack-data: additive migration, backfill by script"]}
    size: {score: 1, evidence: ["estimate 150 lines, 4 files"]}
    complexity: {score: 1, evidence: ["touches files changed 9 times in 90 days"]}
    spec: {score: 1, evidence: ["readiness 10/12"]}
    verification: {score: 2, evidence: ["existing integration tests cover the path"]}
  lowered_by: null           # {human, reason, at} when a person lowers the class
readiness:
  acceptance_criteria: 2
  interfaces: 2
  examples: 1
  non_goals: 2
  existing_pattern: 1
  verification_path: 2
  vague_terms: []
assumptions:
  - text: "backfill runs off-peak"
    resolved_as: non-goal     # criterion | non-goal | open
```

The project record gains a `delegation` block under `guidance` (cut-points and weights, `enforcement: advisory`), a `checks` list of diff-scoped commands (complexity, duplication, dead code, boundaries, mutation, diff coverage), and `protected_tests` paths. `guidance.exceptions.guidance` must admit the new keys. The gate record gains the class and the host that filled the implementer seat, so R6 outcomes can be joined later without naming a model.

### W5: class to delegable checkpoints

`merge` stays a sensitive action for every class. The map lives in `policies/authority-defaults.yaml`, and the runner's deterministic authority check reads it together with the ticket's class.

| Class | Report label | Author | Checkpoints a charter may delegate | Human role |
| --- | --- | --- | --- | --- |
| `green` | Green | Agent | `ticket-approval`, `build-go`, `finding-adjudication`, `delta-closure`, `ci-repair`, `ship-pr` | Merges; audits a sample |
| `yellow-agent` | Low Yellow | Agent | `ticket-approval`, `build-go`, `delta-closure`, `ci-repair` | One reviewer adjudicates findings and approves `ship-pr`; merges |
| `yellow-owner` | High Yellow | Agent drafts | `build-go`, after the owner approves the ticket | Domain owner approves the ticket, adjudicates findings, approves `ship-pr`; merges |
| `red` | Red | Human | None | Everything; sensitive actions still need approved charter entries |

### W5: body changes in one line each

- `super-bound` writes `delegation`, `readiness` and `assumptions` per ticket, and orders stacks: refactor, schema expand, flagged behavior, consumer, backfill, then schema contract as its own ticket.
- `super-align` runs a vague-term pass ("fast", "clean up", "as needed") and turns each hit into a frontier question.
- `doc-review/coherence` checks the six readiness criteria as a lens, without grading its own artifact.
- `super-review` readiness re-runs `ak attach` over the changed files, recomputes the class from receipts, raises it automatically and records the result in its gate record.
- `super-ship` adds the class, its factors, predicted versus touched sensitive areas, and the rollback method to the PR body.
- `pack-secure` gains a money-movement activation: amount calculation, capture, refund, payout and reconciliation logic.
- `pack-data` states that a contract migration is a separate ticket and a `destructive-data` action.
- `pack-test` gains `test-strength-evidence` (fires only when the project declares a mutation command), `oracle-from-criteria` and `protected-tests-unchanged`.
- `protocols/tdd` adds the independent-oracle step for `green` tickets.

### W6: eval cases

Each case follows `AUTHORING.md` §9 and §3.2: the prompt does not print its own answer key.

1. `super-bound`: a twelve-line refresh-token rotation fix the user wants delegated.
2. `super-bound`: a ticket whose only criterion is "make checkout faster".
3. `super-bound`: a 900-line change the user refuses to split.
4. `super-review` readiness: a diff that edits `src/auth/` under a ticket that predicted no sensitive area.
5. `protocols/tdd` via `super-build`: on a `green` ticket, the implementer rewrites the acceptance tests to match its code.
6. `super-ship`: a PR body with no rollback method.

Cases 1–3 belong to tomorrow's vertical slice.

## Plan for tomorrow

The day runs contract first, then schemas, then one authored slice. If time runs short, stop after step 6: a committed contract, schemas and brief let batch 11 run later without re-deciding anything.

1. **Baseline on the Mac.** Copy `.donors/` from a full clone (not `--depth`), run `research/probes/validate-figure.sh` at `eef96dd`, and run `bun test`. If the 47 sandbox failures reproduce there, record them as the baseline, so the day's changes are judged against it rather than against a green suite that does not exist.
2. **Kickoff decisions.** Settle D1–D4 and D8 from the next section; they fix the ticket shape, the provenance route and the vocabulary that W2 and W3 write. D5–D7 and D9 can be settled during W2.
3. **W1, research ingestion.** Add both reports to `research/sources/` and write `research/dossiers/delegation.md`. Model names in the reports are legal there, because all of `research/` is denylist-exempt.
4. **W2, rulings and scenarios.** Write the four rows, scenarios 25–28 and the provenance route. Commit on its own branch and push through no-mistakes. W3 to W6 wait for this commit, because a batch brief may not carry a difference from the contract.
5. **W3, schemas.** Add the ticket, project and gate-record fields with invalid-case fixtures: a class outside the enum, a lowered class with no human or reason, a readiness score above 2.
6. **Catalog and brief.** Declare the new references at `status: contract`, note the changed entries, and write `research/briefs/batch-11-delegation.md` in the shape of the batch 9 brief: inputs, rulings each id binds, facts the writer cannot get from the files.
7. **Vertical slice.** Author `references/delegation/REFERENCE.md` and the `super-bound` changes, add eval cases 1–3, and run them with `scripts/eval-local.sh`.
8. **Gates and ship.** Run `bun test`, `bun run validate` and `bun run build`; push each branch through no-mistakes. Every quoted figure names its instrument: the sha, whether `.donors/` was present, and the install clause.

Done at end of day:

- [ ] Baseline figure recorded with `validate-figure.sh` and `.donors/` present
- [ ] D1–D4 and D8 decided
- [ ] Both reports in `research/sources/`, dossier committed
- [ ] Rulings and scenarios 25–28 committed and passing `ak validate`
- [ ] Schema fields and failing fixtures committed
- [ ] Catalog entries at `status: contract`, batch 11 brief committed
- [ ] `delegation` reference and `super-bound` slice authored, eval cases 1–3 passing
- [ ] Every branch pushed through no-mistakes

## Non-goals and constraints

agent-kit instructs projects and reads their evidence; it does not become the CI tool that produces that evidence. Tomorrow ships no Stryker, jscpd or complexity configuration: a project declares its commands in its record, and `super-verify` turns their output into receipts.

Out of scope tomorrow:

- Learned defect models, auto-landing funnels and LLM-generated mutants. Report 2 places all three at a scale this setup does not have.
- The outcome ledger and calibration reporting (R6). Only the gate-record fields that make it possible later.
- Aggregation and acceptance-rate pruning for LLM review (R8).
- Any new public entrypoint, including a second "run everything" command, which `AGENTS.md` lists as deliberately absent.
- The `ak delegation` scorer (W7), until the reference pack has been exercised on real tickets.

Constraints the repository enforces:

- Model names, pricing, effort ladders and routing may appear only under `provenance/`, `research/` and `tests/`. `evals/` is scanned, so eval prompts cannot name a model.
- No `tier:` key with `low`, `high`, `max` or numeric values; `ladder-tier-assignment` rejects it.
- `merge` and `deploy` stay sensitive actions. No class grants either by default.
- No number from either report becomes a catalog-wide gate. Numbers live in the project record as `guidance` or as `mandatory_constraints`.
- Skill bodies target 150 lines with a 300-line hard cap. `super-review` is at 266, `super-build` at 241, `super-ship` at 232 and `super-verify` at 212, so detail belongs in the new reference packs, not in those bodies.
- A brief cites `AUTHORING.md` and never restates it. A gap in the contract is filed in `CONTRACT-DEFECTS.md` and ruled before the next dispatch (§10).
- Every adapted file keeps its provenance row; capabilities from the reports need the route decided in D3.
- Changes reach `origin` only through `git push no-mistakes <branch>`.
