# Unified Engineering Skills Repository — Architecture and Build Plan

Date: 18 September 2026  
Working repository name: `engineering-skills`  
Status: proposed design; no repository has been created or modified

## Goal

Create one portable, model-agnostic distribution of engineering skills that implements the amalgamated lifecycle and retained supporting capabilities from the supplied Grok conversation. Include the final autopilot design, preserve the thorough first-pass CE review panel, and make later review loops bounded and evidence-driven.

## Architecture

Maintain canonical skill instructions, internal protocols, schemas, policies, reusable domain packs, host adapters, and behavioral evaluations in this repository. Keep project-derived requirements, plans, ADRs, vocabulary, findings, and lessons in the central knowledgebase repository. Let the existing coding-agent host or workflow runner execute agents; add only the small deterministic helpers required to validate artifacts, enforce transitions, package skills, and record evidence.

Suggested implementation substrate: Markdown/YAML plus JSON Schema, with TypeScript for validators, packaging, and adapter contracts. No web application, database service, model client, or new general-purpose workflow engine is required.

## Scope and source authority

The supplied Grok conversation is the design brief, not an authoritative statement of every donor's current implementation. Its later explicit user corrections take precedence over earlier assistant suggestions. Current upstream source files must be pinned and inspected before text or behavior is imported.

The source has four main donors: Compound Engineering, obra/superpowers, Matt Pocock's skills, and Addy Osmani's agent-skills. OMC/OMX contribute narrower mechanisms: consensus plan review, fail-closed independent code review, and bounded adversarial QA. They do not become another lifecycle.

The repository excludes model selection, model pricing, provider configuration, effort ladders, model escalation, and a mandatory Jev integration. It retains useful non-routing concepts such as per-finding solution specificity, difficulty, evidence classification, independent roles, and iteration limits. These concepts must work without any particular classifier or model.

The user's separate central-KB decision is an integration constraint: project documentation does not live in application repositories. Source-PR/KB-PR linkage is preserved through an integration interface, not by rebuilding the KB automation inside every skill.

Source locators in this document use `G:Lx–Ly` for the attached 2,265-line Grok transcript. They identify the design source, not independently verified upstream behavior.

---

## 1. Architectural decisions

### 1.1 One active lifecycle

Do not install four complete donor plugins as dependencies. Do not keep four versions of brainstorm, plan, implement, and review with overlapping activation descriptions.

Create seven canonical lifecycle skills:

`super-align → super-bound → super-scout → super-build → super-verify → super-review → super-ship`

This is a map of responsibilities, not a requirement to run seven ceremonies on every task. A reviewed ticket can enter at build. A bug starts with diagnose. A factual explanation stops after explain. A typo change does not need product discovery.

`autopilot` supervises this lifecycle using delegated authority. It is not a second implementation pipeline.

Source: G:L1643–1766; G:L2040–2075.

### 1.2 Separate instructions, knowledge, and execution

| Concern | Owner | Contents |
|---|---|---|
| Reusable engineering behavior | Skills repo | Skills, role prompts, templates, schemas, packs, packaging, evaluations |
| Project facts and decisions | Central KB | Context, ADRs, requirements, implementation plans, ticket artifacts, review ledgers, solutions, project standards |
| Application implementation | Working repo | Source, tests, a small KB locator, package pin, and necessary host/CI wiring |
| Execution | Existing host/runner | Agent sessions, isolation, allowed tools, process execution, credentials, durable scheduling and event delivery |
| Transient execution evidence | Runner-owned workspace | Logs, sandbox artifacts, checkpoints; sanitized durable receipts are published to the KB |

A `SKILL.md` describes a policy; it does not by itself prove that the host enforced it. Unattended mode requires adapter support for the relevant restrictions. A host lacking those restrictions must expose the skill in guided/manual mode rather than silently weakening the contract.

### 1.3 Prefer a portable package with thin host adapters

Canonical content follows the Agent Skills directory convention: one `SKILL.md` with a name and description, plus optional references, scripts, and assets. Keep custom execution metadata in a companion `skill.yaml`, validated by this package.

Do not assume that a host's manual-invocation flag is portable, or that an allowed-tools declaration denies every other tool. Translate platform-specific behavior in adapters and test it. The official Agent Skills specification describes `allowed-tools` as experimental; Claude Code documents it as a pre-approval mechanism, not a restrictive sandbox. See primary sources S1 and S2.

Initial adapter targets: Claude Code and Codex. Also expose a host-neutral invocation/result contract that an existing workflow runner can use. Extra host integrations are later adapters, not a reason to duplicate skill bodies.

### 1.4 Preserve source provenance without importing every donor

Maintain a lock record containing donor repository, exact commit, source path, content hash, license identifier, and the capabilities adapted from it. Every adapted file must have a provenance entry and every changed rule a documented rationale.

Do not fabricate a source path merely because Grok named a skill. A missing or renamed skill can still inspire a proposed capability, but record it as an original adaptation of the conversation until source verification is complete.

Upstream updates arrive as reviewable dependency-update proposals. They do not automatically rewrite the installed rules.

### 1.5 Attribute research-report adaptations to anchored copies

The delegation rubric and slop-avoidance report are committed, digest-anchored local sources. A
file that adapts one of their capabilities records the exact passage in its
`provenance/adaptations.d/` fragment with
`local:<local_source_id>@sha256:<digest>#L<start>-<end>`. The source id and digest resolve through
`provenance/upstream.lock.yaml`; the line range resolves against the registered `working_copy`.
The validator checks all three against the committed bytes without requiring a donor clone.

