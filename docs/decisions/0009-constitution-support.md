# ADR-0009 — Constitution support: boundaries hold, a registry keeps the source, delivery is measured

**Status:** Accepted.
**Date:** 2026-10-03.
**Authority:** the captain's decision of 2026-10-03, relayed by Firstmate: "let's go with your
recommendations". It accepts the design under "Decision", the redacted brief and its registration,
the `C:L` locator route under "Provenance", all eight open decisions as recommended under "Decisions
on the open questions", and the Codex host facts on the strength of source and documentation. The
mission brief had approved the direction and not the design (`C:L3`), and asked for this record as the
first milestone's proposal (`C:L41-46`). `C:L<n>` cites lines of
`research/sources/mission-brief-constitution-support.md`, the redacted copy of that brief registered in
`provenance/upstream.lock.yaml`. The brief names this record 0007 (`C:L43`); 0007 and 0008 are taken,
so it is 0009. Accepting the design does not carry the diffs of later tickets: a ticket that changes an
existing ruling, contract or accepted ADR still stops for approval when it starts (`C:L25`).
**Evidence:** the fifteen host-fact receipts under `research/host-facts/2026-10-03/`, and the ticket
plan in `research/briefs/constitution-support-plan.md`. The files read are listed at the end.

## Context

The brief asks that every change produced through agent-kit follow an adopting organization's
engineering constitution, without loading the whole text into the agent and without trusting the
agent's own report that it complied (`C:L7`). It fixes three parts: boundaries hold the hard
constraints, a registry keeps the constitution as the source and compiles only selected obligations,
and how the judgment articles reach the agent is decided by experiment (`C:L9-13`). The constitution
text and the organization's packs never enter this repository (`C:L15`).

**What already exists, measured at `7c1c530` and rechecked at `6c6d2ab`.** The seams the brief lists
(`C:L28-38`) are real, with these corrections:

| Piece | Where | What the brief's table needs adding |
|---|---|---|
| Trusted evidence | capability `trusted-evidence` (`schemas/common.schema.json`); refused fail-closed by `adapters/runner-contract/CONTRACT.md` and by `src/runner/core.ts`; receipts re-hashed by `evaluateEvidence` in `src/lifecycle/gate.ts` | Only the runner supplies it, by writing into a store the worker cannot write. The re-hash runs on the opt-in path; a run without opened evidence passes on markers `skills/super-ship/SKILL.md` calls history, not proof |
| Project rules | `roles/code-review/project-standards/ROLE.md`; `standards`, `mandatory_constraints` and `guidance` in `schemas/project.schema.json` | `guidance.pr_size.target_changed_lines` defaults to 100, and every guidance block is pinned advisory |
| Settled tensions | `policies/resolved-conflicts.yaml` | 32 rows, not 27 (`grep -c '^  - id:'`). A row requires `scenario`, `coverage`, `source.plan` and `discharged_in`; `rulings.uncited-restatement` is a warning, never a gate |
| A blocking hook | `adapters/firstmate/hooks/child-guard.sh` | Claude Code only, subagent calls only; the main thread is never judged, so a broken guard cannot stop the worker |
| Hook wiring | `src/learn/setup/wire.ts`, `uninstall.ts` | Learning hooks always exit 0 (`src/learn/hooks.ts`). On Codex they are non-managed, so headless runs skip them until trusted, which `adapters/codex/CONTRACT.md` §6 does not say |
| Promotion | `src/learn/review/patterns.ts`, `propose.ts`; `protocols/evidence-gate/PROTOCOL.md` | Active at two events from two PRs **or two source families**; promoted at three; both configurable |
| Evals | `scripts/eval-local.sh` over `claude plugin eval`; `tests/learn/evals/trigger-eval.ts`; `tests/learn/evals/case-runner.ts` | The trigger harness runs Codex subjects, and since `1fe16d1` the case runner runs a named `case.yaml` on Codex and Grok subjects behind a dry run and an explicit execute gate. No live Codex case run is recorded, so `adapters/codex/CONTRACT.md` §5 still reads `not-run` |

**What the hosts do.** Every fact the brief lists held on `claude 2.1.288` and `codex-cli 0.153.4`;
the receipts give the evidence and the nuances. Six of them shape this design:

1. On both hosts a hook that times out, crashes, cannot be found or prints garbage lets the call
   through (`claude-code-1`, `codex-4`). On Claude Code that includes exit 127 for a missing script.
2. Codex has no ask: a PreToolUse `ask`, and an `allow` without `updatedInput`, mark the hook failed
   and run the call (`codex-1`).
