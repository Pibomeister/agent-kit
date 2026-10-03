# Constitution support: the M1–M6 ticket plan

The plan for `docs/decisions/0009-constitution-support.md` (ADR-0009), accepted by the captain on
2026-10-03 together with every recommendation under "Open decisions" below. `C:L<n>` cites lines of
`research/sources/mission-brief-constitution-support.md`; host facts cite the receipts under
`research/host-facts/2026-10-03/` by name, for example `codex-2`.

## How a ticket ships

One ticket is one PR on a feature branch, shipped with `git push no-mistakes <branch>`, never pushed
to `origin` directly and never with `--no-verify` (`C:L20`). Before each commit `bun test`,
`bun run ak validate` and `bun run ak build` pass, and a quoted figure comes from
`research/probes/validate-figure.sh` with its instrument named (`C:L21`, `C:L117`). New behavior has
tests, and a new role has eval cases (`C:L118`). A changed contract carries its ruling citations
(`C:L119`). The PR body says what changed and why, how it was verified, what was not, the
assumptions and the follow-ups (`C:L120`).

**Stop and ask** marks a ticket that changes an existing ruling, contract or accepted ADR, adds a
dependency, or makes a hook block by default in the core profile (`C:L25`). Accepting ADR-0009 settled
what those tickets do where the record names it, such as the `C:L` route and decision 7; the diff of
each is still asked for when its ticket starts.

Every catalog entry below is new at batch 13 (the highest batch at `7c1c530` is 12), enters as
`status: contract` with the file it declares, and becomes `authored` in the ticket that writes the
body.

## Dependency graph

```text
CS-00 C:L locator alias ─────────────────────────────────┐
CS-01 Codex contract corrections   (independent)         │
  └─> CS-02 Codex manual-only sidecar for U skills [decision 7]
                                                         │
M1  CS-10 policy schema + evaluator                      │
      ├─> CS-11 Claude Code decoder/encoder              │
      └─> CS-12 Codex decoder/encoder                    │
            └──(both)─> CS-13 setup wire, profile, contracts, block log
                          ├─> CS-14 ask-first grants + first-write deny   [decision 6]
                          ├─> CS-15 done gate (Stop)
                          └─> CS-16 post-edit lint loop
    CS-17 trusted-evidence supplier, design only  [decision 5]  (independent)

M2  CS-20 article schema + registry field + fixtures
      └─> CS-21 registry checks in ak validate
            └─> CS-22 ak constitution coverage

M3  CS-30 compiler core  (needs CS-21)
      ├─> CS-31 path rules + review sections
      └─> CS-32 standards, pack stubs, guard policy  (also needs CS-10)

M4  CS-40 constitution seat  (needs CS-00, CS-20)
      └─> CS-41 seat evals  [decision 8 for live runs]

M5  CS-50 promotion draft carries a check  (needs CS-20, CS-16)
      └─> CS-51 holdout + claim-to-source

M6  CS-60 Codex case results  (independent)
      └─> CS-61 four-arm experiment harness  (also needs CS-13, CS-30)  [decision 8]
          CS-60 builds on the case runner already in tests/learn/evals/case-runner.ts
```

M1 and M2 can run in parallel. The longest chain is CS-10 → CS-11/12 → CS-13 → CS-15.

## Groundwork

### CS-00 — The `C:L` locator alias

The redacted brief and its `local_sources:` row land with ADR-0009 itself, so this ticket carries only
the locator route ADR-0009 chose.

- **Changes:** a `locator_alias: C` field on the brief's row in `provenance/upstream.lock.yaml`;
  `src/validation/provenance.ts`, `schemas/common.schema.json`, `AUTHORING.md` §5 and
  `tests/provenance.test.ts` for a lock-backed alias.
- **Acceptance:**
  - `C:L1-153` resolves; `C:L154` is an error whose message names the bound 153, and the test fixture
    for it does not end in a newline that would hide an off-by-one.
  - An alias the lock does not register is refused, two rows claiming one alias are refused, and
    `G:L` behavior is unchanged.
  - Removing the alias field makes the `C:L` test fail, so the test measures the field and not a
    hard-coded name.