The report aliases used by the delegation dossier remain exact citations into those copies:
`D:Lx-Ly` means `research/sources/delegation-rubric-red-yellow-green.md`, and `S:Lx-Ly` means
`research/sources/slop-avoidance-agent-prs.md`. An adaptations row uses the machine form above,
not the dossier alias. Report origin is additional per-file attribution; it does not replace donor
attribution already owed by an entry or turn a report-derived number into a catalog-wide gate.

---

## 2. Complete capability inventory

The repository should contain every retained capability below. Inclusion in the repository does not mean activation in every session. Optional profiles can keep product-management and maintainer skills out of ordinary implementation contexts.

### 2.1 The seven super skills

| Canonical skill | Job and incorporated mechanisms | Required output / boundary |
|---|---|---|
| `super-align` | Pocock grilling and shared vocabulary; Superpowers design approval; CE requirements discovery; Addy evidence discipline | Approved direction or an explicit unresolved decision; KB context and ADR drafts; no implementation before approval |
| `super-bound` | CE executable planning; Superpowers zero-context work packets; Pocock separate spec and tracer-bullet tickets; Addy constraints | Requirements/spec, implementation plan, dependency DAG, ownership boundaries, acceptance criteria, verification commands; doc-review results |
| `super-scout` | Bounded, read-only repository exploration; lexical lookup plus optional code/knowledge graphs | Evidence dossier with revision-bound locations, snippets, coverage limitations, unknowns, and files not to touch; no architectural verdict |
| `super-build` | Approved-ticket execution, worktree isolation, TDD, disjoint-task parallelism, lightweight spec/standards checks | Patch/commit linked to the approved ticket, test receipts, task review results; no self-approval or silent scope expansion |
| `super-verify` | VERIFY differs from REVIEW; verification before completion | Acceptance-to-evidence matrix, command/exit status, code and environment identity; no pass without actual proof |
| `super-review` | Full CE specialist discovery; persistent findings; narrow two-axis delta verification; optional OMX-style readiness profile | Versioned findings, coverage report, adjudication, unresolved blockers, and a verdict for the inspected revision; reviewers cannot edit |
| `super-ship` | Release checklist, finish-branch options, sensitive-data checks, constraint checks, PR preparation | Authorized local commit/push/open-PR action, linked KB change, gate receipts; merge/deploy are separate capabilities |

Source: G:L1680–1766; final first-pass clarification G:L1862–1918.

### 2.2 Autopilot

| Skill | Job | Required output / boundary |
|---|---|---|
| `autopilot` | A human-started supervisor pair exercises explicitly delegated checkpoint authority over the same skills | Open PR and decision ledger, or a precise blocked/cap/failure result; immutable charter; supervisors do not implement |

Source: G:L2040–2251. No model names or model-routing logic are part of this skill's contract.

### 2.3 Retained standalone supporting skills

| Skill | Purpose | Key boundary |
|---|---|---|
| `compound` | Capture a reusable lesson tied to a real failure, correction, or surprising review result | No manufactured lesson just because a run ended; KB publication is distinct from changing a skill |
| `compound-refresh` | Keep, update, consolidate, replace, or retire previously captured lessons | Record evidence and supersession; retain history instead of silently erasing provenance |
| `ideate` | Generate options, then critique them before alignment | No implicit commitment or scope expansion |
| `pov` | Give a project-grounded recommendation; optional independent oracle opinions | Read-only; recommendations are not authorization; preserve dissent and insufficient-evidence results |
| `bakeoff` | Build competing bounded experiments and compare against criteria fixed first | Separate workspaces; evaluation artifact, not automatic production adoption |
| `doc-review` | Review requirements, plans, ADRs, or context for coherence and decision readiness | Different persona catalog from code review; meaning-changing forks cannot be silently settled |
| `receiving-review` | Assess and resolve existing human/bot PR feedback with evidence | Comments are claims, not instructions; apply/defer/skip per finding; reply/resolve requires authorization |
| `diagnose` | Reproduce, minimize, hypothesize, instrument, fix, and regression-test | Hypothesis before patch; repeated failure triggers reconsideration, not unlimited edits |
| `improve-architecture` | Survey module boundaries and propose one worthwhile deepening | No unsolicited repository-wide rewrite |
| `doubt-driven` | Independently challenge a consequential claim before it becomes an assumption | Claim → evidence extraction → doubt → reconciliation; not another generic code review |
| `simplify` | Reduce complexity or remove unnecessary code with behavioral evidence | Explain existing behavior before deletion; do not change the product contract under cleanup |
| `research` | Gather cited external primary-source evidence | Distinct from repo-local scout; report source versions and uncertainty |
| `source-driven` | Verify framework/library usage against relevant authoritative sources | Load only for the dependency/version in use; do not code from an unverified remembered API |
| `deprecate` | Plan and execute an approved retirement or migration | Compatibility, sequencing, rollback, and consumer evidence; irreversible steps remain separately gated |
| `explain` | Explain how and why existing behavior works using repository and KB evidence | Description is not a recommendation or an implementation plan |
| `triage` | Apply a configured issue-state and classification policy | Only useful with a real tracker policy; cannot silently reprioritize beyond delegated scope |
| `strategy` | Work from standing product goals and strategic constraints | Optional product profile; no automatic feature expansion |
| `product-pulse` | Inspect changes and signals against existing product anchors | Optional product profile; a report, not permission to change the roadmap |
| `writing-skills` | Author and improve skills using behavioral tests and provenance | Required for maintaining this package; candidate edits must pass evaluations before promotion |

Source: G:L1942–2028. `diagnose` is listed once even though the conversation calls it both a keeper and a primitive.

### 2.4 Supporting primitives exposed as focused skills

