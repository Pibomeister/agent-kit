Mission brief: constitution support in agent-kit

Requested by the maintainer, 30 Sep 2026. The direction is approved; the design is not. Your first milestone ends in a proposal and a stop.

1. Mission

Make every change produced through agent-kit follow an adopting organization's engineering constitution. Do it without loading the whole constitution into the agent, and without trusting the agent's own report that it complied.

The design has three parts, and an outside adversarial review has already shaped them:

Boundaries hold the hard constraints. The sandbox, scoped credentials, trusted CI evidence and branch protection are what stop a prohibited effect. Hooks give early feedback in front of them, because on both hosts a hook that times out or errors lets the call through.
A registry keeps the constitution as the source. Each article is registered with its source text, exceptions and related articles. Only selected obligations compile into checks, and each check states exactly which part of an article it covers. Unknown coverage stays visible.
How the judgment articles reach the agent is an experiment. Full text, compiled, core only and a placebo are compared under the same safety controls before anyone picks one.

You build the generic machinery in agent-kit. The organization's constitution text and organization-specific packs belong in a separate overlay, never in this public repository; use invented fixtures here.

2. How to work
Follow this repository's own law: AGENTS.md (invocation law, layout, shipping), AUTHORING.md (§1 size, §4 frontmatter, §5 provenance, §6 ruling citations, §7 prohibitions, §8 writing, §9 evals, §12 roles, protocols and packs) and catalog.yaml as the single source of truth.
Start with Milestone 0 and stop for approval before writing any code.
One ticket per PR. Commit on a feature branch and ship with git push no-mistakes <branch>. Never push to origin directly and never use --no-verify.
Before each commit, bun test, bun run ak validate and bun run ak build must all pass. Commit messages carry the repo's trailers (Constraint, Rejected, Confidence, Scope-risk, Reversibility, Directive, Tested, Not-tested), and a quoted figure names its instrument.
Keep model names, pricing, effort tiers and routing out of every tracked file outside research/ and provenance/, and write no placeholder tokens. The validator fails the build on both.
Verify each host fact in Appendix B on the installed claude and codex CLIs before you depend on it. Record the receipts under research/ with the CLI versions.
After two failed attempts at the same problem, stop and report your hypotheses (ruling two-fix-cycles-then-stop).
Stop and ask before you change an existing ruling, contract or accepted ADR; touch the invocation law; make any hook block by default in the core profile; add a dependency; or commit anything specific to the organization.
3. What already exists

Build on these pieces rather than beside them.

