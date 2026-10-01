# Verifier-seat design scout

Date: 2026-09-30  
Repository revision: `5b0522705dd4cb8b8245a17e0a81875531d5bd8d`  
Mode: investigation only; no repository file was changed, no eval or test was run, and nothing was
pushed or opened remotely.

## Executive recommendation

Agent-kit should keep `super-verify` as its existing model-invoked evidence phase and add one
non-entrypoint core role, `verifier`. `super-verify` seats that role in an independently assigned
context, gives it a frozen claim/criteria/revision/recipe packet without the implementer's narrative,
and accepts only verification receipts plus the acceptance-to-evidence matrix back. A verifier is
never the implementer, author, spec approver, or a seat already used on the same decision.

The deterministic ship predicate should grow from “a current passed receipt covers every criterion”
to three checks: current behavioral evidence covers every criterion; a runner-attested verifier seat
distinct from the implementer produced it wherever such a seat is declared available; and every
frontend/backend criterion has the project-declared evidence kind it requires. The package should
use the existing `independent-context` capability, not create a verifier-specific capability, but
correct its host status to fail closed: the two shipped hosts can create fresh contexts, yet neither
attests independence. A runner can.

Claude's durable launch recipe should be reproduced functionally as a content-addressed,
host-neutral verification-recipe artifact in the central knowledgebase. Literal emission of
`.claude/skills/verify/SKILL.md` would violate agent-kit's central-KB and host-neutral rules; an
optional host bridge can import/export that file only if the captain deliberately changes those
rules.

Confidence: high on the repository gap and gate design; medium on literal Claude parity because the
public docs describe behavior, not the bundled prompt's full internal algorithm.

## Investigation record

Read in full or by the relevant numbered sections: `AGENTS.md`; `AUTHORING.md` §§1–12.5;
the seven super-skill bodies and sidecars; every `evals/super-verify/*/case.yaml`; `reviewer-spec` and
`supervisor`; the three host/runner contracts; the verification, project, ticket, and common schemas;
`src/lifecycle/gate.ts`; invocation policy/doctrine; the three named rulings; batch 11; ADR-0002,
0004, and 0005; and the mission-brief workstream shape. The working tree was clean at the start.

Commands used were read-only: `git rev-parse HEAD`, `git status --short`, `rg`, `find`, `wc -l`,
`nl -ba`, and `sed`. The installed `omx explore` command was attempted once because `AGENTS.md`
prefers it for simple lookup; it reported that the surface is hard-deprecated, so normal repository
inspection was used. The two cited Claude pages were fetched from the official documentation on
2026-09-30.

## 1. What Claude `/verify` actually does

### Documentation says