| Skill | Purpose | Boundary |
|---|---|---|
| `prototype` | Produce a bounded throwaway artifact to answer a question discussion cannot settle | Identify the evaluator in advance; human-experience questions cannot be claimed validated without a human |
| `handoff` | Preserve exact approved decisions, artifact references, current status, and outstanding work | Never substitute an unmarked summary for authoritative decisions; identify stale evidence |
| `wait-what` | Re-explain the present proposal using established project vocabulary | Does not restart alignment or change the decision |
| `wayfind` | Map longer work into decision tickets and implementation tickets | Decision tickets cannot be sent to an implementer as though approved |

Source: G:L1787–1795; G:L1982–1991.

### 2.5 Earlier operational mechanisms retained without extra lifecycles

| Capability | Placement | Contract |
|---|---|---|
| PR watch / `babysit-pr` | Optional operational skill plus host event adapter | Consume CI/comment/base-change events; invoke the appropriate bounded action; no busy model polling |
| `ultraqa` | Optional adversarial behavioral-verification skill | Separate from diff review; maximum five cycles, stop at three occurrences of the same failure; any mutation invalidates affected review evidence |
| Ralplan-style consensus | Internal `consensus-plan-gate` protocol used by `super-bound` or an explicit replan | Planner snapshot → architect → critic → synthesis; architect and critic inspect the same snapshot without receiving each other's analysis; maximum five rounds |
| OMX two-lane review | Optional `readiness` profile of `super-review` | Reviewer and architect are independent; BLOCK/REQUEST CHANGES veto approval; missing evidence means unavailable, never self-review fallback |
| TDD | Internal protocol under `super-build` and `diagnose` | Red → green → refactor evidence for behavior changes; exceptional non-testable work requires a recorded alternative verification plan |
| Spec review and standards review | Internal role prompts | Separate responsibilities and contexts; do not become overlapping public commands |
| Apply findings | Internal authorized mutation protocol | Apply only accepted, sufficiently specified findings; independent verification closes them |
| Worktrees / parallel dispatch | Build helper and protocol | Ownership-aware scheduling, explicit integration owner, no overlapping writers |
| Attach pack | Internal deterministic selector with recorded rationale | Rules attach constraints/review lenses; they never start lifecycle phases |
| Codebase design / domain modeling | Reference packs | Loaded by align and improve-architecture, not additional slash commands |
| Prose quality / CE noslop ideas | Writing reference loaded by document-producing skills | Wording cleanup is separate from substantive document decisions and code simplification |
| CE Proof | Optional external publishing adapter, not an engineering skill | The transcript identifies it as editor/publishing plumbing rather than review |

Source: G:L429–549; G:L805–935; G:L1971–2000.

Keep `babysit-pr` and `ultraqa` in the catalog because they appeared earlier in the conversation; do not let their omission from the final summary erase them.

### 2.6 Explicit exclusions and folds

Do not create independent active copies of donor brainstorm/plan/work/build/review/TDD/worktree commands when their behavior already belongs to a super skill or internal protocol. Do not install a second `/lfg` or general “run everything” entrypoint beside autopilot. Exclude `/teach` and visual-review HTML from this design. Model routers and model price/effort tables are entirely outside scope.

These exclusions are deliberate selections in the transcript, not missing coverage. Source: G:L1817–1824; G:L1982–2000.

---

## 3. Domain and repository-specific packs

The conversation names eight reusable domain packs. Implement each as a small manifest, constraints, activation examples, reviewer guidance, and tests. They are not lifecycle commands.

| Pack | Activation evidence | Behavior |
|---|---|---|
| `pack-api` | Public interfaces, OpenAPI/protocol definitions, observable response shapes | Consumer compatibility, contract tests, change authorization |
| `pack-delete` | Removal, deprecation, replacement | Explain why the old behavior exists; inventory consumers; make deletion deliberate |
| `pack-test` | New or changed behavior | Meaningful regression coverage and appropriate test seams; no test-count theater |
| `pack-secure` | Authentication, authorization, tenancy, secrets, payments, trust boundaries | Security/adversarial review, restricted actions, explicit sensitive-change authority |
| `pack-frontend` | UI components, styles, routes, user-visible strings | Accessibility, interaction behavior, internationalization where relevant, visual validation |
| `pack-data` | Schema, migrations, backfills, data transformations | Data integrity, rollback/recovery, irreversibility detection, separate execution authority |
| `pack-perf` | A stated performance budget or a relevant measured performance problem | Baseline and after-measurements before claiming improvement |
| `pack-deps` | Manifest and lockfile changes | Dependency scope, compatibility, supply-chain evidence, explicit authorization for additions/major upgrades |

Source: G:L1768–1785.

Attach by artifact and semantics, not file extension alone. Record why a pack was selected. Security/API/data facts must not be dropped because a probabilistic classifier was uncertain. Keep the standard lookup path usable without a classifier.

Separate these generic packs from project facts. A project may point to KB rules about its tenancy model, integration boundaries, and migration practices. Do not hardcode one client's facts into a globally shared API or security pack.

Treat the transcript's ~100-line PR target and 80/15/5 test pyramid as advisory starting points, not universal hard limits. Establish actual mandatory constraints per project. Record exceptions rather than forcing artificial file splits or meaningless tests.

---

## 4. Proposed repository structure