3. Codex skips a non-managed hook until it is trusted, `codex exec` has no review step, and trust
   covers the hook definition, not the script it runs (`codex-2`).
4. Context a PreToolUse hook adds on Claude Code reaches the model with the tool result, after the
   call (`claude-code-2`); path rules load after the first Read, Write or Edit in scope, never for a
   shell command (`claude-code-3`).
5. Claude Code permission rules match command text: `Bash(git push *)` does not stop
   `git -C . push`, and a Read deny does not stop an interpreter opening the file (`claude-code-5`). A
   hook can tighten a deny or ask rule and never loosen one (`claude-code-6`).
6. Codex does have a manual-only key: `agents/openai.yaml` `policy.allow_implicit_invocation: false`
   hides the skill from the model while `$skill` still works (`codex-7`).
   `adapters/codex/CONTRACT.md` says no such key was verified.

**Two figures behind the brief have moved.** The Codex prose-start figure behind open decision 7,
42 to 46 of 60 sessions (`C:L113`), is the 2026-09-28 measurement and counts loads, not starts. The
repository's own rerun after the wording fix (`research/evals/2026-09-30-a3-cross-model-after-fix.md`)
measured 16 and 21 of 60, with no valid session making a side-effect call. And the design document
this brief came from counted 27 rulings at an earlier revision; there are 32.

## Options

**For the whole.**

- **Load the full constitution** in AGENTS.md or CLAUDE.md. Rejected: Codex stops adding project
  docs at a combined 32 KiB along the chain (`codex-6`), every session pays for the text, and loading
  enforces nothing.
- **Ship it as one skill.** Rejected: whether it loads is the model's choice, and the brief's own
  evidence has a skill never invoked in 56% of cases (`C:L128`).
- **Compile everything** into checks and prompts. Rejected after the outside review the brief folds
  in (`C:L153`): a fallible translation replaces a fallible reader, and passing checks are then read
  as compliance.
- **Boundaries, a source-preserving registry, and measured delivery.** Chosen. It is the brief's
  design (`C:L9-13`), and the host facts above support each part of it.

**For where the in-loop feedback lives.**

- **Hooks in the core bundle.** Rejected: the bundle ships no hooks, every skill behaves the same
  with hooks absent, and long-running host behavior belongs in an opt-in runtime (ruling
  `full-catalog-opt-in-profiles`; ruling `learning-runtime-is-host-adapter` is the precedent).
- **Extend `child-guard.sh` to the main thread.** Rejected: it is a Claude-only shell script scoped
  to a Firstmate child envelope. Its decoder discipline is kept: one parse, deny on unparseable input,
  git global options skipped before the subcommand.
- **An opt-in `guard` profile with an `ak guard` runtime** modelled on `ak learn`. Chosen.

## Decision

1. **Boundaries hold the hard constraints.** A hard-constraint article holds only through a
   mechanism that does not depend on the agent or on any hook running: the sandbox, scoped
   credentials, a required CI check, branch protection or file permissions. agent-kit does not
   provide those mechanisms. It records which one each article maps to, and the coverage report fails
   when a hard-constraint article maps to none.
2. **The guard is feedback in front of them.** `ak guard hook <event>` runs one policy evaluator
   behind a decoder and an encoder per host, from a pinned install outside the workspace, under the
   opt-in `guard` profile. It emits deny only, on both hosts, as JSON with exit 0, and denies input it
   cannot judge. Its contracts state that a missing, slow or crashing guard allows the call. An
   "ask first" action is denied with a pointer to a scoped, expiring grant in the charter shape that
   ruling `sensitive-actions-need-approved-charter-entry` already defines, never a second approval
   system. The first write to a governed path is denied once with the applicable article ids as the
   reason, because context added on an allow arrives a call late. Every deny and lint hit is logged
   with its rule or article id under the host's configuration directory, never in a project
   repository.
3. **A done gate and a lint loop, as feedback.** The Stop hook ends a run verified or blocked, and a
   verified run is not thereby shippable: it carries receipts for the current head, and any new
   suppression, unfinished-marker token or test removal carries a justification. After two cycles it
   ends blocked (ruling `two-fix-cycles-then-stop`). The PostToolUse loop returns at most 20 lines of
   `path:line RULE-ID message + fix`.
4. **A registry keeps the source.** agent-kit owns the article schema, the validator checks that run
   when a project record points at a registry, and the coverage report. The articles live in an
   overlay. An `enforced_by` entry names its mechanism and the exact predicate it covers, and no
   article is reported covered because one of its predicates is.