Need | Existing piece | Gap
Trusted release evidence | The trusted-evidence capability (#38) and content-addressed receipts that the ship gate re-hashes and judges (#40). Both hosts withhold the capability, and the runner contract refuses fail-closed | A supplier: CI or a runner that records evidence outside the worker's reach
Project rules at review | code-review/project-standards; project record standards, mandatory_constraints, guidance | Cross-cutting articles and tie-breakers have no seat
Domain constraints | Packs: activation rules, constraint kinds, required lanes, fixtures | The organization's packs go in the overlay
Settled tensions | policies/resolved-conflicts.yaml and the restatement check | The constitution's tie-breakers need the same shape
A blocking hook | adapters/firstmate/hooks/child-guard.sh: a PreToolUse deny that also denies what it can't judge | No guard for the main thread
Hook wiring | ak learn setup wire and uninstall | The same pattern for a guard profile
Promotion loop | The learning runtime turns 3 events across at least 2 PRs into a guardrail draft; protocols/evidence-gate | It ends in text, and the gate's stated ceiling is misattributed evidence
Evals | claude plugin eval; the method in research/evals/ | Codex results are not-run; no conformance arms

4. Milestones
M0: map, verify, propose (no code, then stop)
Verification receipts for every fact in Appendix B, under research/.
docs/decisions/0007-constitution-support.md, status Proposed. It covers context, options, the decision you recommend, consequences, the split between agent-kit and the overlay, and proposed rulings (for example guard-is-feedback-not-boundary, coverage-names-the-predicate, constitution-reviewer-advisory-until-ruled). It also covers how provenance is recorded for capabilities that come from this design. One option: commit this brief under research/sources/ and cite line locators, the way G:L locators cite the design transcript.
A ticket plan for M1–M6 as a dependency graph, with acceptance criteria per ticket, the proposed catalog entries, and a recommendation for each open decision in §6.

Acceptance: nothing outside research/ and docs/decisions/ changes, and the ADR names the files it read.

M1: the feedback layer (guard, done gate, lint loop)
A new opt-in profile guard and host adapter, modelled on the learning runtime. ak guard hook <event> runs one policy evaluator behind a decoder and an encoder per host. Its policy is a data file for now: protected paths, destructive command patterns, secret patterns and a path-to-tier map. M3 generates that file later.
The guard denies:
- destructive commands and --no-verify
- reads of secret files
- writes to protected files: tests unless the ticket is about tests, CI config, lint and architecture config, baselines, CODEOWNERS, hook config and the registry
It also handles:
- "Ask first" actions. Deny with a pointer to a scoped, expiring grant. Reuse charter entries (ruling sensitive-actions-need-approved-charter-entry) rather than a second approval system.
- The first write to a governed path. Deny it once, with the applicable articles as the reason. PreToolUse context only reaches the model after the tool runs, so injecting it doesn't work.
- Codex. Emit deny only, because ask is unsupported there and fails open. Parse apply_patch text for every add, update, delete and move path, and treat an unparseable patch as protected.
- Input it can't judge, on any host. Deny it, as child-guard.sh does. Document that timeouts and errors still fail open, so the guard is never the boundary.
ak guard setup wire | uninstall for both hosts. Document managed delivery: Codex requirements.toml [hooks] plus [features].hooks = true, with scripts shipped separately; managed settings on Claude Code. The guard runs from a pinned install outside the workspace.
Done gate (Stop). A run ends verified or blocked, never shippable on this alone. It needs receipts for the current head, and any new suppression, placeholder or test removal must carry a justification. After two cycles it ends blocked.
Post-edit lint loop (PostToolUse). Runs the configured fast checks on the edited file and returns at most 20 lines of path:line RULE-ID message + fix.
Block log. Every deny and every lint hit is logged with its rule or article id to a ledger under the host configuration directory, never inside a project repository.
Replay contract tests. Recorded payloads for both hosts run through decoder, evaluator and encoder, including bypass fixtures: git -C . push; an interpreter writing a protected file; a symlink or rename into a protected path; an unparseable patch; a hook timeout (documented as fail-open).
Trusted-evidence supplier: design only. Add an ADR section for a CI job that runs the named checks on the exact head and records evidence where the worker can't write, satisfying trusted-evidence for super-ship. Build it once decision 5 is made.
Acceptance: The replay suite passes for both hosts' payload formats. The core bundle is unchanged, and skills behave the same with the guard absent. The contracts state that a missing or crashing guard widens nothing the sandbox and permissions allow.

M2: registry schema and coverage report
schemas/constitution-article.schema.json. Fields: id, version and tier (hard-constraint, default or judgment); source span: document, section and quoted text; exceptions, and related articles (conflicts, tie-breakers, supersedes); triggers: paths, symbols and types, artifact kinds, packs; principle, why, do and don't; enforced_by[], where each entry names the mechanism and the exact predicate it covers; review questions, good and bad examples, translation fixtures.
A project-record field that points at a registry (an overlay path or a package).
Registry checks inside ak validate when a registry is configured, plus ak constitution coverage. The report lists each article's channels and covered predicates, and lists uncovered obligations. It fails when a hard-constraint article has no boundary mapping. It never reports a whole article as covered because one of its predicates is.
An invented fixture registry under tests/fixtures/: 10–15 articles, at least one exception and one tie-breaker. Add invalid-case fixtures too.
Acceptance: the coverage report is stable on the fixtures. An article with no source span, or an enforced_by entry with no predicate, fails with a named rule id.

M3: compiler
ak constitution build emits: An AGENTS.md core of about 100 lines and under 32 KiB: the precedence order, the hard constraints (each with its reason and safe path), the operating protocol, and a map of where the rest lives. A CLAUDE.md holding @AGENTS.md plus Claude-only notes. Path-scoped rules in .claude/rules/*.md with paths:. Codex review sections: ## Code Review Rules in nested AGENTS.md files. Standards files for project-standards. Pack constraint stubs mapped to article ids. The guard policy file.
Every emitted rule carries its article id and version. --check detects drift in CI.
Acceptance: the fixtures compile the same output every time, --check fails after a hand edit, and the core stays within both hosts' limits.

M4: code-review/constitution seat, advisory
roles/code-review/constitution/ROLE.md, at most 150 lines (§12.2), with its catalog entry. Add a seat in policies/review.yaml that activates when a registry is configured, required: false.
What the seat judges: the articles the change triggers (by path, symbols, types and packs) plus the cross-cutting ones; it leaves alone only the exact predicates a check already verified; it applies the precedence order when articles collide.
What it receives: ADRs, migration plans and exception grants, but never the author's narrative.
Each question returns not applicable, conforming, violation or insufficient evidence, and insufficient evidence never counts as a pass.
A violation carries: the article id and version, and the quoted rule; why the rule applies, and which exception was weighed; the consequence; evidence, which may span files.
Evals: positive cases; adversarial cases; negatives it must not flag: a fallback for non-critical telemetry, an approved compatibility adapter, a float that isn't money; three planted misses: money converted through Number in a shared helper, a check-then-insert race that duplicates a payment, and a wiring change that disconnects the audit writer.
Acceptance: evals report the false-block rate on negatives and the recall on planted violations as two separate figures.

M5: promotion that ends in checks
When a pattern promotes, the draft carries: the article id, or a proposed amendment; a proposed deterministic check; the original bad diff as a positive fixture, and the fix as a negative one; a repo-wide dry-run count.
Safeguards: a holdout corpus the learner can't read; claim-to-source verification, which closes the evidence gate's stated ceiling; a separate approval for anything that weakens a hard constraint, a grader or an authority; incidents and tier-3 findings can promote on one occurrence; the article's rationale stays once the check lands.
Acceptance: a planted misattributed claim is refused, and a proposed check that fails the holdout is refused.

M6: evals on both hosts
A host-neutral runner over codex exec --json, so Codex results stop being not-run.
The conformance experiment: four arms (full text, compiled, core only, length-matched placebo) under identical safety controls, with honeypot tasks per hard constraint. It measures task success, attempted violations, missed violations, unnecessary interventions, human takeovers and cost.
Deterministic replay tests carry the assurance for the controls. Agent runs find gross problems: zero failures in 8 runs still allows a failure rate near 31%.
No paid runs without the maintainer's approval. ADR-0006 authorizes none.

5. Out of scope
The organization's constitution text and its domain packs (pack-money, pack-ledger, pack-config). They go in the overlay.
The invocation law, and ADR-0005's status.
Model routing of any kind. Who fills a seat is the runner's business.
Making the reviewer seat block, or changing enforcement during a pilot.

6. Open decisions
Recommend an option for each; don't decide any of them.
1. Where the registry lives: an overlay repository that depends on agent-kit (recommended), or inside agent-kit.
2. Article ids: themed prefixes (SAFE-, FAIL-, MONEY-) or plain numbers.
3. PR-size guidance for the organization's projects: about 100 lines or 400, advisory either way.
4. Which tiers stop the run when a guard can't run.
5. Who supplies trusted-evidence: which CI, which identity, where the evidence store lives.
6. How a person grants a scoped, expiring approval for an "ask first" action.
7. Whether to emit Codex allow_implicit_invocation: false for U skills. It departs from ADR-0003's choice, but the 2026-09-28 cross-host run found Codex starting U skills from prose in 42–46 of 60 sessions.
8. The eval budget per release, in cases × replicates × hosts.

7. Definition of done, every PR
bun test, bun run ak validate and bun run ak build pass on the commit. A quoted figure uses research/probes/validate-figure.sh and names its instrument.
New behavior has tests; new skills, roles and packs have eval cases (§9).
Changed behavior is reflected in the contracts it touches (adapters/*/CONTRACT.md, profiles, policies), with ruling citations.
The PR description says: what changed and why; how it was verified, with commands and results; what was not verified; the assumptions made; the follow-ups.