```text
engineering-skills/
├── README.md
├── AGENTS.md                         # Maintaining this package, not a giant runtime prompt
├── LICENSE
├── NOTICE
├── package.json
├── skills/                          # Canonical public skill folders
│   ├── super-align/
│   ├── super-bound/
│   ├── super-scout/
│   ├── super-build/
│   ├── super-verify/
│   ├── super-review/
│   ├── super-ship/
│   ├── autopilot/
│   └── <all retained standalone skills from section 2>/
├── protocols/
│   ├── phase-operations/            # Shared implementations for manual/delegated calls
│   ├── consensus-plan-gate/
│   ├── tdd/
│   ├── apply-findings/
│   ├── review-delta/
│   ├── worktree-ownership/
│   └── invocation-authority.md
├── roles/
│   ├── supervisor/
│   ├── implementer/
│   ├── reviewer-spec/
│   ├── reviewer-standards/
│   ├── code-review/                 # CE persona catalog, not user commands
│   ├── doc-review/                  # Separate document persona catalog
│   └── plan-review/
├── packs/                           # Eight generic packs
├── references/
│   ├── engineering-principles/
│   ├── codebase-design/
│   ├── domain-modeling/
│   └── prose-quality/
├── schemas/
│   ├── skill.schema.json
│   ├── project.schema.json
│   ├── ticket.schema.json
│   ├── dossier.schema.json
│   ├── finding.schema.json
│   ├── review.schema.json
│   ├── verification.schema.json
│   ├── charter.schema.json
│   ├── decision.schema.json
│   ├── event.schema.json
│   └── lesson.schema.json
├── policies/
│   ├── invocation.yaml
│   ├── review.yaml
│   ├── authority-defaults.yaml
│   └── limits.yaml
├── templates/                       # KB documents and example artifacts
├── profiles/                        # Core, autonomy, product, maintainer; never models
├── adapters/
│   ├── claude-code/
│   ├── codex/
│   ├── runner-contract/
│   ├── knowledgebase/
│   ├── issue-tracker/
│   └── repository-events/
├── src/                             # Small deterministic helper library/CLI
│   ├── catalog/
│   ├── validation/
│   ├── artifacts/
│   ├── authority/
│   ├── review-ledger/
│   └── packaging/
├── provenance/
│   ├── upstream.lock.yaml
│   ├── conversation-map.yaml
│   ├── adaptations.yaml
│   └── licenses/
├── tests/
│   ├── schemas/
│   ├── policies/
│   ├── adapters/
│   ├── fixtures/
│   ├── scenarios/
│   └── evaluations/
├── examples/
└── .github/workflows/
```

The angle-bracket entry in the tree is layout shorthand for the inventory in section 2, not a file to generate. Generate a complete catalog manifest from that inventory and test it for missing entries.

A public skill directory should contain:

```text
super-review/
├── SKILL.md                 # Trigger, scope, workflow, hard boundaries, stop conditions
├── skill.yaml               # Versioned execution contract
├── references/              # On-demand guidance specific to this skill
├── assets/                  # Templates/examples
└── tests/                   # Positive, negative, adversarial behavior cases
```

Shared resources remain canonical in the source repository. Packaging must include their transitive dependencies in each installable bundle and verify that no installed skill references an unavailable sibling or a source-tree-only path.

Do not populate the repo by asking an agent to produce generic role descriptions for every folder. Each folder must have a concrete input/output contract and a behavioral test.

---

## 5. Shared contracts

### 5.1 Skill contract

Each skill must state its trigger, non-trigger examples, invocation authority, prerequisites, inputs, outputs, allowed side effects, required capabilities, child operations, hard gates, budget, failure outcomes, provenance, and tests.

Illustrative companion manifest:

```yaml
id: super-review
version: 0.1.0
kind: lifecycle
entrypoints:
  full:
    authority: explicit-or-delegated
  delta:
    authority: active-review-run
requires:
  - isolated-review-context
  - repository-read
  - artifact-write
inputs:
  - review-snapshot
  - project-standards
  - verification-receipts
outputs:
  - review-report
  - finding-ledger
constraints:
  reviewers-may-edit-source: false
  author-may-approve-own-change: false
limits:
  fix-cycles: 2
```

This is proposed package metadata, not a promise that native hosts recognize these keys. Adapters and the validator are responsible for interpretation.

### 5.2 Revision-bound artifacts

Every durable artifact should record its schema version, project/repo identity, run ID, creator role, input artifact IDs and hashes, source revision, timestamp, and status. A review must distinguish comparison base, reviewed head, and the last head verified during a delta loop.

Approvals bind to an artifact's hash or revision, not to its filename. A changed plan does not inherit the previous plan's approval. A changed patch does not inherit stale test receipts.

### 5.3 Tickets

A ticket contains its type (`decision` or `implementation`), approved work source, goal, non-goals, acceptance criteria, prerequisites, allowed files/symbols, likely read dependencies, named verification, stop conditions, and references to relevant KB facts.

A zero-context ticket is self-contained about intent and evidence. It does not require copying the whole repository into the packet or forbidding the implementer from performing follow-up reads.

Dependency edges are not sufficient for safe parallelism: check write ownership, shared generated artifacts, global migration numbering, and interface dependencies as well. Assign an integration owner.

### 5.4 Scout dossiers

Use structured hits containing repo, revision, path, symbol, line range, excerpt, relationship type, confirmed/assumed status, and index revision where applicable. Include searches attempted, coverage limits, unknowns, and a recommendation for additional inspection—not an architectural verdict.

Default to a four-turn budget, with multiple independent reads per turn where the host permits it. Lexical search is the baseline. GitNexus and Graphify are optional evidence providers, not prerequisites for installing the skill pack. Graph results need freshness and provenance; a stale or unavailable graph yields a documented limitation, not a fabricated complete impact map.

Source design: G:L1288–1337.

### 5.5 Findings

Keep the axes separate:

| Field | Meaning |
|---|---|
| `id` | Stable finding identity across fixes |
| `fingerprint` | Identity candidate using rule/cause, location/symbol, and evidence; not only line number |
| `severity` | P0–P3 impact |
| `confidence_anchor` | 0/25/50/75/100 evidence anchor, not a calibrated probability |
| `spec_quality` | `patch`, `sketch`, or `smell` |
| `difficulty` | `mechanical`, `local-judgment`, `cross-cutting`, or null when the solution space is still open |
| `autofix_class` | `safe_auto`, `gated_auto`, `manual`, `advisory` |
| `evidence` | Revision-bound locations and supporting observations |
| `suggested_fix` | A proposed remedy, not authorization |
| `verification` | What would demonstrate closure |
| `status` | Open, accepted, in-progress, awaiting-verification, resolved, deferred, rejected, or reopened |
| `authorization_ref` | Authority to apply a change or accept a disposition |
| `closure_receipt` | Independent evidence supporting resolution |

Map `specified → patch`, `bounded → sketch`, and `open → smell` explicitly, rather than carrying two competing vocabularies. A `smell` cannot be an automatic fixer ticket; sharpen the finding, diagnose, or escalate. Do not invent a difficulty assessment before a solution class is known.

Preserve P0–P3 as canonical severity. Nit/FYI are presentation/disposition labels rather than a lossy replacement for risk severity.

The originating specialist proposes specificity and difficulty. Synthesis may conservatively downgrade specificity or raise difficulty; it may not silently make a ticket easier or more authorized. Retain conflicting evidence. Reviewer agreement is not itself a reason to raise a nit's severity.

Source: G:L1083–1214; G:L1749–1757.

### 5.6 Verification receipts

A receipt contains the command or probe, exit status, relevant output or artifact digest, code revision, environment/configuration identity, and acceptance criteria it supports. Track `passed`, `failed`, `not-run`, `not-applicable`, and `inconclusive` separately.

An agent's description of green tests is not a receipt. A classifier cannot turn missing proof into passed. Test execution should occur in the appropriate isolated environment; repository test code does not get production secrets by default.

---

## 6. Review protocols

### 6.1 Keep the first CE panel

For a substantive feature, use independent correctness, testing, maintainability, and applicable project-standards reviewers. Add security and adversarial seats when input/trust boundaries, public APIs, money, data, change size, or other declared risks warrant them. This preserves the final six-persona-style first review without hardcoding six spawns for a typo.

Keep the broader catalog available: API contract, data migration, performance, reliability, agent-native behavior, prior learnings, frontend races, Swift/iOS, and deployment verification. Activate only relevant lenses. Project standards must cite actual rules; absent standards must not become invented preferences.

Each seat receives the same immutable patch snapshot plus its relevant requirements, standards, tests, and dependency context. It does not receive the implementer's narrative or another reviewer's judgments. Required-lane failure produces an unavailable/incomplete result and blocks an unqualified approval.

A low-confidence security concern remains visible and gets adjudicated; it is not silently discarded by a generic filtering threshold.

Source: G:L1872–1918. The independent-lane failure behavior is also present in the current OMX code-review source, S7.

### 6.2 Distinguish task checks from final review

The build loop can use lightweight spec and standards checks per ticket. These do not replace the assembled PR's first thorough panel. Likewise, the full PR panel does not run after every small ticket.

For the per-ticket Superpowers-style path, run spec compliance before spending effort on standards review. For the post-fix delta path, spec and standards can run independently in parallel against the same snapshot. Never share an implementer's approval context with a reviewer.

### 6.3 Delta closure

Persist the first review's finding list, input hashes, dispositions, and evidence. After accepted fixes, construct a packet containing the original findings, latest fix diff, touched dependencies, and verification receipts.

Spec review checks whether accepted findings and ticket obligations were actually addressed. Standards review checks whether the fixes introduced relevant regressions or new rule violations. Return unresolved security/data/API issues to the appropriate specialist without re-running every persona.

Allow at most two fix/verify cycles. Repeated failure leads to an explicit blocked/replan decision. New findings require an explanation of the new evidence or regression. Do not restart discovery for unrelated low-priority issues.

**Proposed safety refinement:** the transcript sometimes restricts new findings to changed lines. Use affected behavior as the boundary instead. A serious newly discovered issue in an untouched caller must remain reportable. Scope discipline is not a reason to suppress relevant evidence.

If architecture, requirements, comparison base, or the affected surface changes materially, invalidate affected approvals and deliberately establish a new baseline. That is a new review scope, not an unbounded third delta loop.

### 6.4 Reviewer continuity

“Fresh reviewer” means independent of the author, not ignorant of prior findings. A continuing specialist may retain its earlier finding context, or a replacement may receive a durable packet. Either must see the old finding and the new revision. Do not reset every closure check to amnesia.

### 6.5 Document review and consensus remain different

`doc-review` classifies requirements versus implementation plans from content. Its catalog includes coherence, feasibility, product, design, security, scope, and adversarial lenses. It emits Applied, Proposed fixes, Decisions, and FYI. Requirements get premise review; implementation plans with approved requirements do not reopen product choices without relevant new evidence.

Safe correction of an already-authorized fact can be applied under policy. Contradictory product choices are Decisions. Persist the primer, fingerprints, evidence snippets, settled decisions, and input revisions for subsequent passes.

The consensus-plan gate emits a whole-plan result, unlike doc-review's finding buckets. Preserve architect-then-critic ordering on a fixed snapshot and a five-round limit. Independence comes from isolated evidence packets, not merely from sequential scheduling. Invoke it for genuine architectural disagreement, high-risk planning, or a review-driven replan—not automatically on every bound invocation.

Source: G:L610–740; G:L246–255; S8.

---

