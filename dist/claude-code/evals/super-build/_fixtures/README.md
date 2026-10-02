# evals/super-build/_fixtures

Shared fixtures referenced by more than one skill's cases via
`context.scaffold_script`. Nested under `super-build/` rather than directly
under `evals/` because `ak validate` (`evals.unknown-skill-directory` in
`src/validation/evals.ts`) treats every directory directly under `evals/` as
a skill's case directory and errors on one that names no skill in
catalog.yaml; a directory one level deeper, with no `case.yaml` of its own,
is outside that check. Living under `super-build/` is bookkeeping only --
`tiny-config-repo` below is shared with `super-review` exactly as if this
were `evals/_fixtures`.

## tiny-config-repo

A minimal, dependency-free Node project (`parseConfig` in `src/config.js`,
tested with `node --test`, no `npm install` needed) used by the two
`firstmate`-tagged delegation-boundary cases:

- `evals/super-build/task-local-child-does-not-ship`
- `evals/super-review/worker-helper-is-not-an-independent-judge`

Each of those cases has its own `scaffold.sh` that copies this fixture into
the run's throwaway workspace, `git init`s it, commits a baseline (and, for
the review case, a second commit implementing ticket T2 — the diff under
review), checks out a task branch, and writes the Firstmate-like task
context (`.agent-kit/task-context.md`) the cases' prompts refer to. Nothing
here is run directly; it is copied by the case-local scaffold scripts.

**A run of either case needs `--scaffold`.** Without it the case's workspace
is empty — nothing to build, nothing to review — which is exactly the
failure mode recorded in `docs/decisions/0002-firstmate-integration.md`
("The two delegation-boundary evals"): both cases scored identically with
and without the plugin because there was no fixture to act on.

## tiny-service-repo

A dependency-free Node service (CommonJS, `node --test`, no `npm install`)
with a dozen small modules -- HTTP retry, sync client, rate limiter,
gateway, CSV export, email templates, sessions, billing, payments webhook,
tenancy, admin console, NDJSON import -- each with its own tests, plus
`STANDARDS.md` and `CONTRIBUTING.md`. Its test command is `npm run check`
and its lint is `npm run lint` (`scripts/lint.js`, the `lint` required check
of the cases that have one). There is deliberately no `test` script, so a
run that assumes the ecosystem default gets an error rather than a receipt.
At the fixture's own state the suite passes (30 tests) and lint is clean;
each case's defect is written by its scaffold, before the baseline commit
when git history must not reveal it.

## tiny-service-tickets

Ticket exports for tiny-service-repo (AK-214, AK-341, AK-420, AK-421,
AK-512, AK-702), each with acceptance criteria whose verification commands
select tests by name (`npm run check -- --test-name-pattern="AK-214 AC-1"`).
A scaffold copies the ones its case needs into the workspace's `tickets/`.
`super-verify/named-criterion-gets-a-receipt` then removes the
`Verification:` lines from its copy of AK-214, because that case measures
whether the run finds the check command itself.
The ultraqa case writes its own AK-702, an import contract, and does not
use this export.

## pr-812-org-cache

An overlay on tiny-service-repo, laid out at the repository's own paths:
pull request 812, which puts a process-wide `OrgCache` in front of
`resolveTenant`. `src/tenancy/org-cache.js` calls `crypto.randomUUID()`
without requiring `crypto` -- the runtime's global keeps the tests green and
`npm run lint` red. The review threads, check runs and runner events that go
with it are written by each case's scaffold under `pr-812/`, because `gh`
is not available in a run's workspace.

## search-migration-round-two

A copy of `skills/doc-review/tests/` -- the search migration plan, round
one's dispositions and the constraint change -- because the bundle ships
`evals/` but not a skill's `tests/`. Keep the two in step when either
changes.

## scaffold-lib.sh

Helpers the scaffolds source: copy a fixture, `git init` with a fixed
identity, commit at a fixed date (so every run of a scaffold produces the
same SHAs), write a verification receipt by running a ticket's command at
the head, record lifecycle gates through `bin/ak-gate.mjs` or
`src/lifecycle/gate.ts`, and build PR 812's branch and pull record.

Records a case needs bound to its head -- receipts, review runs, alignment
results -- are written untracked after the last commit, so writing them
does not move the head they name. Where a case needs the knowledgebase, the
scaffold supplies a read-only checkout of it as plain files (under
`knowledge-base/`, or as the whole workspace for doc-review's
`drafted-spec-gets-a-panel`), with a README saying what `kb://<path>`
resolves to, because the knowledgebase adapter has no implementation in a
run's workspace.

Cases scaffolded on these fixtures:

| Case | Fixture |
|---|---|
| `super-scout/named-question-returns-dossier` | tiny-service-repo |
| `super-scout/refuses-unbounded-question` | tiny-service-repo |
| `super-build/approved-ticket-executes-and-reports-receipts` | tiny-service-repo, AK-214 |
| `super-build/independent-tickets-still-parallel` | tiny-service-repo, AK-420, AK-421 |
| `super-build/graded-patch-finding-proceeds` | tiny-service-repo |
| `super-verify/named-criterion-gets-a-receipt` | tiny-service-repo, AK-214 |
| `super-verify/all-checks-fail-run-still-completes` | tiny-service-repo, AK-341 |
| `super-ship/dry-run-generates-a-payload-and-pushes-nothing` | tiny-service-repo, AK-341 |
| `super-review/new-behavior-without-coverage-selects-the-testing-seat` | tiny-service-repo, AK-512 |
| `super-review/risk-signals-select-the-conditional-seats` | tiny-service-repo, AK-702 |
| `super-review/one-line-fix-gets-a-delta-not-a-second-panel` | tiny-service-repo |
| `super-review/delta-reaches-an-untouched-affected-caller` | tiny-service-repo |
| `super-bound/approved-direction-stops-at-open-decisions` | tiny-service-repo, knowledgebase checkout |
| `super-bound/approved-spec-produces-tickets` | tiny-service-repo, reviewed and approved specification |
| `super-bound/delegated-refresh-token-rotation` | tiny-service-repo |
| `super-bound/vague-checkout-speed-criterion` | tiny-service-repo |
| `super-bound/refused-oversized-change-split` | tiny-service-repo |
| `diagnose/no-grant-emits-a-packet-not-a-patch` | tiny-service-repo |
| `diagnose/bug-with-repro-gets-a-cause` | tiny-service-repo |
| `diagnose/third-failed-fix-stops-the-run` | tiny-service-repo |
| `ultraqa/five-cycles-is-the-ceiling` | tiny-service-repo |
| `compound-refresh/drifted-path-is-updated-in-place` | tiny-service-repo, knowledgebase checkout |
| `receiving-review/assesses-a-thread-against-the-code` | tiny-service-repo, pr-812-org-cache |
| `receiving-review/outdated-thread-is-decided-by-fingerprint` | tiny-service-repo, pr-812-org-cache |
| `babysit-pr/failing-check-is-repaired-within-the-cap` | tiny-service-repo, pr-812-org-cache |
| `doc-review/changed-evidence-resurfaces-a-rejected-finding` | search-migration-round-two |
| `doc-review/drafted-spec-gets-a-panel` | knowledgebase checkout (own pages) |
| `compound/no-knowledgebase-means-no-repo-fallback` | tiny-service-repo |
| `doc-review/no-knowledgebase-write-stops-before-publishing` | tiny-service-repo |
| `doc-review/third-round-does-not-run` | tiny-service-repo |
| `receiving-review/refuses-to-produce-a-fresh-review` | tiny-service-repo |
| `super-align/no-knowledgebase-write-stops-before-publishing` | tiny-service-repo |
| `super-align/typo-fix-does-not-start-alignment` | tiny-service-repo |
| `super-bound/no-knowledgebase-write-stops-before-publishing` | tiny-service-repo |
| `super-bound/reviewed-ticket-does-not-reopen-bounding` | tiny-service-repo |
| `super-build/round-cap-adjudicates-open-findings` | tiny-service-repo |
| `super-review/baseline-reset-is-not-a-third-delta-loop` | tiny-service-repo |
| `super-review/confidence-does-not-close-a-finding` | tiny-service-repo |
| `super-review/refuses-to-edit-the-source-it-reviews` | tiny-service-repo |
| `super-review/seat-isolation-unavailable-stops-the-run` | tiny-service-repo |
| `super-review/third-fix-cycle-does-not-run` | tiny-service-repo |
| `super-scout/caller-hint-is-not-evidence` | tiny-service-repo |
| `super-ship/lesson-is-drafted-not-published` | tiny-service-repo |
| `super-verify/refuses-code-quality-opinion` | tiny-service-repo |
| `wayfind/out-of-scope-needs-a-reason` | tiny-service-repo |

Each case's `scaffold.sh` opens with a comment saying what it builds and
where the case's defect or decision point sits. As with tiny-config-repo, a
run of any of these cases needs `--scaffold`.

## Note on scope

An eval-runner-clean home for a directory like this one — one `ak validate`
does not have to be tricked past by nesting — is a `src/validation/evals.ts`
change (e.g. skipping a directory under `evals/` that holds no `case.yaml`
anywhere beneath it, or that starts with `_`), which is outside `evals/**`
and therefore outside what authored this fixture.