5. **A compiler emits only what a host loads well.** A core of about 100 lines and under 32 KiB, a
   CLAUDE.md that imports it, path rules, `## Code Review Rules` sections, standards files, pack
   constraint stubs and the guard policy file. Each emitted rule carries its article id and version,
   and `--check` fails on drift.
6. **A constitution review seat, advisory.** It activates only when a registry is configured, is not
   required, and judges triggered and cross-cutting articles while leaving alone only the predicates a
   check already verified. Insufficient evidence never counts as a pass.
7. **Promotion ends in checks.** A promoted pattern carries an article id, a proposed deterministic
   check, the bad diff and the fix as fixtures, and a repository-wide dry-run count; it must pass a
   holdout the learner cannot read and a claim-to-source check that closes the ceiling
   `protocols/evidence-gate/PROTOCOL.md` states for itself.
8. **Delivery of judgment articles is measured, not chosen.** Four arms (full text, compiled, core
   only, length-matched placebo) under identical controls, on both hosts, with deterministic replay
   tests carrying the assurance for the controls. No paid run without the maintainer's approval;
   ADR-0006 authorizes none.

## agent-kit and the overlay

| agent-kit (public, generic) | Overlay (the organization's, depends on a pinned agent-kit) |
|---|---|
| `schemas/constitution-article.schema.json`, `schemas/guard-policy.schema.json` | The constitution text and every registered article |
| Registry checks in `ak validate`; `ak constitution coverage`, `ak constitution build` | The compiled outputs, committed in the organization's repositories |
| The `ak guard` runtime, its host decoders and encoders, `ak guard setup` | The guard policy values, generated from the registry; the path-to-tier map |
| `roles/code-review/constitution/ROLE.md` and its seat | The articles the seat is handed |
| Promotion machinery; the holdout and claim-to-source checks | The holdout corpus; promoted checks for the organization's code |
| The host-neutral eval runner and the four-arm harness | Honeypot tasks built from the organization's own work |
| Invented fixture registries and fixtures, nothing else | Domain packs (money, ledger, config), CODEOWNERS, CI workflows, managed settings, charters and grants |

agent-kit never reads overlay content except through the path or package a project record names. A
registry configured nowhere changes nothing: no check runs, no seat activates and the core bundle is
the same bundle.

## Proposed rulings

These are accepted in substance. Each row lands in `policies/resolved-conflicts.yaml` in the ticket
that creates the entries it binds,
because `ak validate` refuses a `binds` id with no catalog entry. Each takes `source.plan` from the
nearest plan section and `source.adr` naming this record, as the row for ADR-0001 does, and reuses an
existing release scenario.

| Proposed id | Tension | Ruling text (draft) | Binds | Scenario |
|---|---|---|---|---|
| `guard-is-feedback-not-boundary` | A hook that denies looks like enforcement, while both hosts let a hook that times out, crashes or is untrusted pass the call | The guard gives early feedback in front of the boundaries and is never one. A hard constraint holds only through a mechanism that does not depend on the agent or a hook running. The guard denies what it judges a violation and what it cannot judge; an absent, slow or crashing guard allows the call, and its contracts say so. No skill depends on the guard having run, and nothing the guard writes is evidence for a gate | profiles `guard`; adapters `claude-code`, `codex`; schemas `guard-policy` | 19, indirect |
| `coverage-names-the-predicate` | A check that verifies part of an article reads as verifying the article | Every `enforced_by` entry names its mechanism and the exact predicate it verifies. Coverage is reported per predicate: an article is covered only when each obligation it states has an entry, and an obligation with none is listed uncovered. A hard-constraint article with no boundary mapping fails the report. A passing check is evidence for its predicate alone | schemas `constitution-article`, `project` | 14, indirect |
| `constitution-reviewer-advisory-until-ruled` | A seat that cites an article and a `file:line` reads as authoritative, while reviewers flag conforming code at high rates | The constitution seat is advisory: not required, active only when a registry is configured, and its findings never block build, review or ship. Insufficient evidence is never a pass. Making an article's findings blocking is a later ruling taken per article, on the measured false-block rate on conforming changes and recall on planted violations, and never during a pilot | roles `code-review/constitution`; policies `review` | 4, indirect |

Scenario 19 is a passing check reached by deleting an assertion, which the guard denies early and CI
holds. Scenario 14 is a coverage limitation stated rather than hidden. Scenario 4 is a reviewer
failure that cannot become approval.

## Provenance

The capabilities this design adds come from the brief, not from a donor and not from the design
transcript, so `G:L` cannot locate them and no donor path may be invented for them. The brief is the
document to anchor.

1. **A redacted copy is registered as a local source.** `research/sources/mission-brief-constitution-support.md`
   keeps the original's 153 lines and line breaks, so a locator means the same line in both, and
   removes the organization's name, the requester's name and the private document titles (nine
   lines, listed in the plan). It is registered in `provenance/upstream.lock.yaml` `local_sources:`
   with its sha256 and line count, and its licence and copyright follow the 2026-09-30 mission brief's
   entry; `provenance.local-source-modified` fails on any edit. The design document it came from names
   people and the organization, and is never committed.
2. **Attribute adapted files through the anchored-local route.** A file that adapts a passage carries
   an adaptations row `local:mission-brief-constitution-support@sha256:<digest>#L<start>-<end>`,
   which `ak validate` checks without a donor clone. Prose cites it as `C:L<start>-<end>`, as the
   delegation dossier cites its sources as `B:L`, `D:L` and `S:L`.
3. **Locate capabilities in the conversation map through a lock-backed alias.** The map's grammar
   admits `G:L`, `plan §`, `arch §` and `amalgam` and nothing else, and the new role must carry a
   locator. The grammar is widened to admit `C:L<start>-<end>`, resolved through a `locator_alias`
   field on the local source and range-checked against its registered line count. It is the brief's
   own suggestion (`C:L43`), it is as strong as `G:L` (both are line ranges into digest-anchored
   copies), it would let the existing prose aliases be checked, and it leaves the governing design
   document untouched. It changes `src/validation/provenance.ts`, `schemas/common.schema.json` and
   `AUTHORING.md` §5, in the plan's first ticket. The alternative, amending the plan with a short
   constitution-support section as `5be121e` did for delegation, was not taken.
4. **Ruling rows** cite `source.adr: docs/decisions/0009-constitution-support.md`; `source.plan` stays
   required.

## Trusted evidence (design sketch; built after open decision 5)

The brief puts this in the first milestone as design only (`C:L64`). The sketch: a CI job on the
protected default branch runs the named checks on the exact head and publishes a signed statement
binding the head commit, tree, check set, results, configuration digest and policy version, in a store
the worker cannot write. A new adapter supplies `trusted-evidence` from that store and fails closed
when it is unconfigured or the signature does not verify, which is the route ruling
`fail-closed-adapter-lifts-ceiling` already provides for a capability the hosts withhold. The ship
gate then reads that adapter instead of worker-written records. The supplier is decision 5 below.

## Consequences

- The core bundle does not change, and every skill behaves the same with the guard absent.
- Two hosts, one evaluator. The replay suite pins the host versions the decoders were written
  against; a host upgrade that changes a payload fails a fixture rather than the guard going quiet.
- `adapters/codex/CONTRACT.md` is wrong on 0.153.4 about the manual-only key, and silent about hook
  trust, failure and spill. Its correction is the plan's second ticket, separate from this record.
- The Codex facts that only a live session could show stand on source and documentation: no Codex
  login existed to copy, and the captain accepted those verdicts. A later live run that contradicts
  one reopens the receipt, not this record.
- Later tickets touch contracts this record does not change: `AUTHORING.md` §12.2, which calls the
  role population complete; §5, if the locator alias is accepted; `schemas/project.schema.json` for
  the registry field; and `protocols/evidence-gate/PROTOCOL.md` for claim-to-source verification.
  Each stops for approval.
- A grant issued on the same OS account as the agent guards against accidents and shortcuts, not a
  determined agent; ADR-0008 accepted the same limit for bypass grants. The guard inherits it until
  an issuer outside the worker's account exists.
- **Reverting** is removing the `guard` profile and `ak guard uninstall`, deleting the registry
  checks (inert without a configured registry), removing the seat, and superseding this record.

## Decisions on the open questions

The brief asked for a recommendation on each (`C:L105-114`); the captain took every recommendation as
written. The reasoning is in the plan.

| # | Question | Decision |
|---|---|---|
| 1 | Where the registry lives | An overlay repository that depends on a pinned agent-kit |
| 2 | Article ids | A themed prefix and a number, immutable once assigned and never reused; the theme recorded separately |
| 3 | PR size for the organization's projects | 400 changed lines in the overlay's project records, as guidance that is never validated, never enforced and never a finding on its own (ruling `numeric-heuristics-are-guidance`); agent-kit's default stays 100 |
| 4 | Which tiers stop the run when a guard cannot run | Hard-constraint articles and the two most restrictive path tiers end the run blocked at the done gate; everything else continues with a logged warning |
| 5 | Who supplies trusted evidence | The overlay's CI on the protected default branch, signing with its workload identity, read through a fail-closed adapter |
| 6 | How a person grants an "ask first" approval | A charter-shaped grant the human issues outside the agent's session, single-use by default, expiring within hours, registered by hash |
| 7 | Codex `allow_implicit_invocation: false` for U skills | Adopt it for Codex, measured on the A3 Codex subset before and after; the ticket that emits it amends ADR-0003 |
| 8 | Eval budget per release | Deterministic replay on every commit; agent runs only for changed cases, three replicates on two hosts, under a per-release cap the maintainer sets; the four-arm experiment approved separately |

## Files read

Repository, at `7c1c530` unless noted. In full: `AGENTS.md`, `CLAUDE.md`, `adapters/firstmate/hooks/child-guard.sh`,
`profiles/learning.yaml`, `roles/code-review/project-standards/ROLE.md`, `src/learn/setup/wire.ts`,
`src/learn/setup/uninstall.ts`, `src/learn/setup/cli.ts`, `src/learn/hooks.ts`,
`src/learn/review/guardrails.ts`, `research/probes/validate-figure.sh`, `docs/decisions/0003-model-invocation.md`,
`docs/decisions/0006-eval-follow-up-rulings.md`, `docs/decisions/0007-firstmate-standing-autopilot.md`,
`docs/decisions/0008-bypass-start-grant.md`, `research/probes/stock-firstmate-live-smoke.md`.
In part: `src/denylist.ts`, `AUTHORING.md` (§1, §5, §6, §7, §8, the opening of §9 and §12.2), `catalog.yaml`, `README.md`,
`LICENSE`, `CONTRACT-DEFECTS.md`, `package.json`, `.no-mistakes.yaml`, `adapters/claude-code/CONTRACT.md`,
`adapters/codex/CONTRACT.md`, `adapters/runner-contract/CONTRACT.md`, `adapters/firstmate/CONTRACT.md`,
`policies/resolved-conflicts.yaml`, `policies/review.yaml`, `policies/authority-defaults.yaml`,
`policies/invocation.yaml`, `profiles/*.yaml`, `protocols/evidence-gate/PROTOCOL.md`,
`skills/super-ship/SKILL.md`, `skills/super-ship/skill.yaml`, `packs/pack-deps/pack.yaml`,
`packs/pack-deps/tests/major-bump/expected.yaml`, `evals/autopilot/third-fix-cycle-stops/case.yaml`,
`schemas/{project,pack,rulings,catalog,charter,common,install,case}.schema.json`,
`src/validation/{content,provenance,rulings,bodies,run,types,restatement,configrules}.ts`,
`src/packaging/{hosts,capability-table,profiles,install,plan,build}.ts`, `src/lifecycle/gate.ts`,
`src/runner/core.ts`, `src/firstmate/{install,constants}.ts`, `src/learn/core/config.ts`,
`src/learn/review/{patterns,propose}.ts`, `src/learn/memory/session-context.ts`, `src/cli.ts`,
`provenance/upstream.lock.yaml`, `provenance/conversation-map.yaml`, `provenance/adaptations.yaml`,
`provenance/adaptations.d/{delegation,verify}.yaml`, `research/sources/engineering-skills-repo-plan.md`
(the header, §1.5, §10, §11), `research/briefs/batch-11-delegation.md`, `research/dossiers/delegation.md`,
`research/evals/{2026-09-28-a2-cross-model,2026-09-30-a3-cross-model-after-fix,2026-10-01-a2-rescore-command-first,2026-10-01-a3-instrument-repairs,2026-10-02-a3-smoke,2026-10-02-passing-a0,2026-10-02-grok-assignment-segments,2026-10-02-grok-permission-cancellations,2026-10-02-grok-smoke-2,2026-10-02-grok-smoke-3}.md`,
`tests/invalid-fixtures.test.ts`, `tests/learn/evals/trigger-eval.ts`. At `6c6d2ab`: the log
from `7c1c530`, `research/evals/2026-10-02-cross-host-case-runner.md` and `adapters/codex/CONTRACT.md` §5.

Outside the repository: the mission brief and the design document it names (`C:L151`), both held
privately; the Claude Code and Codex documentation pages, the installed binaries and the Codex source
at `rust-v0.153.4`, as listed in `research/host-facts/2026-10-03/README.md`.