## 7. Invocation and autopilot authority

### 7.1 Resolve the manual-only conflict explicitly

The transcript simultaneously prohibits user-invoked skills from starting other user-invoked skills, makes compound human-invoked, has ship call compound, and lets autopilot operate user gates. Do not encode all four statements literally.

Proposed resolution: separate the public entrypoint from the shared phase operation. A human can invoke a public entrypoint. A delegated controller can invoke an exposed phase operation only when a runner-validated grant covers it. Ordinary model workers cannot manufacture a grant or start a new gated phase.

Public wrappers and autopilot use the same shared protocol, so there is no second pipeline. A native host's manual-only skill restriction remains respected. Where that host cannot support a separately authorized internal operation, stop for explicit invocation rather than reproducing a forbidden command's effects through an alternate path.

Compound remains independently available. Ship can create a lesson candidate automatically, but publishing it requires either explicit authorization or a charter grant for KB publication. It must not treat “ship happened” as permission to rewrite project knowledge.

### 7.2 Autopilot charter

The charter is fixed outside worker-writable scope and identified by a hash. It contains the work source, repos and branches, artifact destinations, allowed capabilities, denied actions, budgets, stage/loop limits, and the exact checkpoint categories the supervisors may decide.

Defaults derived from the conversation:

- Allowed within scope: answer bounded alignment questions, approve eligible spec/ticket artifacts, start approved implementation tickets, adjudicate eligible findings, commit/push/open a PR, and publish a supported lesson when granted.
- Not granted by default: merge, deployment, production credentials, destructive data operations, new dependencies, public-contract redesign, sensitive trust-boundary changes, and scope expansion.
- Two fix cycles; three bounded CI-repair attempts; explicit caps for alignment, tickets, elapsed time, and host-provided resource consumption.

Cost accounting, when available, is passed in by the runner. This repo does not calculate provider prices or choose models.

The sensitive-change defaults are intentionally conservative because that is how the final charter is written. More autonomy requires the human to approve a more specific capability up front, not the pair deciding to enlarge its own authority.

### 7.3 Checkpoint decisions

For each authorized checkpoint, freeze a decision card with question, bounded options, evidence references, and affected artifact hashes. Dispatch two independent supervisor judgments. Each returns a choice, concise rationale, unresolved assumptions, and escalation flag.

The policy checks authority deterministically. Agreement supports a decision only when the required evidence is present and the charter permits it. Confidence alone cannot grant authority. Disagreement, missing evidence, a supervisor failure, or an out-of-charter action blocks the checkpoint. Do not add a tie-breaking supervisor to avoid asking the human.

Supervisors do not implement or approve their own patches. Reviewers remain separate from the planning and implementation lanes even when the same provider is used externally.

### 7.4 Runtime state and termination

The host-neutral state machine should distinguish:

`created → grounding → alignment → planning → building → verifying → reviewing → repairing → ready-to-ship → pr-open → complete`

Route bugs through diagnosis and allow appropriate intermediate entrypoints. At any state, return one of `needs-input`, `cap-reached`, `failed`, or `cancelled`. Store the next permitted action and checkpoints so a restart does not repeat side effects.

State transitions validate prerequisites, evidence freshness, authority, and budgets. Branch creation, pushing, posting comments, resolving threads, and PR creation use idempotency keys plus read-back checks.

An escalation reports the one decision needed, options, evidence already gathered, recommended default, triggering charter rule, and blocked ticket/finding. Stop new writes and shipping; explicitly permitted read-only work may continue within budget. Persist the state and return control to the runner rather than leaving an agent polling forever.

### 7.5 CI repair must not weaken the bar

The transcript's “test failures only” rule limits the purpose of the repair; it is not permission to edit tests until they pass. No skipped checks, weakened assertions, lowered thresholds, or removed coverage without a separate decision. A required product-code change goes through diagnosis, a bounded patch, new verification, and affected delta review.

---

## 8. Knowledgebase integration

The skills package contains reusable templates and behavior. Durable project instances go to a configurable KB root, for example:

```text
knowledgebase/projects/<project-id>/
├── CONTEXT.md
├── standards/
├── decisions/
├── requirements/
├── plans/
├── tickets/
├── reviews/
├── solutions/
└── runs/                    # Sanitized durable receipts and rulings
```

The exact directory names are configurable; the central ownership is not. Store tracker IDs and URLs as links to the authoritative ticket record. Choose one ticket system of record and project to the other representation, rather than maintaining two independent statuses.

Expose a narrow adapter for `readContext`, `recordDecision`, `publishArtifact`, `linkCodeEvidence`, `requestImpactAnalysis`, `linkPullRequests`, and `proposeLesson`. These names describe proposed operations, not existing APIs.

Preserve the user's paired-PR requirement: source PRs link to associated KB PRs, and a source merge event activates the existing KB merge coordinator. The coordinator must still honor checks, protection rules, all related source dependencies, and retry/idempotency rules. This is not an atomic cross-repository merge. A blocked KB merge remains visible and retryable rather than being falsely reported as complete.

Add required-documentation/indexing status to ship evidence. Do not force a fresh ADR for a mechanical fix with no decision; record the applicable existing decision or an explicit no-new-decision result according to the KB policy.

`compound-refresh` changes curated knowledge with provenance. `writing-skills` can turn a supported lesson into a candidate skill change, but promotion requires evaluation and a separate review. A failed skill revision can roll back without rolling back the underlying lesson/evidence history.

---

## 9. Implementation sequence

Each milestone ends with a usable, independently testable deliverable. Do not start with a giant prompt-writing batch or build the autopilot first.

### Milestone 1 — Source map and behavioral specification

