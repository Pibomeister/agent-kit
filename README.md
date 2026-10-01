# agent-kit

One engineering lifecycle, amalgamated from eight donors (seven MIT-licensed, one Apache-2.0) into a single installable
catalog — rather than four plugins competing over activation descriptions.

**33 public skills · 8 domain packs · 7 protocols · 29 role prompts · 5 reference packs · 27 schemas**,
with a validator (`ak`) that makes the catalog self-checking and a packager that emits per-host
bundles.

> Status: pre-release. See `catalog.yaml` for per-entry `status` (`contract` → `authored`).

## Install

```bash
claude plugin marketplace add ~/Documents/agent-kit
claude plugin install ak@agent-kit     # restart required
```

Skills then appear under `/ak:`. `profiles/core.yaml` is the recommended install — the full catalog is
real startup cost even with progressive disclosure.

## The spine: seven super skills

The lifecycle is seven skills, not twenty. Each has one job, one required output, and one boundary.

| Skill | Job | Boundary |
|---|---|---|
| `super-align` | Grill the request, establish shared vocabulary, get design approval | Hard gate: no implementation files before a human approves |
| `super-bound` | Requirements, plan, dependency DAG, ownership, acceptance criteria | Decision tickets are not implementation tickets |
| `super-scout` | Bounded read-only exploration into a revision-bound evidence dossier | Reports coverage limits and unknowns — **never an architectural verdict** |
| `super-build` | Execute an approved ticket under TDD in an owned worktree | No self-approval, no silent scope expansion |
| `super-verify` | Acceptance-to-evidence matrix with command, exit status, revision | An agent's description of green tests is not a receipt |
| `super-review` | Specialist panel (full) or two-axis delta on a fix | Reviewers cannot edit |
| `super-ship` | Release checks and PR preparation | Merge and deploy are separate capabilities |

Plus `autopilot`: a human-started supervisor pair exercising explicitly delegated checkpoint authority
over those same skills. It implements nothing itself.

## Two ways to run

**Standalone is the default.** You open one or more sessions yourself, each in its own worktree, and run
the lifecycle in each. Every phase leaves a gate record (`bin/ak-gate.mjs record`, or
`ak lifecycle record` in this checkout), and `super-ship` runs `ak-gate.mjs check` before it ships: a
session that skipped `super-build`, or whose review went stale after an edit, is refused with
`refused: gate <g> has no current evidence`. No supervisor is needed for that.

**Firstmate is optional**, for people who want one supervisor running several agents at once.
`ak firstmate bind` hands a Firstmate worker the same lifecycle, and `ak firstmate status complete`
runs the same core check before it reports `done` (`adapters/firstmate/CONTRACT.md`). Nothing in core,
its tests or CI needs Firstmate installed.

## Catalog

Every entry is declared in `catalog.yaml`. The validator fails on an entry with no directory and on a
directory with no entry.

### Skills (33)

| Group | Members |
|---|---|
| **Lifecycle** (7) | `super-align` U · `super-bound` U · `super-scout` M · `super-build` M · `super-verify` M · `super-review` U/M · `super-ship` U |
| **Supervisor** (1) | `autopilot` U |
| **Standalone** (19) | `compound` U · `compound-refresh` U · `ideate` U · `pov` U · `bakeoff` U · `doc-review` M · `receiving-review` U · `diagnose` M · `improve-architecture` U · `doubt-driven` U · `simplify` M · `research` M · `source-driven` M · `deprecate` U · `explain` U · `triage` U · `strategy` U · `product-pulse` U · `writing-skills` U |
| **Primitives** (4) | `prototype` M · `handoff` M · `wait-what` M · `wayfind` U |
| **Operational** (2) | `babysit-pr` U · `ultraqa` U |

**U** = user-invoked; only a human starts it. **M** = model-invoked. See the invocation law in
`AGENTS.md`.

### Packs (8)

Attached by **artifact and semantics, not file extension alone**, with the selection rationale
recorded. They add constraints and review lenses; they never start a lifecycle phase.

`pack-api` · `pack-delete` · `pack-test` · `pack-secure` · `pack-frontend` · `pack-data` ·
`pack-perf` · `pack-deps`

### Protocols (7)

Shared phase logic, invoked by skills rather than by humans:

`phase-operations` · `consensus-plan-gate` · `tdd` · `apply-findings` · `review-delta` ·
`worktree-ownership` · `attach-pack`

### Roles (34)

4 core (`supervisor`, `implementer`, `reviewer-spec`, `reviewer-standards`) · 15 code-review ·
7 doc-review · 3 plan-review (`planner`, `architect`, `critic`) · 5 learn (`learn/pattern-maintainer`,
`learn/reflector`, `learn/consolidator`, `learn/lesson-merger`, `learn/skill-scout`).

