# ADR-0001 — Knowledgebase document vocabulary

**Status:** Accepted.
**Date:** 2026-09-19.
**Authority:** `research/sources/engineering-skills-repo-plan.md` §1.2, §8; release scenarios 21, 22, 24.
**Prior art read:** `Casco-worktrees/knowledge-base/packages/knowledge-base` (`kb.config.yaml`,
`templates/`, `schemas/index.schema.json`, `src/commands/`, `AGENTS.md`);
`software-factory/docs/decisions/ADR-018` and `ADR-021`.

## Context

Three sources describe where durable project knowledge lives, and they do not agree.

1. **The design brief** specifies application-local paths: `CONTEXT.md`, `docs/solutions/` and
   app-local ADRs appear in `super-align`'s hard gate, in `ship`→`compound`, in `wait-what`, and in
   the lesson-capture spawn condition. It contains **no** mention of a central knowledgebase and no
   rejection of app-local paths.
2. **The architecture doc** (§1.2, §8) requires the opposite: project-derived artifacts are owned by
   a central KB, and "project documentation does not live in application repositories." Its directory
   sketch names `decisions, requirements, plans, tickets, reviews, solutions, runs` plus `CONTEXT.md`
   and `standards/`, and states that "the exact directory names are configurable; the central
   ownership is not."
3. **A real, tested `kb` CLI** exists at
   `Casco-worktrees/knowledge-base/packages/knowledge-base` and **postdates both documents**. It has
   nine document kinds — `adr`, `concept`, `foundation`, `gotcha`, `pattern`, `prd`, `process`,
   `sop`, `system` — a scope/component model resolved most-specific-match-first, multi-repo
   enrollment already anticipated (`repos: { host: true }` plus `kb.config.local.yaml`), an
   approvers list, and the rule that an ADR is created `proposed` and is **"accepted in review, never
   by its author."**

Precedence is arch doc over design brief. The `kb` CLI is not a fourth opinion: it is a working
implementation of the arch doc's central-ownership requirement, and it is the thing an adapter would
actually talk to.

The apparent conflict between vocabulary (2) and (3) dissolves on inspection. They are **different
axes**, not competing lists:

- The KB's nine kinds classify **what a curated page is** — a decision, a footgun, a convention.
- The arch doc's seven names classify **what a record is for in a run** — the plan, the tickets, the
  review ledger, the receipts.

A review ledger is not a kind of page. A gotcha is not a phase of work. Forcing either vocabulary to
cover the other is what makes them look incompatible.

## Decision

### 1. Central ownership. The application-local paths do not survive.

`CONTEXT.md`, `docs/solutions/` and app-local ADRs from the design brief are **replaced** by central
KB equivalents. No agent-kit skill creates a documentation tree inside an application repository.
This is release scenario 21, and `ak validate` plus the eval suite enforce it.

The central equivalents already exist in the `kb` CLI and are not reinvented here:

| Design-brief path | Central equivalent |
|---|---|
| `CONTEXT.md` glossary | the KB glossary (`kb glossary`) |
| `CONTEXT.md` project orientation | `concept` and `system` pages, resolved by scope |
| `docs/solutions/` | `gotcha` (a rule with a proof) and `pattern` (a convention) |
| app-local `docs/adr/NNNN-*.md` | `adr`, created `proposed` |

### 2. Two artifact classes, one adapter.

**KB documents** are curated, human-readable, long-lived pages. They use the CLI's existing nine
kinds. agent-kit **adds no new kinds** — a tenth kind would fork a working tool's vocabulary for no
behavioral gain.

**Run artifacts** are revision-bound, schema-validated operational records: tickets, dossiers,
findings, reviews, verification receipts, charters, decision cards, events. They conform to
`schemas/*.schema.json`, they carry the §5.2 envelope, and they are **not** KB pages. They are
published to the KB's run-scoped storage and **linked from** KB pages, never rendered as curated
prose. The arch doc's `requirements/ plans/ tickets/ reviews/ runs/` directories are where these
land; `decisions/` and `solutions/` are where class-one pages land.

The distinction is load-bearing: a `gotcha` says *why* something is true and is reviewed by a human;
a verification receipt says *what happened at a revision* and is proof, not prose. ADR-021's
separation of an agent's outcome claim from an independent verification result is the same boundary,
and this repo adopts its conclusion: **caller-provided pass flags are not proof by themselves.**