- **Stop and ask:** yes for the diff. The route is decided; `AUTHORING.md` §5 and the validator are
  existing contracts.

### CS-01 — Correct the Codex host contract to the installed facts

- **Changes:** `adapters/codex/CONTRACT.md` §3 (the manual-only row), §3.1, §6, and the version note;
  the stale `disable-model-invocation` emission language at `adapters/codex/CONTRACT.md` lines 198-200
  and in `skills/super-ship/skill.yaml`, which ADR-0003 retired.
- **Acceptance:**
  - The §3 row states that `agents/openai.yaml` `policy.allow_implicit_invocation: false` exists at
    0.153.4, hides the skill rather than denying it, and is dropped silently by a malformed file
    (`codex-7`), without deciding whether the packager emits it.
  - §6 states that the learning hooks are non-managed, skipped by `codex exec` until trusted, re-trusted
    after a definition change and not after a script edit, fail open, and spill context over about
    10,000 bytes (`codex-2`, `codex-4`, `codex-8`).
  - Every corrected sentence cites its receipt. No behavior changes; `ak build` output is identical.
- **Stop and ask:** yes, a contract change. It stands on its own, apart from ADR-0009.

### CS-02 — The Codex manual-only sidecar for U skills

- **Depends on:** CS-01.
- **Changes:** the codex packager emits `skills/<id>/agents/openai.yaml` with
  `policy.allow_implicit_invocation: false` for every U skill and for no other; a packaging test; the
  `adapters/codex/CONTRACT.md` §3.1 text; an ADR amending ADR-0003 for Codex.
- **Acceptance:**
  - The codex bundle carries the sidecar for each U skill and none for an M skill; the claude-code
    bundle is byte-identical before and after.
  - The packaging test parses every emitted sidecar, because a malformed one drops the policy
    silently (`codex-7`).
  - Each U skill keeps its description clause and its authority step.
  - The A3 Codex prose subset is measured before and after under the budget decision 8 sets; the
    ticket records both figures and the redirect rate, and a drop in the redirect rate is reported,
    not absorbed.