1. `/verify` is a bundled skill that runs only when explicitly invoked; bundled skills are prompts
   that orchestrate tools. The docs describe it as: “Build and run your app to confirm a code change
   does what it should,” explicitly contrasting this with falling back to tests/type checks.
   ([Skills — Run and verify your app](https://code.claude.com/docs/en/skills#run-and-verify-your-app))
2. It works against a running application. It infers how to launch from project type and project
   files when no recipe exists, and the docs acknowledge that inference becomes unreliable for
   nonstandard setup.
3. When it has to discover how to build and drive the application, it records the successful install,
   environment, launch, and drive recipe at `.claude/skills/verify/SKILL.md` at repository root, or
   in the touched package for a monorepo. At repository root that project skill replaces the bundled
   `/verify`. It changes the recorded recipe only after the recipe steers a run incorrectly.
4. The best-practices page separately recommends a second-opinion verification subagent: a fresh
   context tries to refute the result so the author is not grading itself. It says to “show evidence
   rather than asserting success,” such as command output or a screenshot.
   ([Best practices — Give Claude a way to verify its work](https://code.claude.com/docs/en/best-practices#give-claude-a-way-to-verify-its-work))

### Inferences, not documentation claims

- The public pages do not say that `/verify` always creates a subagent, nor that the subagent uses a
  different provider or family. “Fresh model” appears in the general second-opinion recommendation,
  not as a guaranteed `/verify` implementation detail.
- The pages do not publish the bundled prompt or a closed receipt schema. Exact internal ordering,
  retry behavior, and provenance metadata are therefore unknown from these sources.
- “Works exactly like Claude” can be met behaviorally across hosts—launch, drive, persist the working
  recipe, and show evidence—but cannot mean writing the same host-specific path on every host.

### Behavior map and gaps

| Claude behavior | Agent-kit already has | Missing design input |
|---|---|---|
| Build/run/drive the real application | `super-verify` resolves criteria, discovers project commands, runs them fresh, and records receipts (`skills/super-verify/SKILL.md:80-120`) | Its discovery list foregrounds tests/build/typecheck and does not require a running-app trial when a runnable surface exists (`skills/super-verify/SKILL.md:82-90`) |
| Do not substitute tests/typechecks for runtime behavior | A criterion with no realistic check stays visible as not-applicable/inconclusive (`skills/super-verify/SKILL.md:86-88,151-156`) | No rule says a test receipt cannot satisfy a frontend/backend runtime criterion |
| Persist a recipe that later agents reuse | Commands are discovered, and prior receipts are retained as revision-bound history (`skills/super-verify/SKILL.md:67-78`) | No durable setup/build/launch/readiness/drive/cleanup recipe artifact; published outputs are receipts, matrix, and invalidations only (`skills/super-verify/SKILL.md:167-182`) |
| Evidence rather than prose | Receipts carry mechanism, result, output digest, revision, environment, and supported criteria (`schemas/verification.schema.json:19-45,59-76,95-143`) | No verifier-seat lineage or runner attestation on a receipt |
| Screenshots/traces/logs | Receipt artifacts already admit `screenshot`, `trace`, and `log` (`schemas/verification.schema.json:81-93`) | The gate copies/checks only the artifact matching `output_digest`; additional artifact digests can disappear without affecting the verdict (`src/lifecycle/gate.ts:423-464,966-975`) |
| Fresh second opinion | Review/build already exclude implementers from independent seats (`skills/super-build/SKILL.md:73-76,158-166`; `skills/super-review/SKILL.md:112-124,162-174`) | `super-verify` declares no role or `independent-context` requirement, and currently says an implementer invocation can still close evidence (`skills/super-verify/SKILL.md:47-56`; `skills/super-verify/skill.yaml:41-55`) |
| Deterministic completion gate | `verify` is a pre-ship gate; opened runs store receipt references and the gate checks task, revision, environment, output, check id, and AC coverage (`src/lifecycle/gate.ts:161-170,840-1010`) | The predicate records no verifier seat, recipe digest, surface, or evidence kind |
| Explicit `/verify` invocation | Agent-kit has one existing `super-verify` lifecycle skill (`catalog.yaml:90-99`) | It is model-invoked, not a new public slash entrypoint (`policies/invocation.yaml:82-96`). Adding one needs a ruling and is not recommended |

The current super-verify evals protect freshness, truthful zero-exit interpretation, complete matrices,
no repair, and no laundering of caller assertions (`evals/super-verify/named-criterion-gets-a-receipt/case.yaml:13-29`,
`evals/super-verify/zero-exit-output-failure/case.yaml:13-31`,
`evals/super-verify/no-realistic-check-is-recorded-not-skipped/case.yaml:12-29`). None exercises a
running application, a durable recipe, a verifier seat, or surface evidence.

## 2. Independent verifier seat

### Why a new role is warranted

`reviewer-spec` judges whether obligations were addressed from a fixed diff and explicitly says the
independent receipt is a separate closure input (`roles/reviewer-spec/ROLE.md:3-24,26-50`). It returns
findings, not runtime receipts (`roles/reviewer-spec/ROLE.md:80-103`). `supervisor` judges a chartered
decision card and never implements or reviews a change (`roles/supervisor/ROLE.md:3-18`). Reusing
either would blur a boundary. Add `roles/verifier/ROLE.md`; it is a role prompt filled by the runner,
not an agent entrypoint, exactly the role shape `AUTHORING.md` defines (`AUTHORING.md:2148-2177`).

### Seat contract

The seat judges one question: whether the frozen claim is established by executing the supplied
recipe/checks at the supplied revision in the supplied environment.

It must receive only:

- claim and acceptance criteria by id;
- frozen revision plus working-tree diff hash;
- content-addressed recipe id/digest and its permitted setup/build/launch/readiness/drive/cleanup
  steps;
- the exact commands/probes it may run, the environment identity, and the project-declared surface
  evidence requirements;
- prior receipt ids only when needed to mark staleness/invalidation;
- no implementer transcript, narrative, rationale, self-review, claimed result, or reviewer verdict.

It may never be filled by the implementer, change author, spec approver, recipe/oracle author for this
change, or a seat already sitting on the same decision. This applies the exclusion set of
`missing-supervisor-never-implementer`, whose ruling forbids backfill by implementer, author, spec
approver, or an existing seat (`policies/resolved-conflicts.yaml:796-815`). Add `super-verify` and the
new `verifier` role to that ruling's bindings.

It returns no prose approval. It returns:

- one existing-schema `verification` receipt per executed or unexecutable check;
- the existing acceptance-to-evidence matrix derived from those receipts;
- a recipe artifact only when discovery produced a complete successful recipe;
- `unavailable` with a reason when it cannot be seated or supplied its required context.

Extend each receipt with `recipe: {id, hash}`, `evidence_kind`, and
`verifier_seat: {id, implementer_seat, isolation, attestation}`. `created_by.role` becomes
`verifier`; the existing envelope already requires a creator role (`schemas/common.schema.json:182-190,240-255`).
`isolation` is `runner-attested` or `host-unattested`; the latter is a valid guided/manual fact but
does not satisfy autonomous closure.

### Host filling and capability level

Use existing capability `independent-context`, not a new verifier-specific row. It already exists in
the shared enum (`schemas/common.schema.json:285-305`). The present `partial` status is not safe for
this job because capability ceilings treat only `not-provided` as blocking
(`src/packaging/capability-table.ts:48-76,264-299`).

| Path | Present evidence | Proposed effective level and behavior |
|---|---|---|
| Claude Code host alone | Fresh-context subagents exist, but the host cannot attest what they saw (`adapters/claude-code/CONTRACT.md:98-117`) | `independent-context: not-provided` for attested independence. A fresh subagent may produce `host-unattested` receipts in guided/manual mode; it cannot satisfy autonomous verification |
| Codex host alone | Codex inherits every capability status from the Claude table, including independent context (`adapters/codex/CONTRACT.md:75-93`) | Same `not-provided` level and guided behavior. Native child sessions are useful execution contexts, not an independence attestation |
| Runner-contract attached | Runner assigns seats and attests distinct ids, no shared context, and excluded lineage (`adapters/runner-contract/CONTRACT.md:128-165`) | Add `independent-context` to the runner's supply table as `fails-closed`. It is effectively satisfied only when that attestation is recorded outside worker-writable scope |

Add both `independent-context` and `trusted-evidence` to `super-verify.requires`. Host-only packaging is
capped at `guided`. With the runner adapter attached, the ceiling is lifted, but an unconfigured or
incapable runner returns `needs-input`/`unavailable`; it never silently degrades. This follows the
existing ceiling rule (`adapters/claude-code/CONTRACT.md:163-190`) and the runner's evidence refusal
(`adapters/runner-contract/CONTRACT.md:115-124`). The explicit/guided path remains useful and honest;
its receipts are worker-attested and cannot authorize an autonomous ship.

## 3. Model-family wish versus structural independence

The package rule is unambiguous: independence is structural and “never a model identity”
(`AUTHORING.md:835-866`; `protocols/invocation-authority.md:87-98`). The runner, not the package,
chooses who fills a role and attests distinct seat ids/context/lineage
(`adapters/runner-contract/CONTRACT.md:26-38,128-149`). The package also forbids committed routing,
provider, pricing, and family language outside exempt source trees (`AUTHORING.md:835-862`).

Reconciliation: declare the verifier seat independent; let a host or runner configuration outside
agent-kit prefer a different family when it can; never make that preference evidence or a pass
condition. This preserves agent agnosticism and gives capable deployments the diversity the captain
wants.

The wish is not guaranteed in practice by any shipped contract today. The two host contracts expose
no package-controlled family selection, and the runner contract says the package selects and
schedules nothing (`adapters/runner-contract/CONTRACT.md:26-38`). Guaranteeing cross-family execution
would require a captain ruling that reverses the structural-only rule, amends the denylist/model-strip
policy, adds host/runner configuration and attestations, and accepts that installations lacking two
families become unavailable. That cost is broad and weakens host agnosticism. Do not conflate this
optional deployment preference with the correctness gate.

## 4. Surface-specific evidence

### Smallest enforceable representation

A shared reference pack alone cannot make ship refuse; it is prose. A receipt enum alone cannot tell
which criterion required which kind. Use a small schema-plus-reference design:

1. New `references/verification-evidence/REFERENCE.md`, loaded by align, bound, build, verify, review,
   and ship—not scout. It defines recipe semantics and evidence-kind-to-artifact mappings. Reference
   packs are shared mid-task material with an explicit `loaded_by` access surface
   (`AUTHORING.md:2639-2689`).
2. `project.verification_recipes[]` declares what exists: scoped setup/build/launch/readiness/drive/
   cleanup steps, environment references, and available evidence kinds. Bodies never assume a
   browser, running service, or trace collector. This follows the existing project-declared command
   pattern (`schemas/project.schema.json:205-232`).
3. `ticket.acceptance_criteria[].surface` is optional `frontend|backend|none`;
   `ticket.verification[]` gains `recipe` and `evidence_required[]`. The existing ticket already binds
   named checks to criteria (`schemas/ticket.schema.json:36-47,78-96`).
4. `verification.evidence_kind` is optional for compatibility and required by the gate whenever the
   ticket check declares one. Keep `kind: command|probe|manual` as execution mechanism. Add an
   `api_response` object requiring numeric `status` and `body_digest` for `api-response`.
5. `record --gate verify` copies every declared artifact by digest, not only `output_digest`; ship
   re-hashes all evidence artifacts. This repairs the current multi-artifact loss
   (`src/lifecycle/gate.ts:423-464,966-975`).

Evidence-kind enum and required representation:

| Surface | `evidence_kind` | Receipt evidence |
|---|---|---|
| frontend | `rendered-screenshot` | `artifacts[].kind: screenshot` plus digest |
| frontend | `user-path-trial` | command/probe, complete outcome digest, and driven path in probe parameters |
| frontend/backend | `trace` | `artifacts[].kind: trace` plus digest |
| frontend/backend | `log` | `artifacts[].kind: log` plus digest |
| backend | `api-response` | response status plus body digest; add artifact kind `response` |
| backend | `dry-run` | command/probe and complete output digest |
| backend | `smoke-test` | command/probe and complete output digest against the running service |

The project chooses one or more kinds per check. These are not universal “run all seven” gates. A
frontend criterion with no declared browser or screenshot facility remains visible as `not-run` or
`inconclusive`; neither a body nor a verifier invents a facility.

### Where each super skill participates

| Skill | Evidence responsibility | Body change |
|---|---|---|
| `super-scout` | Locates code and declarations only; runtime evidence would violate its gather-not-judge boundary (`skills/super-scout/SKILL.md:27-40,95-122`) | None |
| `super-align` | Makes success observable at product level; names user path/request and surface, never a tool | Add to the six-field restatement |
| `super-bound` | Binds each AC to a project-declared recipe and evidence kinds | Add project declarations as input and ticket fields in workflow |
| `super-build` | Produces implementer self-checks and hands frozen inputs to independent verification; its receipts cannot close | Replace final verification wording and add a self-check gate |
| `super-verify` | Launches/drives, seats verifier, produces recipe/receipts/matrix, and refuses test-only substitution for runnable surfaces | Main workflow/gate change; load the reference |
| `super-review` | Consumes, never produces, receipts; readiness exposes missing seat/kind coverage | Four-line readiness hook only |
| `super-ship` | Deterministically refuses missing seat or surface-kind coverage before any remote effect | Extend step 3 and its hard gate |

Exact body text is in Appendix A.

## 5. “Truly done”

Today `super-ship` calls the lifecycle check before preflight and requires `build-checks`, `verify`,
`review-full` (or current delta), and `review-readiness` (`skills/super-ship/SKILL.md:92-122`;
`src/lifecycle/gate.ts:161-170`). For opened/evidence-bearing runs, the evaluator currently requires
every ticket criterion to have a current passed receipt and refuses missing, failed, unstable, wrong
task/revision/environment/check, invalidated, or missing-output evidence
(`src/lifecycle/gate.ts:840-1010`).

Add these predicates:

1. Every criterion has a current passed receipt.
2. When independent verification is declared available, every counted receipt names a runner-attested
   verifier seat whose id differs from the build gate's implementer seat.
3. Every `frontend`/`backend` criterion has every `evidence_required` kind on a current counted receipt,
   with the corresponding artifact present and digest-valid.
4. Each counted receipt names the recipe digest used; a changed recipe or project declaration makes it
   stale just as changed code does.
5. No test/typecheck receipt substitutes for runtime evidence required by a runnable surface.

Exact refusal text:

```text
refused: criterion AC-3 requires frontend evidence rendered-screenshot, but no current receipt at <revision>/<diff-hash> carries that evidence kind
refused: receipt verify-ac-3 was produced by implementer seat build-1; an independent verifier seat is required
refused: verifier seat verify-1 is host-unattested; autonomous ship requires a runner attestation
```

The distinction between advisory and enforced remains important. Local records and host-unattested
seat claims are worker-attested evidence: useful in guided/manual work, never authorization. The
skill's deterministic predicate may return `needs-input`, but it is not a security boundary. Only a
runner can enforce identity, excluded lineage, non-worker-writable evidence storage, and the
autonomous transition. `protocols/invocation-authority.md` explicitly distinguishes protocol claims
from runner enforcement and says missing ordinary evidence is surfaced, while identity/scope/
corruption checks fail closed (`protocols/invocation-authority.md:66-85`). Autonomous ship already
requires `trusted-evidence` (`skills/super-ship/SKILL.md:68-71,160-163`); verifier attestation joins
that runner-owned evidence.

## 6. Sequencing with batch 11

Batch 11 must land first. Its `structural-checks` pack gives super-verify project-declared structural
and mutation commands, while this design adds running-surface behavior. Structural receipts remain
advisory unless a project names them in `mandatory_constraints`; surface receipts satisfy ticket
acceptance only when the ticket names them. This preserves batch 11's ruling
(`research/briefs/batch-11-delegation.md:71-102`; `policies/resolved-conflicts.yaml:1244-1265`).

Files both efforts touch or coordinate through:

| Exact/shared file | Batch 11 use | This design use |
|---|---|---|
| `skills/super-align/SKILL.md`, `skill.yaml` | vague-term pass | observable surface/success declaration |
| `skills/super-bound/SKILL.md`, `skill.yaml` | delegation/readiness/assumptions and delegation loader | AC surface/recipe/evidence declarations and verification-evidence loader |
| `skills/super-build/skill.yaml` | owns the independent-oracle eval through TDD | mirrors implementer-vs-verifier receipt constraint; body change is otherwise separate |
| `skills/super-verify/SKILL.md`, `skill.yaml` | delegation + structural-checks loaders and hooks | verifier seat, running-app recipe/evidence, capabilities |
| `skills/super-review/SKILL.md`, `skill.yaml` | merge-time class and advisor hook | readiness consumption of verifier/surface evidence |
| `skills/super-ship/SKILL.md`, `skill.yaml` | PR class/factors/sensitive areas/rollback | final seat and surface-evidence refusal |
| `schemas/project.schema.json` | project checks/protected tests/delegation guidance | verification recipes and available surface evidence |
| `schemas/ticket.schema.json` | delegation/readiness/assumptions | AC surface and check evidence requirements |
| `schemas/verification.schema.json` | structural/mutation receipt semantics | verifier lineage, recipe and evidence kind |
| `src/lifecycle/gate.ts` | gate class/author/host fields | verifier-seat/artifact/surface predicates |
| `policies/resolved-conflicts.yaml` | batch-11 ruling bindings | extend independence/closure bindings and add recipe/surface ruling if needed |
| `catalog.yaml` | batch-11 reference entries/status coordination | new verifier role and verification-evidence reference entry |

There is no exact eval-case file collision if this mission uses new case ids, and provenance should use
a separate `provenance/adaptations.d/verification-seat.yaml` rather than batch 11's delegation
fragment. `super-scout` has no batch-11 overlap.

Order:

1. Land batch 11 bodies, `delegation`, and `structural-checks`; recalculate body baselines.
2. Rule on the AUTHORING defect below before dispatching a verifier-role writer.
3. Land schema/capability/gate changes with compatibility fixtures. The old receipt form remains valid
   for tickets that declare no surface kinds; new tickets activate the stronger predicate.
4. Add verifier role and verification-evidence reference, then amend the seven bodies/sidecars against
   batch 11's final text.
5. Add behavioral eval cases and deterministic gate tests; only the later ship runs them.

### Contract defect, in `CONTRACT-DEFECTS.md` form

**Instruction followed.** `AUTHORING.md` says: “both populations are complete (7/7 and 29/29 …) and
no batch after batch 3 adds to either” (`AUTHORING.md:12-18`).

**What following it produces.** The catalog now declares 34 roles, including later learn roles
(`catalog.yaml:543-568` and the subsequent role list), so the instruction is already stale. Applied
literally, it forbids the commissioned `verifier` role even though no existing role owns runtime
verification.

**Correct behavior appears to be.** Replace the historical closed-population claim with a rule that a
new role requires a catalog entry, provenance, the §12.2 shape, a runner seating path, and a ruling
when it changes an existing separation invariant. If the population is intentionally closed, this
mission must instead define verification as a protocol-run operation and the captain must accept that
there is no named verifier seat. This report recommends correcting the contract and adding the seat.

Per the scout constraint, this entry is reported here and `CONTRACT-DEFECTS.md` was not edited.

## 7. Workstreams

### 1. Contract and rulings

- Files: `AUTHORING.md`, `CONTRACT-DEFECTS.md` retirement commit, `policies/resolved-conflicts.yaml`,
  `catalog.yaml`, provenance/conversation map.
- Done: the verifier role is legal to author; independence/closure rulings bind it and super-verify;
  no new public entrypoint exists; validation has no open contract defect.
- Eval cases: none at prompt level. Add validator fixtures proving an undeclared role fails and a
  declared non-entrypoint verifier role passes.

### 2. Recipe and surface schemas

- Files: `schemas/project.schema.json`, `schemas/ticket.schema.json`,
  `schemas/verification.schema.json`, new `schemas/verification-recipe.schema.json` if a separate
  artifact is chosen, schema fixtures/templates.
- Done: project declares facilities; ticket selects recipe/kinds per criterion; receipt binds recipe,
  seat and kind; API response requires status/body digest; old receipts remain compatible only for
  tickets with no new requirement.
- Eval cases: deterministic fixtures for unknown evidence kind, frontend criterion with an
  undeclared facility, API response without status/body digest, and changed recipe digest.

### 3. Capability and verifier role

- Files: `roles/verifier/ROLE.md`, `adapters/claude-code/CONTRACT.md`,
  `adapters/codex/CONTRACT.md`, `adapters/runner-contract/CONTRACT.md`,
  `skills/super-verify/skill.yaml`, capability/adapter tests.
- Done: host-alone is guided; runner-attested is autonomous; excluded lineage cannot fill the seat;
  unavailable is surfaced and never backfilled.
- Eval cases: a neutral prompt with one available context that also implemented the change must end
  unavailable; a fresh host context without attestation returns an explicit gap; an attested runner
  seat returns receipts/matrix only. Prompts state the seating facts, not the expected refusal.

### 4. Evidence reference and lifecycle bodies

- Files: `references/verification-evidence/REFERENCE.md`; seven `SKILL.md` bodies and matching
  sidecars; provenance fragment.
- Done: shared detail is loaded only where needed; all bodies remain under 300 lines; no body assumes
  a browser, service, or tracing facility; scout remains read-only.
- Eval cases: frontend AC with only test output; backend AC with status/body-digested response; no
  project facility; successful first discovery that records a recipe; next run that reuses it.
  Prompts present repository state and the requested criterion, never the desired answer.

### 5. Evidence-bearing gate and true-done predicate

- Files: `src/lifecycle/gate.ts`, lifecycle tests, package-generation tests for `bin/ak-gate.mjs`,
  receipt templates.
- Done: every receipt and every declared evidence artifact is copied/rehash-checked; implementer seat
  cannot count as verifier; surface kinds cover their criteria; exact refusals are stable; manual
  evidence is labeled worker-attested and runner evidence trusted.
- Eval cases: a generic passing test with missing screenshot, same-seat implementer/verifier, missing
  trace artifact after record, and complete multi-artifact evidence. Prompts do not tell the agent
  which gate should fire.

### 6. Review and ship composition after batch 11

- Files: `skills/super-review/*`, `skills/super-ship/*`, their new eval cases, and no-mistakes payload
  mapping if the PR evidence summary needs it.
- Done: readiness names missing criterion/seat/kind; ship refuses before any local/remote publication;
  PR payload links recipe, matrix and evidence digests alongside batch 11 class/rollback fields.
- Eval cases: current receipts with one uncovered surface; host-unattested verifier in delegated ship;
  complete backend smoke/API evidence. The prompts ask to prepare the ship from supplied artifacts and
  do not state whether it should pass.

## Body line-count budget

Raw lines at the inspected revision and after applying only Appendix A (batch 11 must recalculate
before authoring):

| Body | Before | After | Net |
|---|---:|---:|---:|
| `skills/super-scout/SKILL.md` | 189 | 189 | 0 |
| `skills/super-align/SKILL.md` | 185 | 188 | +3 |
| `skills/super-bound/SKILL.md` | 187 | 193 | +6 |
| `skills/super-build/SKILL.md` | 250 | 257 | +7 |
| `skills/super-verify/SKILL.md` | 228 | 255 | +27 |
| `skills/super-review/SKILL.md` | 280 | 284 | +4 |
| `skills/super-ship/SKILL.md` | 270 | 279 | +9 |
| `roles/verifier/ROLE.md` | 0 | 96 target | new |
| `references/verification-evidence/REFERENCE.md` | 0 | 120 target | new |

The two new-file figures are authoring budgets, not measured files; the implementation writer must
report actual raw counts. All seven existing drafts remain below the 300-line hard cap, but
`super-review` and `super-ship` have little room after batch 11. Keep taxonomy and examples in the
shared reference. The target/cap rule is `AUTHORING.md:22-70`.

## Decisions for the captain

1. **May the role population reopen for `verifier`?** Recommended: yes—amend the stale closed-population
   sentence, then add the non-entrypoint role. Alternative: keep roles closed and accept a protocol
   operation with no named verifier seat.
2. **Is structural independence sufficient, with cross-family selection left to deployment config?**
   Recommended: yes. Guaranteeing a different family requires reversing the model-strip and
   structural-independence rules and makes some installations unavailable.
3. **Does “exactly like Claude” require the literal `.claude/skills/verify/SKILL.md` file?**
   Recommended: no—take behavioral parity through a central, host-neutral recipe artifact. Requiring
   the literal path needs a ruling that weakens central-KB ownership and introduces host-specific
   repository state.

## Appendix A — exact seven-body text

These are the exact body lines proposed; sidecar mirrors and renumbering are mechanical follow-up.

### `super-scout`

No lines. Its dossier may locate recipe/config files, but it does not run or judge surface evidence.

### `super-align` — append to workflow step 11

```markdown
For any success field describing a rendered interface or running service, name the observable
surface, not the tool: which user path or request proves it, and which evidence kinds the project
declares available. Do not assume a browser, trace collector or running service.
```

### `super-bound` — add to Inputs, then workflow step 4

```markdown
- The project's verification recipes and surface declarations (`schemas/project.schema.json`).
  Absent or empty: record the gap; never assume a browser, running service, trace collector or
  command the project did not declare.
```

```markdown
   For each criterion, record its surface and required evidence kinds from the project declaration.
   Load [verification evidence](../../references/verification-evidence/REFERENCE.md) for the
   vocabulary; an undeclared facility becomes a visible gap, never an invented check.
```

### `super-build` — replace workflow step 12; add Hard gate

```markdown
12. Run the ticket's named checks as implementer self-checks and record each receipt with
    `created_by.role: implementer` and the implementer seat id. They are self-check evidence and
    never satisfy the independent verify gate. Hand the claim, criteria, frozen revision, project
    recipe and permitted commands to `super-verify`; its verifier seat reruns them and produces
    gate-eligible receipts. Commit the work on the ticket's own branch, then publish the receipts and
    ticket result through the knowledgebase adapter's `publishArtifact` operation. Report every
    written ruling and out-of-scope observation.
```

```markdown
Gate: a receipt created by the implementer, change author, spec approver or oracle author is
self-check evidence only. It never fills or substitutes for the verifier seat, even when its command
and output are identical to the later independent run (ruling
`missing-supervisor-never-implementer`).
```

### `super-verify` — replace Authority and workflow steps 2–3; add the remaining hooks

```markdown
No grant covers delegation, because no phase operation exposes this skill
(`policies/invocation.yaml`). The implementer may start the skill, but may not fill its verifier seat
or author gate-eligible receipts. The runner assigns a distinct `verifier` seat, and closure depends
on that seat's receipts plus the applicable policy rule, never on the caller's confidence. A seat
that cannot be filled independently is `unavailable` and is never backfilled by the implementer,
author, spec approver or another seated role (ruling `missing-supervisor-never-implementer`).
```

```markdown
The project's content-addressed verification recipe and surface declarations. With no matching
recipe, discover a candidate from project files, but do not substitute tests for a runnable surface;
publish a recipe only after its complete build, launch, readiness, drive and cleanup path succeeds.

One runner-assigned verifier context (`independent-context`) and trusted evidence storage for the
autonomous form. A fresh host context without attestation remains valid in guided mode and records
`host-unattested`; it cannot satisfy autonomous closure.
```

```markdown
2. Resolve the matching project-declared recipe by id and content hash. If none exists, discover the
   setup, build, launch, readiness, drive and cleanup steps from project files. Record a candidate
   only after the whole path works; never write a host-specific recipe into the application tree.
   Load [verification evidence](../../references/verification-evidence/REFERENCE.md) before matching
   a surface to an evidence kind.
3. Seat `roles/verifier/ROLE.md` outside the implementer lineage. Give it the claim, criteria,
   revision, recipe, permitted commands, environment and required evidence kinds—never the
   implementer's narrative, claimed result or reviewer verdict. An unfillable seat is `unavailable`.
```

```markdown
   Where a criterion declares a runnable surface, build and launch the application, wait for the
   declared readiness signal, and drive the declared path or request. Tests, type checks and builds
   may support the receipt; none substitutes for the running-app evidence kind the criterion names.
```

```markdown
   Each receipt also records the recipe id and hash, `evidence_kind`, every evidence artifact and
   digest, and the verifier seat id plus its runner attestation or `host-unattested` state.
```

```markdown
   Return the receipts and matrix exactly as artifacts. Do not add a prose approval over them; each
   criterion's outcome is the verdict.
```

```markdown
Gate: a runnable frontend or backend criterion is never passed by tests, type checks or a build alone.
It needs the project-declared running-surface evidence kind, or an explicit non-pass outcome.

Gate: an implementer-authored or host-unattested receipt cannot satisfy autonomous closure. A missing
independent seat is `unavailable`, never self-verification with a note.
```

```markdown
Each receipt names its recipe digest, evidence kind, evidence artifacts and verifier seat. The matrix
maps every criterion to those receipts and never promotes `host-unattested` evidence into an
independent result. A successful newly discovered recipe is published as a content-addressed
verification-recipe artifact for later runs.
```

### `super-review` — append to readiness step 10

```markdown
For `readiness`, also require each criterion's current receipt to name a verifier seat distinct from
the implementer and to carry each project-declared surface evidence kind. A missing seat attestation
or kind makes the verification lane `unavailable`; name the criterion and gap rather than substituting
review judgment.
```

### `super-ship` — append to workflow step 3; add Hard gate

```markdown
For every criterion, require a current receipt whose verifier seat differs from the build gate's
implementer seat. Where the ticket marks `frontend` or `backend`, require every declared
`evidence_required` kind and re-hash its artifacts. Refuse before preflight with
`refused: criterion <id> requires <surface> evidence <kind>, but no current receipt at
<revision>/<diff-hash> carries that evidence kind`, or with the corresponding seat-attestation
refusal.
```

```markdown
Gate: no ship begins with an uncovered criterion, an implementer-authored verifier receipt, an
unattested verifier in autonomous mode, or a missing project-declared surface evidence kind. The run
stops with `needs-input` naming the criterion, seat or kind before any remote effect.
```