### References (5)

`codebase-design` · `domain-modeling` · `engineering-principles` · `prose-quality` ·
`tracker-of-record`. Loaded on demand, never exposed as slash commands.

## What makes it self-checking

```bash
bun test                  # tests/ only: units + invalid-case fixtures; eval scaffolds and dist/ excluded
bun run ak validate       # the gate every batch passes
bun run ak build          # validates, then writes dist/ for every host
bun run ak attach <path>  # show which packs attach, and why
bun run ak tracker check <project-dir>  # a project's tracker binding, and that its secret stays out of git
```

`ak validate` enforces catalog completeness, JSON Schema conformance, frontmatter rules, the
invocation graph, link closure in both source and bundle, provenance for every adapted file, and a
content denylist (model names, pricing, effort ladders, placeholders). The trees it exempts are
`DENYLIST_EXEMPT_PREFIXES` (`src/validation/content.ts`), and the invariant that decides that list
is that nothing packaged into `dist/` is ever exempt.

## Contracts worth knowing before you read a skill

Each of these is a resolved conflict, not a house style. The authoritative text of every one is in
`policies/resolved-conflicts.yaml`, which also records the tension it settles, the entries it binds
and the release scenario that tests it; the ids below are the lookup keys.

- **Artifacts are revision-bound.** Approvals bind to a content hash, never a filename. A changed plan
  does not inherit the old plan's approval; a changed patch does not inherit stale receipts.
- **Findings are P0–P3.** Critical/Important/Nit/FYI are presentation labels, not a replacement.
  Synthesis may only *worsen* a grade. Low-confidence security findings are adjudicated, never
  silently filtered (ruling `low-confidence-security-adjudicated`).
- **Only independent verification closes a finding.** Reviewer or classifier confidence is advisory
  (ruling `closure-requires-independent-verification`).
- **Delta review is bounded by affected behavior, not changed lines.** A new finding needs novelty
  evidence — what changed or regressed that makes it new — and unrelated low-priority discovery does
  not restart the loop. Within that bound, a serious newly discovered issue in an untouched affected
  caller stays reportable (ruling `delta-scope-affected-behavior`).
- **"Fresh reviewer" means independent of the author**, not amnesiac between cycles (ruling
  `reviewer-continuity-not-amnesia`).
- **Two fix cycles, then stop.** Anything still open is reported, not looped (ruling
  `two-fix-cycles-then-stop`).
- **Numeric heuristics are guidance.** The ~100-line PR target and 80/15/5 pyramid are configurable
  starting points, not gates, and neither is grounds for a finding on its own (ruling
  `numeric-heuristics-are-guidance`).

## Provenance

Eight donors, pinned to exact commits in `provenance/upstream.lock.yaml`. Six MIT donors make up the
engineering lifecycle (pinned 2026-09-18): `EveryInc/compound-engineering-plugin`, `obra/superpowers`,
`mattpocock/skills`, `addyosmani/agent-skills`, `Yeachan-Heo/oh-my-claudecode`,
`Yeachan-Heo/oh-my-codex`. Two more feed the opt-in learning runtime: `BayramAnnakov/claude-reflect`
(MIT) and `thedotmack/claude-mem`, which is **Apache-2.0**, not MIT. Its licence text and NOTICE are in
`provenance/licenses/`, the root `NOTICE` carries its NOTICE, and each file adapted from it records
what was changed.

Every adapted file records its `donor@commit:path` in `provenance/adaptations.yaml`, and that path is
verified to exist at the pin. Material adapted from a research report checked in under
`research/sources/` records a digest-anchored `local:` source instead (`AUTHORING.md` §5).
Capabilities that came from the design conversation rather than a donor
are marked `origin: conversation` with a line locator — never a fabricated source path. Upstream drift
becomes a reviewable proposal, never an automatic re-sync.

Attribution: `NOTICE`. Full license texts: `provenance/licenses/`.

## Repository documents

| File | Role |
|---|---|
| `AGENTS.md` | Maintainer guide and the invocation law |
| `AUTHORING.md` | The contract every skill body obeys |
| `catalog.yaml` | Single source of truth; drives validation and packaging |
| `policies/resolved-conflicts.yaml` | Where the sources disagreed, and how it was settled |
| `docs/decisions/` | ADRs |
| `research/` | Design sources and ~7,000 lines of citation-verified donor dossiers |

## License

MIT — see `LICENSE`. Adapted material remains under its donors' MIT terms; see `NOTICE`.