Create `provenance/conversation-map.yaml`, `provenance/upstream.lock.yaml`, `provenance/adaptations.yaml`, the full catalog manifest, and bundled attribution records. For each source capability, record retained/folded/reference/optional/excluded status, destination, source locator, and acceptance test.

Pin all four main donors and the relevant OMC/OMX source files. Inspect licenses before copying. Record proposed differences: central KB storage, delegated authority, evidence-based closure, delta impact exceptions, canonical severity, and advisory numeric heuristics.

Acceptance: every retained conversation capability has a destination; every fold has a replacement; excluded model-routing content cannot enter runtime policy; no fictitious upstream paths or placeholder skill bodies are accepted.

### Milestone 2 — Artifact contracts and validators

Implement schemas, versioned artifact envelopes, catalog validation, permission categories, transition checks, and findings ledger state changes. Keep the library synchronous/pure where possible; the host supplies execution and storage effects.

Write tests first for the core invalid cases: stale approval, missing verification, open/smell finding dispatched to a fixer, decision ticket dispatched as implementation, unsupported required capability, an author closing its own finding, and a forged grant.

Acceptance: these invalid transitions fail deterministically. A valid fixture run can be resumed from its artifacts without the original chat transcript.

### Milestone 3 — One thin engineering slice

Start from an approved fixture ticket. Implement super-scout, super-build/TDD, super-verify, super-review full/delta, apply-findings, and super-ship in dry-run mode. Use lexical reads and an ordinary temporary git repository; no graph dependency yet.

Seed a bug, obtain an independent finding, fix only the accepted item, run the named check, and close the finding through independent delta verification. Generate a PR payload locally rather than publishing remotely during tests.

Acceptance: one bounded change completes end to end with receipts; a missing reviewer or failed test blocks shipping; a second run does not duplicate a commit/PR action; a third fix cycle is refused.

### Milestone 4 — Planning and independent judgment

Implement super-align, super-bound, doc-review, the consensus-plan gate, wayfind, prototype, ideate, pov, bakeoff, doubt-driven, and external research/source-driven support.

Use fixtures with an internal contradiction, an unapproved product fork, a plan whose file assumptions are stale, a new evidence-backed issue, and a previously settled decision. Test that product and implementation concerns are kept separate.

Acceptance: an executor receives a self-contained approved work packet; unresolved decision tickets cannot execute; doc-review cannot silently choose a product fork; the consensus gate stops after its cap.

### Milestone 5 — Packs, maintainers, and knowledge capture

Implement all eight packs, compound, compound-refresh, handoff, wait-what, simplify, diagnose, improve-architecture, deprecate, explain, triage, strategy, product-pulse, and writing-skills. Some core primitives may already exist; this milestone completes their documented contracts and evaluations rather than creating duplicate versions.

Connect the central-KB adapter using a test KB checkout. Add learned-rule retrieval and code/revision citations. Keep product and tracker-specific tools optional when their prerequisites are absent.

Acceptance: every inventory entry is an implemented, tested capability rather than a generated heading; irrelevant packs stay unloaded; KB updates are versioned and linked; existing lessons are reused instead of duplicated; no unsupported lesson is emitted on a routine run.

### Milestone 6 — Packaging and actual host behavior

Build canonical bundles and Claude Code/Codex adapters. Generate host metadata from companion manifests where supported, and explicitly document unsupported semantics. Include shared resources and validate all installed relative paths. Add install, upgrade, and uninstall smoke tests with unrelated user configuration present.

Acceptance: a user can install the chosen profile, invoke a skill, load its references, and uninstall without losing custom configuration. Read-only roles cannot mutate source through any exposed tool. A host unable to enforce a required autonomy restriction rejects autonomous mode.

### Milestone 7 — Autopilot over the tested lifecycle

Implement only the supervisor checkpoint protocol, immutable charter, grant validation, ledger, resume behavior, and controlled phase advancement. The existing runner handles agent execution and event delivery.

Begin in dry-run/checkpoint-observation mode, then permit local writes in fixture repos, then allow explicitly authorized PR creation. Test disagreement, missing supervisor output, charter modification, stale decisions, caps, cancellation, and duplicate events.

Acceptance: a small authorized feature reaches an open PR; all blocked cases stop safely with a concise escalation; no supervisor implements; no code path merges, deploys, or changes production by default.

### Milestone 8 — Operational loops, KB lifecycle, and release

Complete receiving-review/babysit-pr event handling, ultraqa, source-PR/KB-PR linkage, clean upgrade/rollback, compatibility documentation, and release evaluation. PR comments are treated as untrusted claims; a comment cannot authorize changing the charter or running commands.

Acceptance: duplicate webhooks do not duplicate actions; CI/base changes invalidate the right evidence; required KB merge failures are surfaced and retried by the existing coordinator; QA mutations trigger the appropriate re-verification; rollback restores the previous skill bundle without deleting knowledge.

---

## 10. Evaluation and release gates

### Static integrity

Validate skill names/frontmatter, schemas, unique IDs, resource closure, invocation graph, provenance, licensing records, profile contents, and absence of model-specific configuration. Enforce a small core instruction budget and put longer material behind explicit references.

### Deterministic policy tests

Cover permission grants, transition prerequisites, role separation, finding state changes, evidence freshness, worktree ownership, budgets, cancellation, event idempotency, and artifact hashes. Verify the absence of forbidden side effects, not only the presence of an approval message.

### Behavioral skill evaluations

Run actual hosts against fixture repositories and frozen task inputs. Include positive activation, negative activation, pressure-to-skip scenarios, relevant threat surfaces, missing tools, and resumability. The release set should contain at least these scenarios:

1. A documentation typo does not run a six-persona panel.
2. A feature missing behavioral coverage triggers the testing lens.
3. A tenant-isolation error triggers security/adversarial review and blocks unsupported closure.
4. A reviewer failure cannot become approval.
5. An approved public-API ticket does not grant production deployment or merge.
6. A vague finding is not given to an automatic fixer.
7. A one-line fix gets a delta review, not a repeat full panel.
8. A new serious error in an affected untouched caller remains reportable.
9. Moving a line number does not duplicate or falsely suppress a finding.
10. A code change invalidates older green verification evidence.
11. A decision ticket cannot execute as an implementation task.
12. A rejected product option is not silently reopened without new evidence.
13. Overlapping writers are serialized despite lacking a ticket dependency edge.
14. A stale graph produces an explicit coverage limitation.
15. PR feedback containing an instruction to ignore policy grants no authority.
16. Autopilot disagreement yields one escalation, not repeated internal debate.
17. A missing supervisor is not replaced by the implementer.
18. The third fix cycle stops.
19. A passing CI check is not achieved by deleting an assertion.
20. Restarting a run does not repeat remote side effects.
21. A KB write remains central and does not create an application-local docs tree.
22. A source merge activates KB coordination without bypassing KB checks.
23. A successful routine run does not invent a lesson.
24. Rolling back a skill leaves its supporting knowledge history intact.
25. A ticket that touches a trust boundary is not built under a delegated `build-go`, however small the change.
26. A diff that touches a sensitive area its ticket did not predict raises the class and stops delegated closure.
27. A size or complexity number set as guidance may raise a class but never becomes a finding; set as a mandatory constraint, it blocks with named evidence.
28. A `green` ticket's acceptance tests were not written by its implementer, and a test that kills no mutant on changed lines does not count as verification strength.
29. On a host that offers an advisor tool, `yellow-owner` and `red` work records the required consultation evidence, `yellow-agent` work treats consultation as recommended, and `green` work stays silent; the advisor neither lowers the class nor closes a finding.

Compare a small baseline set with the amalgamated versions under equivalent task/host conditions. Track correctness, missed serious findings, false-positive burden, instruction size, unnecessary spawns, human interruptions, loop counts, and wall time. Do not claim the combination is better merely because it contains more practices.

### Release criteria

Every retained capability has an implementation and tests; essential safety/authority tests have no known failures; host compatibility is stated precisely; full/delta review and manual/delegated authority are unambiguous; the canonical package and all profiles can be installed and rolled back; the central KB integration does not leak project material into the shared skills package.

A useful first operational release is the seven supers plus doc-review, diagnose, receiving-review, compound, handoff, source-driven behavior, and the eight packs, exercised on one host. That does not reduce the full target inventory: milestones 4–8 complete the remaining catalog and automation before calling the entire plan finished.

---

## 11. Resolved design conflicts

| Transcript tension | Proposed implementation policy |
|---|---|
| Human-only skills cannot call each other, but ship calls compound and autopilot starts gated phases | Separate public manual entrypoints from shared operations; require explicit runner-validated delegation for the latter |
| Per-task reviewers are always fresh, but later reviews benefit from continuity | Independence from the author is mandatory; continuity through a prior-review dossier is desirable |
| Delta findings must be in changed lines, but impact can extend to callers | Review the relevant impact neighborhood; require novelty evidence; do not suppress serious newly discovered issues |
| Classifier confidence is used to mark fixes resolved | Only independent verification evidence and policy can close a finding; classifier output remains advisory |
| Numeric PR/test heuristics appear as broad rules | Preserve as configurable guidance, not universal hard gates |
| Both diagnose and build can contain the bug patch | Diagnose may produce a verified bounded patch under grant or a diagnostic work packet; never blindly implement the patch twice |
| CI repairs are described as tests only | Restrict purpose and scope, not permission to weaken tests; source changes re-enter the normal evidence path |
| Prototype can be called under automation, but human experience is the evaluation target | Technical experiments can use automated criteria; human-experience validation remains blocked without a human |
| Code and documentation defaults are repo-local | Central KB owns all project-derived artifacts; skills repo owns reusable instructions and templates |
| Need all skills, but want small context and one lifecycle | Full catalog plus opt-in profiles and on-demand references; no duplicate donor lifecycles |

These resolutions are proposed engineering decisions, not claims that the Grok conversation already specified them consistently.

## Primary-source implementation references

Use these as discovery roots. Resolve actual commit pins and relevant source-file licenses during milestone 1; the following are not immutable source pins.

- S1 — Agent Skills specification: `https://agentskills.io/specification`
- S2 — Claude Code skill controls and permission semantics: `https://code.claude.com/docs/en/skills`
- S3 — Compound Engineering source: `https://github.com/EveryInc/compound-engineering-plugin`
- S4 — Superpowers source: `https://github.com/obra/superpowers`
- S5 — Matt Pocock skills source: `https://github.com/mattpocock/skills`
- S6 — Addy Osmani agent-skills source: `https://github.com/addyosmani/agent-skills`
- S7 — OMX independent code-review contract: `https://github.com/Yeachan-Heo/oh-my-codex/blob/main/skills/code-review/SKILL.md`
- S8 — OMC consensus plan-review contract: `https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/skills/ralplan/SKILL.md`

## Recommended starting point

Create the source-to-capability map and the contracts first. Then prove one approved-ticket → patch → verification → full review → fix → delta review → dry-run PR path. Author the remaining skills against those contracts, and add autopilot only after that path behaves correctly.

The reusable asset is not a large collection of prompts. It is one coherent set of engineering behaviors, with explicit authority, evidence, provenance, and tests.