- **Stop and ask:** yes, it amends accepted ADR-0003 (decided in ADR-0009's decision 7) and needs
  approval for the live measurement.

## M1 — the feedback layer

### CS-10 — Guard policy schema and evaluator

- **Changes:** `schemas/guard-policy.schema.json`; `src/guard/policy.ts`, `src/guard/evaluate.ts`
  and a normalized action type (`shell` with argv tokens, `read`, `write`, `patch` with every path);
  `tests/guard/evaluate.test.ts`; a hand-written example policy under `tests/fixtures/guard/`.
- **Catalog:** `schemas: guard-policy`.
- **Acceptance:**
  - The evaluator returns `deny` with a rule id for: destructive command patterns; `--no-verify` on
    any git subcommand; reads of secret paths; writes to protected paths (tests unless the ticket
    scope names tests, CI config, lint and architecture config, baselines, CODEOWNERS, hook config, the
    registry).
  - git global options (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`) are skipped before the
    subcommand, as `child-guard.sh` does, so `git -C . push` and `git -c x=y push` reach the push rule.
  - An inline interpreter (`python -c`, `node -e`, `sh -c`, `bash -c`, `perl -e`) whose code names a
    protected path is denied; one that does not is allowed and listed as a known gap in the contract
    (`claude-code-5`).
  - Input the evaluator cannot classify is `deny` with rule id `guard.unjudgeable`.
  - The evaluator is pure: no file, network or clock access beyond its arguments.
- **Stop and ask:** no.

### CS-11 — Claude Code decoder and encoder, `ak guard hook`

- **Changes:** `src/guard/hosts/claude-code.ts`; `ak guard hook pre-tool-use` in `src/cli.ts` (the
  stdin read today exists only for `learn hook`); replay payloads recorded from 2.1.288 under
  `tests/fixtures/guard/claude-code/`.
- **Acceptance:**
  - Every replay payload runs decoder, evaluator and encoder, and the expected decision matches.
  - A deny is `hookSpecificOutput.permissionDecision: "deny"` with the reason, on stdout, exit 0
    (`claude-code-1`). The encoder never relies on exit 2.
  - Bypass fixtures: `git -C . push`; an interpreter writing a protected file; a symlink and a rename
    into a protected path; a hook timeout, recorded as fail-open in the expected file (`C:L63`).
  - Payloads that are not JSON, or lack `tool_name`, are denied.
- **Stop and ask:** no.

### CS-12 — Codex decoder and encoder, apply_patch parsing

- **Changes:** `src/guard/hosts/codex.ts`; an apply_patch parser; replay payloads shaped from the
  `rust-v0.153.4` source under `tests/fixtures/guard/codex/`.
- **Acceptance:**
  - The encoder emits deny only, never `ask` and never `allow` (`codex-1`).
  - The parser returns every `Add File`, `Update File`, `Delete File` and `Move to` path from
    `tool_input.command`; a patch it cannot parse is treated as touching a protected path (`codex-5`).
  - A Bash command that pipes a heredoc into `apply_patch` is parsed the same way, because Codex sends
    it as `tool_name: bash`.
  - Additional context and reasons stay under 10,000 bytes (`codex-8`).
- **Stop and ask:** no.

### CS-13 — `ak guard setup`, the `guard` profile, contracts, block log

- **Changes:** `src/guard/setup/{wire,uninstall}.ts` modelled on `src/learn/setup/`; `profiles/guard.yaml`;
  `adapters/claude-code/CONTRACT.md` §8 and `adapters/codex/CONTRACT.md` §7, "The guard runtime's
  hooks"; a block log under the host configuration directory; a SessionStart self-check; the ruling row
  `guard-is-feedback-not-boundary`.
- **Catalog:** `profiles: guard`.
- **Acceptance:**
  - `ak build` for the core profile produces byte-identical output before and after the ticket.
  - `wire` is idempotent, writes a `.bak` once, and refuses before any write when a target file is
    invalid JSON or TOML; `uninstall` removes only the guard's entries.
  - On Codex, `wire` records `trusted_hash` for the guard's hooks or prints the exact `/hooks` step,
    and the contract says headless runs skip an untrusted hook (`codex-2`).
  - The contracts document managed delivery: on Codex, requirements.toml `[hooks]` with
    `[features].hooks = true` and the scripts shipped separately (`codex-3`); on Claude Code, managed
    settings. The guard runs from a pinned install outside the workspace.
  - Both contracts state that a missing, slow or crashing guard widens nothing the sandbox and the
    permissions allow, citing ruling `guard-is-feedback-not-boundary` once the row exists.
  - Each deny is logged with its rule or article id, the host, the session and the tool, under the
    host configuration directory and never inside a project repository.
  - Skills behave the same with the guard absent; no skill body names a guard hook.
- **Stop and ask:** no, provided no hook blocks by default in the core profile, which this ticket
  never does.

### CS-14 — "Ask first" grants and the first write to a governed path

- **Changes:** grant lookup in the evaluator; `ak guard grant` (or the runner, per decision 6);
  per-session "already shown" state in the block log; tests.
- **Acceptance:**
  - An ask-first action is denied with a reason that names the action, the scope and the command a
    human runs to grant it; the host never sees `ask`.
  - A grant has the charter `sensitive_grants` shape (action, scope, human approval bound to a hash,
    `expires_at`, `single_use`) from `schemas/charter.schema.json`, is read from outside every worktree
    and the git directory, and is refused when missing, edited, expired or used.
  - The first write in a session to a governed path is denied once, with the applicable article ids
    and one-line rules as the reason; the retry passes (`claude-code-2`).
- **Stop and ask:** yes if the charter schema or the binds of ruling
  `sensitive-actions-need-approved-charter-entry` must change.

### CS-15 — Done gate on Stop

- **Changes:** `ak guard hook stop` for both hosts; tests over recorded transcripts.
- **Acceptance:**
  - A run ends `verified` only with receipts for the current head, checked by the existing gate code
    in `src/lifecycle/gate.ts`; otherwise `blocked` with the missing receipt named. Neither verdict is
    "shippable", and neither is evidence for a gate.
  - A new suppression, unfinished-marker token or test removal in the diff needs a justification line,
    or the run is blocked.
  - After two blocked cycles the third ends blocked and stops asking for another pass (ruling
    `two-fix-cycles-then-stop`).
- **Stop and ask:** no.

### CS-16 — Post-edit lint loop

- **Changes:** `ak guard hook post-tool-use`; a configured list of fast checks per path glob.
- **Acceptance:** the output on an edited file is at most 20 lines of
  `path:line RULE-ID message + fix`, carried as additional context under the Codex cap; a check that
  exceeds its time budget is skipped and logged, never retried in the loop.
- **Stop and ask:** no. A check that needs a new package dependency stops.

### CS-17 — Trusted-evidence supplier, design only

- **Changes:** a design section, as an ADR amendment or a new ADR, once decision 5 is made.
- **Acceptance:** the design names the CI, the signing identity and how the ship gate verifies it, the
  evidence store and who can write it, and the adapter that supplies `trusted-evidence` fail-closed
  (ruling `fail-closed-adapter-lifts-ceiling`).
- **Stop and ask:** yes, it proposes a runner-contract and adapter change.

## M2 — registry schema and coverage

### CS-20 — Article schema, registry field, fixtures

- **Changes:** `schemas/constitution-article.schema.json` with the fields `C:L68` lists; an optional
  `constitution.registry` field in `schemas/project.schema.json` naming an overlay path or a package;
  an invented registry of 10 to 15 articles under `tests/fixtures/constitution/registry/`, with at least
  one exception and one tie-breaker; invalid cases under `tests/fixtures/invalid/`.
- **Catalog:** `schemas: constitution-article`.
- **Acceptance:** every fixture article validates; each invalid case fails under one named rule id;
  no fixture text comes from any real constitution.
- **Stop and ask:** yes, `schemas/project.schema.json` is an existing contract.

### CS-21 — Registry checks in `ak validate`

- **Changes:** a `constitution` check registered in `src/validation/run.ts`, active only when the
  project record names a registry; rule ids under `constitution.*`.
- **Acceptance:** an article with no source span fails `constitution.missing-source-span`; an
  `enforced_by` entry with no predicate fails `constitution.enforced-by-without-predicate`
  (`C:L72`); unknown related ids and tie-breaker cycles fail under their own ids; with no registry
  configured the check reports nothing and the summary is unchanged.
- **Stop and ask:** no.

### CS-22 — `ak constitution coverage`

- **Changes:** the report command and a snapshot test over the fixture registry; the ruling row
  `coverage-names-the-predicate`.
- **Acceptance:**
  - Output lists each article's channels and covered predicates, and every uncovered obligation.
  - It exits non-zero when a hard-constraint article has no boundary mapping.
  - It never reports a whole article covered because one predicate is.
  - Two runs on the fixtures produce byte-identical output.
- **Stop and ask:** no.

## M3 — compiler

### CS-30 — Compiler core

- **Changes:** `ak constitution build` emitting the AGENTS.md core and a CLAUDE.md that imports it;
  `--check`.
- **Acceptance:** the fixtures compile to the same bytes every time; `--check` fails after a hand edit;
  the core holds the precedence order, the hard constraints each with reason and safe path, the
  operating protocol and a map of the rest; it stays near 100 lines and under 32 KiB, and the deepest
  AGENTS.md chain the fixtures produce stays under the Codex combined budget (`codex-6`); every
  emitted rule carries its article id and version.
- **Stop and ask:** no.

### CS-31 — Path rules and review sections

- **Changes:** `.claude/rules/*.md` with `paths:`, and `## Code Review Rules` sections in nested
  AGENTS.md files.
- **Acceptance:** each path rule's glob matches the article's triggers; review sections land only in
  directories the triggers name; the contract notes that path rules arrive after the first touch and
  never for a shell command (`claude-code-3`), and that the Codex CLI review only instructs the model
  to consult scoped files (`codex-6`).
- **Stop and ask:** no.

### CS-32 — Standards files, pack stubs, guard policy

- **Changes:** standards files in the shape `project.schema.json` `standards` expects, pack constraint
  stubs mapped to article ids, and the guard policy file valid against `schemas/guard-policy.schema.json`.
- **Acceptance:** the emitted policy round-trips through CS-10's loader; each stub and standards entry
  names its article id and version; `--check` covers all three.
- **Stop and ask:** no.

## M4 — the constitution seat, advisory

### CS-40 — Role, catalog entry, seat

- **Changes:** `roles/code-review/constitution/ROLE.md` in §12.2's eight sections, at most 150 lines
  (`C:L80`); a seat in `policies/review.yaml` that activates when a registry is configured and is not
  required; the ruling row `constitution-reviewer-advisory-until-ruled`; the conversation-map row.
- **Catalog:** `roles: code-review/constitution`.
- **Acceptance:**
  - The body carries the mandated `## Never` rows verbatim and passes `role.*` checks.
  - It judges triggered articles (paths, symbols, types, packs) and the cross-cutting ones, leaves
    alone only predicates a check verified, and applies the precedence order when articles collide.
  - Its input admits ADRs, migration plans and exception grants and never the author's narrative.
  - Each question returns not applicable, conforming, violation or insufficient evidence; a violation
    carries article id and version, the quoted rule, why it applies and which exception was weighed,
    the consequence, and evidence that may span files (`C:L81-84`).
- **Stop and ask:** yes. `AUTHORING.md` says the role population is complete, and that sentence
  changes; the seat's `required` field shape is checked against `policies/review.yaml` usage first.

### CS-41 — Seat evals

- **Changes:** cases with fixtures for positives, adversarial cases, three negatives (a fallback for
  non-critical telemetry, an approved compatibility adapter, a float that is not money) and three
  planted misses (money converted through `Number` in a shared helper, a check-then-insert race that
  duplicates a payment, a wiring change that disconnects the audit writer) (`C:L85`).
- **Acceptance:** the scorer reports the false-block rate on negatives and the recall on planted
  violations as two separate figures (`C:L86`); a deterministic replay of recorded seat outputs runs in
  `bun test`; live runs happen only under decision 8.
- **Stop and ask:** yes if the cases are declared under an existing skill's `skill.yaml`.

## M5 — promotion that ends in checks

### CS-50 — The promotion draft carries a check

- **Changes:** `src/learn/review/propose.ts` and the lesson schema.
- **Acceptance:** a promoted draft carries the article id or a proposed amendment, a proposed
  deterministic check, the original bad diff as a positive fixture and the fix as a negative one, and a
  repository-wide dry-run count; the article's rationale stays when the check lands (`C:L89-90`).
- **Stop and ask:** yes, `schemas/lesson.schema.json` is an existing contract.

### CS-51 — Holdout and claim-to-source

- **Changes:** a holdout corpus outside anything the judge reads; a claim-to-source check in the
  evidence gate; separate approval for anything that weakens a hard constraint, a grader or an
  authority; single-occurrence promotion for incidents and the highest-tier findings.
- **Acceptance:** a planted misattributed claim is refused, and a proposed check that fails the
  holdout is refused (`C:L91`).
- **Stop and ask:** yes, `protocols/evidence-gate/PROTOCOL.md` changes its stated ceiling.

## M6 — evals on both hosts

### CS-60 — Codex results that stop reading `not-run`

`tests/learn/evals/case-runner.ts` (since `1fe16d1`) already runs a named `case.yaml` on Codex and
Grok subjects through the shared subject adapters, with a zero-session dry run and an explicit execute
gate. What is missing is a run of the corpus on Codex and the contract text that follows from it.

- **Changes:** a case list covering every skill's declared cases; replay fixtures of recorded Codex
  transcripts for any grader the runner does not yet exercise; the Codex row in
  `adapters/codex/CONTRACT.md` §5.
- **Acceptance:** the dry run lists the full planned matrix and starts nothing; recorded transcripts
  replay through the graders in `bun test`; §5 stops reading `not-run` only for cases a live run the
  maintainer approved actually covered, and names the rest.
- **Stop and ask:** yes for any live run, and for the contract change.

### CS-61 — Four-arm conformance harness

- **Changes:** arms for full text, compiled, core only and a length-matched placebo under identical
  controls; one honeypot task per hard constraint; metrics for task success, attempted violations,
  missed violations, unnecessary interventions, human takeovers and cost (`C:L94-95`).
- **Acceptance:** a dry run with recorded transcripts produces every metric per arm; the controls'
  assurance comes from the M1 replay suite, and the report states that zero failures in 8 runs still
  allows a failure rate near 31% (`C:L96`).
- **Stop and ask:** yes for any live run (`C:L97`).

## Proposed catalog entries

```yaml
schemas:
  - id: guard-policy
    batch: 13
    status: contract
    summary: >-
      The guard runtime's policy data: protected paths, destructive command patterns, secret path
      patterns, a path-to-tier map and the governed paths with their article ids. Hand-written until
      the constitution compiler generates it.
  - id: constitution-article
    batch: 13
    status: contract
    summary: >-
      One registered constitution article: source span, tier, exceptions, related articles, triggers
      and the checks that cover it, each naming the exact predicate it verifies. Registries live in an
      overlay; this package holds only the shape and invented fixtures.

roles:
  - id: code-review/constitution
    batch: 13
    provenance_origin: conversation
    status: contract
    tier: conditional
    summary: >-
      Advisory. Judges a change against the constitution articles it triggers and the cross-cutting
      ones, citing article id, version and quoted rule; never blocks. Seated only when the project
      record names a registry.

profiles:
  - id: guard
    batch: 13
    status: contract
    summary: >-
      Opt-in. Installs the `ak guard` runtime's hooks: early feedback in front of the sandbox,
      credentials and CI, never the boundary. Never required: every skill works without it.

# Only if decision 5 lands on a CI supplier (CS-17, then its build ticket).
adapters:
  - id: ci-evidence
    batch: 13
    status: contract
    summary: >-
      Supplies trusted-evidence from signed CI statements bound to the exact head, and fails closed
      when unconfigured or when a statement does not verify.
```

Conversation-map rows follow for the two schemas, the role and the adapter, with `origin:
conversation` and a `C:L` locator (or `plan §` under CS-00's fallback). The profile gets none, as
`learning` has none.

## Open decisions

The brief asked for a recommendation on each and a decision on none (`C:L106`). The captain took every
recommendation below as written on 2026-10-03, and ADR-0009 records them as decisions.

**1. Where the registry lives — an overlay repository that depends on a pinned agent-kit.** The
repository is public, and the brief forbids the constitution text and the organization's packs here
(`C:L15`). A registry inside agent-kit would put the articles in the same history as the generic
machinery and make every amendment a change to a public package. The overlay pins an agent-kit
version, so a schema change reaches the organization as a deliberate upgrade. The cost is two
repositories to keep in step, which `--check` in CI and the pinned version contain.

**2. Article ids — a themed prefix and a number (`SAFE-003`), immutable once assigned and never
reused.** Ids appear in block messages, lint lines and review findings, where a reader benefits from
seeing the theme. The risk of a themed id is that an article changes theme and its id then lies;
immutability answers that, and the theme is recorded in its own field so classification never has
to be read from the prefix. This is the stance `policies/resolved-conflicts.yaml` takes on its own ids:
stable, and renaming one is a breaking change. agent-kit's schema should admit both shapes, so the
choice stays the overlay's.

**3. PR size for the organization's projects — 400 changed lines, advisory.** The constitution is the
organization's source and states 400; carrying 100 in its project records would have the agent's
guidance contradict the constitution's own warnings. Both numbers are advisory, neither is grounds for
a finding on its own (ruling `numeric-heuristics-are-guidance`), and agent-kit's default stays 100 for
everyone else. A size number may still raise a delegation class, which the delegation rulings already
govern.

**4. Which tiers stop the run when a guard cannot run — hard-constraint articles and the two most
restrictive path tiers.** A hook cannot make its own failure block on either host
(`claude-code-1`, `codex-4`), so "stop" has to happen somewhere that still runs. The SessionStart
self-check warns when the guard is missing or unpinned. The done gate ends a run `blocked` when the
block log shows no guard activity for a tool call that touched a hard-constraint trigger or a path in
the ask-first or never tier. Everything else continues with a logged warning, because blocking every
run on a guard outage teaches people to remove the guard. On Codex under managed configuration a guard
hook that fails to load already aborts session start (`codex-3`), the one fail-closed path the hosts
offer. If the whole hook layer is down, nothing in the loop stops the run, and CI and branch
protection hold the line.

**5. Who supplies trusted evidence — the overlay's CI on the protected default branch.** A workflow
file on the default branch, protected by CODEOWNERS and a ruleset, runs the named checks on the exact
head and signs a statement with the CI's workload identity, so no long-lived secret exists for a worker
to reach. On GitHub that is an artifact attestation verified against the signer workflow; where the
plan does not offer attestations for private repositories, a check run published by a GitHub App
whose key lives only in CI, verified by app id. A new `ci-evidence` adapter supplies
`trusted-evidence` from it and fails closed. The runner is the alternative already in the contract,
but on a single-user machine it shares the worker's account, which ADR-0007 says is not provenance.
Confirm the attestation plan limits before building.

**6. How a person grants an ask-first approval — a charter-shaped grant the human issues outside the
agent's session.** The guard's deny names the exact command. The human runs it in their own terminal;
it writes a grant in the charter `sensitive_grants` shape (action, scope, approval bound to a hash,
`expires_at`, `single_use`) to a store outside every worktree and the git directory, registered by
hash as ADR-0008 does for bypass grants. Default single-use, default expiry one hour, cap 24 hours. On
a single-user install this guards against accidents and shortcuts, not a determined agent; the runner,
or a separate account, as issuer closes that gap later. Reusing the charter shape is ruling
`sensitive-actions-need-approved-charter-entry`'s requirement, not a preference.

**7. Codex `allow_implicit_invocation: false` for U skills — adopt it, measured.** The key exists and
works at 0.153.4 (`codex-7`). The case for it is weaker than the brief states: after the wording fix
the Codex subjects loaded a U skill in 16 and 21 of 60 prose sessions, not 42 to 46, no valid session
made a side-effect call, and most loads stopped and named the command
(`research/evals/2026-09-30-a3-cross-model-after-fix.md`). Seven valid sessions on one subject still
loaded without naming it. Hiding the skill removes those loads, keeps `$skill` and Firstmate briefs
working when they mention the skill explicitly, and keeps the description and the authority step as a
second layer. The cost is the ADR-0003 principle that the model can load any skill, and a redirect
that depends on the roster line rather than the skill. So: emit the sidecar for U skills on Codex
only, add a packaging test that it parses (a malformed file drops the policy silently), and re-run the
A3 Codex prose subset before and after under an approved budget. It amends ADR-0003 and needs the
maintainer.

**8. Eval budget per release — deterministic replay on every commit; agent runs only where something
changed.** Agent runs find gross problems; they cannot show safety, since zero failures in 8 runs
still allows a failure rate near 31% (`C:L96`). Per release: the cases of changed skills and roles,
three replicates, on both hosts, under a per-release session cap the maintainer sets once; nothing else
reruns. The four-arm experiment is a one-off with its own approval: four arms, one honeypot per hard
constraint plus as many ordinary tasks, three replicates, two hosts. Subscription logins only; no run
billed to an API key without approval.

## Redaction record for the committed brief

`research/sources/mission-brief-constitution-support.md` is the brief with these nine lines changed and
every other byte kept, approved by the captain on 2026-10-03, so `C:L` locators mean the same line in the private original and the public
copy (153 lines, sha256 `0018dd4bd15819be4cb2a55ae5056ee22cdb0446da62907871e3d381a81eab82`).

| Line | Change |
|---|---|
| 3 | The requester's name and organization become "the maintainer" |
| 7, 15, 25, 33, 100, 109 | The organization's name becomes "the organization" or "an adopting organization" |
| 151 | "Exported to design-doc.md beside this file" becomes "Held privately with the source below; not committed here" |
| 152 | The private source's title becomes a description of it |

The domain-pack names on line 100 (money, ledger, config) are kept: they name kinds of pack, not the
organization or its text.