### 3. Per-skill emission table.

Every skill that writes something durable declares its target here. A skill not listed writes no
durable artifact.

| Skill | KB document | Run artifact |
|---|---|---|
| `super-align` | `adr` (proposed); `concept` for settled vocabulary | — |
| `super-bound` | `prd` when requirements are newly stated | `ticket` (implementation), plan record |
| `super-scout` | — | `dossier` |
| `super-build` | — | verification receipts, patch/commit link |
| `super-verify` | — | `verification` |
| `super-review` | `gotcha` only when a finding teaches a durable rule | `review`, `finding` |
| `super-ship` | — | ship evidence, paired-PR link |
| `verify` | `sop` (the recipe that worked, where the host provides `kb-write`) | `verification`, acceptance-to-evidence matrix |
| `wayfind` | — | `map`, `ticket` (decision) |
| `diagnose` | `gotcha` (root cause with its proof) | diagnostic packet or bounded patch, never both |
| `compound` | `gotcha` or `pattern` | `lesson` |
| `compound-refresh` | amends any kind, with supersession | `lesson` |
| `doc-review` | — | `review` |
| `receiving-review` | — | `finding`, `review` |
| `improve-architecture` | `adr` (proposed) | — |
| `deprecate` | `adr` (proposed); `process` for the migration | `ticket` |
| `bakeoff` | `adr` (proposed) when a direction is chosen | `evaluation` |
| `prototype` | — | `evaluation` |
| `strategy`, `product-pulse` | `prd`, `concept` | — |
| `writing-skills` | `process` or `sop` for this catalog | — |
| `autopilot` | — | `charter`, `decision`, run ledger |
| `handoff` | — | `handoff-record` |
| `triage` | — | tracker write; the tracker stays the system of record |
| `explain`, `wait-what`, `pov`, `ideate`, `doubt-driven`, `simplify`, `research`, `source-driven` | — | — |

### 4. Authorship separation carries into the KB.

The CLI's rule — an ADR is created `proposed` and **accepted in review, never by its author** — is
adopted unchanged and is the same principle as this repo's review independence and its "an author
may never close their own finding" rule. An agent-kit skill may **create** a `proposed` ADR. No
agent-kit skill may accept one. `policies/authority-defaults.yaml` treats KB acceptance as an
authority a skill does not hold.

### 5. No fresh ADR for a mechanical fix.

Per arch §8: record the applicable existing decision, or an explicit no-new-decision result. A
successful routine run does not invent a lesson (release scenario 23). The same discipline applies to
ADRs: absence of a decision is a recordable outcome, not a gap to fill with prose.

### 6. The paired-PR requirement is preserved and is not an atomic merge.

Source PRs link to their KB PRs. A source merge **activates** the existing KB merge coordinator,
which still honors checks, protection rules, source dependencies and retry/idempotency rules. **A
blocked KB merge stays visible and retryable and is never reported as complete** (release scenario
22). ADR-018's authority table is the model: the KB owns git-backed decisions and reviewed history;
the runner owns command authorization and receipts; neither claims the other's surface.

### 7. Scope, not path, is how a document is placed.

The CLI resolves a document's scope against a component model, most specific match first. agent-kit
passes a scope through the adapter and does not compute KB paths itself. Directory names stay
configurable, per arch §8; central ownership does not.

## Consequences

- `adapters/knowledgebase/CONTRACT.md` is written against the nine kinds above plus the run-artifact
  classes, and it may now stop deferring its type list to this ADR.
- No skill body may reference `CONTEXT.md` or `docs/solutions/` as a write target. The nine existing
  dossiers instruct writers to convert every donor "write a file in the repo" instruction into a KB
  adapter call (see `research/dossiers/define.md` §0.1); this ADR is the authority that instruction
  was waiting on.
- `ak validate` gains a check for application-local documentation write targets in skill bodies.
- Rolling back a skill revision leaves the underlying lesson and evidence history intact (release
  scenario 24), because lessons are KB pages with supersession and skills are package files.
- agent-kit does not depend on this particular `kb` implementation. The adapter is the boundary; a
  different KB satisfying the same seven operations and supporting the nine kinds is substitutable.