Appendix A: why this design
HANDBOOK.md (Jul 2026). 65 tasks with 20–124-page procedures; the best model passed 36.2% of trials, and agents "report compliance they did not achieve".
ContextCov (Mar 2026). An AGENTS.md compiled into checks reached 88.3% constraint compliance, against 67.0% for a plain agent and 50.3% with self-reflection.
Guardrails Beat Guidance (Apr 2026). Random rules helped as much as curated ones (+13.8 points each), and every rule that helped on its own was a negative constraint.
SkillsBench (Feb 2026). Curated skills added 18–25 points; skills agents wrote for themselves cost 8–12.
ImpossibleBench (Oct 2025). Read-only tests blocked the main cheating tactic of one model family, over 79% of its cheating.
Vercel (Jan 2026). The skill was never invoked in 56% of eval cases; an index in AGENTS.md passed 100%.

Appendix B: host facts to verify on the installed CLIs
Claude Code:
- Hook failures. A timed-out command, http or MCP hook doesn't block. Exit code 1 without JSON is non-blocking; exit 2 blocks.
- Hook context timing. PreToolUse additionalContext lands next to the tool result, after the tool runs.
- Path rules. .claude/rules/*.md files with paths: load when Claude reads a matching file, not on every tool use.
- AGENTS.md loading. It is skipped by default when a CLAUDE.md exists; claude-md-and-agents-md loads both (v2.1.277 or later).
- Permission gaps. A deny rule for git push doesn't match git -C . push. Read and Edit deny rules don't cover a subprocess that opens files itself. The sandbox covers Bash and its children.
- Precedence. Hook decisions don't bypass permission deny or ask rules.
- Compaction. Project-root CLAUDE.md is re-read after compaction.
Codex:
- Ask. PreToolUse permissionDecision: "ask" is parsed but unsupported: the hook is marked failed and the call proceeds.
- Hook trust. Non-managed hooks are skipped until trusted, with trust recorded per hash. Managed hooks are trusted by policy.
- Managed delivery. requirements.toml [hooks] enforces the configuration but doesn't distribute the scripts; [features].hooks = true forces hooks on.
- Hook failures. A callback error, timeout or malformed response fails without blocking.
- apply_patch. It arrives as tool_input.command holding the patch text, with no file path.
- Nested AGENTS.md. Files load only along the root-to-working-directory chain; code review applies the scoped files per changed file.
- Manual-only skills. agents/openai.yaml policy.allow_implicit_invocation: false stops implicit invocation, while $skill still works.
- Context cap. Hook additionalContext is capped near 2,500 tokens by default.
Sources: code.claude.com/docs/en/{hooks,permissions,memory}; learn.chatgpt.com/docs/{hooks,enterprise/managed-configuration,agent-configuration/agents-md,build-skills}; openai/codex codex-rs/core/src/agents_md.rs.

Appendix C: where this came from
Design doc: "Engineering Constitution in agent-kit — Research & Brainstorm" (30 Sep 2026). Held privately with the source below; not committed here.
Source: the organization's constitution research foundations (25 Sep 2026), held privately. Never commit it here.
An outside adversarial review of the design (30 Sep 2026); its objections are folded into this brief.
