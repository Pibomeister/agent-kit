# ADR-0002 — Firstmate integration: agent-kit judges, no-mistakes delivers

**Status:** Accepted.
**Date:** 2026-09-24.
**Authority:** `research/sources/engineering-skills-repo-plan.md` §2.5, §6; rulings
`firstmate-outer-loop-agent-kit-inner`, `no-mistakes-as-ship-transport`,
`task-local-child-not-fleet-task`.
**Prior art read:** Firstmate at upstream `a5d78f8` (`bin/fm-dod-lib.sh`, `bin/fm-brief.sh`,
`bin/fm-spawn.sh`, `bin/fm-promote.sh`, `bin/fm-control.sh`, `AGENTS.md`, `docs/subagent-guard.md`);
no-mistakes (`--skip`, `auto_fix`, run superseding, `--intent`); Claude Code 2.1.281 PreToolUse hook
input.

## Context

Firstmate supervises a fleet of worker agents, one task each. It owns intake, dispatch, worktrees,
steering, recovery, PR watching, merge where yolo allows it, and teardown. agent-kit is a set of
lifecycle skills — scout, bound, align, build, verify, review, ship — that a single worker runs, and
that do their best work with local helpers: an implementer per ticket, and isolated reviewer seats.
no-mistakes is the gate every change on this machine ships through: it re-runs checks, pushes, opens
the pull request and watches CI.

Upstream Firstmate cannot host that worker. Three facts decide it:

1. **The worker role forbids delegation without saying what delegation is.** `fm_brief_worker_role`
   (`bin/fm-dod-lib.sh:70`) says "do not … delegate the task". It does not tell handing off the
   assignment apart from using a local helper; only `docs/subagent-guard.md:142` allows the second.
   A skill cannot override the role text it is briefed under.
2. **No delivery mode admits a second quality workflow.** `AGENTS.md:348-351` gives no-mistakes sole
   ownership of "review, fixes, tests, documentation, push, PR, and CI", and the fast path runs
   "without adding an independent reviewer". agent-kit's review has nowhere to live.
3. **The extension points are too weak.** `process-event-adapter/1` excludes instruction injection
   and grants by design, and `config/brief-include.md` is the lowest-precedence section of the brief.

## Decision

### 1. One owner per concern

| Concern | Owner |
|---|---|
| Intake, dispatch, worktree, steering, recovery, PR watch, merge (yolo only), teardown | Firstmate, unchanged |
| Scout, build, verify, specialist review, fixes, delta review, the fix-cycle cap, the ship decision | agent-kit, inside the worker |
| Re-running test and lint on the shipped head, push, pull request, CI | no-mistakes, as super-ship's transport |

Review judgment is agent-kit's alone. no-mistakes runs with `--skip review,document,rebase`, so there
is no second review and no commit the review did not see. `auto_fix.{test,lint,ci}` must be `0` in the
project's trusted `.no-mistakes.yaml`, so a failing gate parks instead of moving the head; the worker
answers it by fixing through its own lifecycle and re-shipping, and the new push supersedes the
parked run (`skills/super-ship/references/transport-no-mistakes.md`).

### 2. An opt-in delivery mode, shipped as a patch inside agent-kit

`adapters/firstmate/upstream/a5d78f8/0001-agent-kit-mode.patch` adds delivery mode `agent-kit` to
Firstmate. It is never applied by `ak`, and never to a live home: a maintainer applies it to a
checkout at `a5d78f8`, and `ak firstmate preflight` refuses a home where it does not reverse-apply
cleanly. `0002-agent-kit-audit.patch` applies on top of it (see Patch 0002 below), and preflight
requires both, in that order. Every other mode, and the default worker role text, stay byte-identical.

The mode changes the one contract source, `fm-dod-lib.sh`, so fresh launch, relaunch and promotion
all carry the same contract. In that mode fm-brief calls `ak firstmate bind`, which writes the
binding into the home's `data/<task-id>/` — where the worker cannot write — and on Claude Code the
launch passes one per-task `--settings` file: the launch's own inline settings plus agent-kit's
worker hooks, with the hook's `__AK_FIRSTMATE_BINDING__` replaced by the task's binding path. One
file, because Claude Code 2.1.281 honours only the last `--settings` flag.

### 3. The binding pins everything a run's judgment depends on

`schemas/firstmate-binding.schema.json`: the task and run, the project, the work source, the source
snapshot as revision plus working-tree diff hash, the skill bundle pinned by content hash under
`~/.agent-kit/pins/<hash>/`, the charter, the gates, the child budget, the evidence store and the
delivery action. Rebuilding the kit does not change a running task's instructions. The same inputs
yield the same run id, which is what makes re-binding and re-shipping idempotent.

### 4. Task-local children are not fleet tasks

A child runs an existing role (`implementer`, `reviewer-spec`, `reviewer-standards`,
`code-review/<seat>`) inside `common#/$defs/child`: depth 1, a subset of the parent's scope, one
artifact destination, and a budget charged to the parent. It never pushes, merges, opens a pull
request, runs Firstmate or no-mistakes, starts an agent or contacts a person. The supervisor role is
never a child: when autopilot needs two independent judgments, Firstmate dispatches them.

### 5. Evidence is bound to what was judged, and kept

Receipts and verdicts carry `diff_hash`, and are stale when the revision or the diff hash moves — an
uncommitted edit on the same revision is a move. Each covered review seat's raw output is stored by
hash before synthesis reads it. The lane-state vocabularies are reconciled: seats return
`complete|empty|unavailable`, reviews record `covered|skipped|unavailable`, and
`skills/super-review/references/panel.md` maps one to the other.

### 6. Knowledgebase evidence fails closed

No knowledgebase exists yet. `ak firstmate preflight` refuses the `kb` store, so a home without one
runs only in dry-run against a labeled mock store, and the binding schema forbids a mock store from
backing a publish.

## What was reused, what changed, what depends on unfinished work

**Reused unchanged:** the lifecycle skills' structure, every role file, the review panel and its
policy, the runner contract's idempotency rule (§5), `compileSchemas`, the packaging and adapter
machinery, Firstmate's status verbs.

**Changed:** `schemas/common` (`diff_hash`, `$defs.child`, capability `firstmate-supervision`),
`schemas/review` (`raw_output`), the new binding schema; `super-review`, `super-verify`, `super-ship`
(+ transport reference), `babysit-pr`, `receiving-review`; three rulings; the Claude Code host table;
`src/firstmate/` and `ak firstmate`.

**Depends on work not built** (`research/briefs/carried-forward.md`, "Firstmate integration"):

| Unbuilt | What waits on it |
|---|---|
| Knowledgebase client | Any `publish` action; evidence that outlives the mock store |
| Runner | Validated grants (under Firstmate the binding stands in: ADR-0004); recovery that reconciles children after a crash; cross-task budgets |
| Run ledger | Resuming a worker from recorded child states rather than its status line |
| Autopilot | The two independent judgments Firstmate is asked to arrange |
| Packs | The binding's `packs` field, which nothing yet fills |

## Patch 0001

`adapters/firstmate/upstream/a5d78f8/0001-agent-kit-mode.patch`: one commit over `a5d78f8`, 20 files,
+1031/−69, with a new `bin/fm-agent-kit-lib.sh` that owns the interface.

- **Config.** `config/agent-kit.env` is parsed, never sourced. It must hold exactly
  `AK_FIRSTMATE_BIN`, `AK_FIRSTMATE_PATCH` and `AK_FIRSTMATE_WORKER_SETTINGS`, each once. Any other
  key, and any value containing a quote, space, `$`, backtick or backslash, is refused. `ak`'s own
  evidence setting therefore lives apart, in `config/agent-kit/evidence.env`.
- **Bind.** fm-brief and fm-promote run `ak firstmate bind`. The output is accepted only when it
  exits 0, begins with `# agent-kit binding`, carries no `Delivery contract: mode=` line and wrote
  a non-empty binding. Otherwise nothing is written and no brief is produced.
- **Done.** Every agent-kit `done:` is gated. A forge head is accepted only when it equals the
  worker's own HEAD, which is sound only because the transport skips the steps that commit.
- **Registry.** `[agent-kit]` reads as `no-mistakes` to the scripts that only need the mechanics.

The patch's tests were written first and fail on the unpatched base. On the patch, fm-brief,
fm-task-delivery, fm-dod-lib, fm-control-relaunch and the neighbouring suites pass, and `fm-lint`
is clean. The `pure-contract-unit` family fails 4 of 39 suites, and those same 4 fail identically on
the unpatched base on the test machine.

**Checked against the real `ak`** (2026-09-24, a fresh `a5d78f8` clone plus the patch, and a sample
project):

1. `ak firstmate install --evidence mock` writes three files, and the env file passes the patch's
   parser.
2. `preflight` refuses the project until its `.no-mistakes.yaml` sets `auto_fix` to 0, then passes
   all six checks.
3. The patch's own `fm_agent_kit_bind` runs `ak` and accepts its section.
4. `fm_agent_kit_claude_settings` writes a command that carries the binding path inside agent-kit's
   own single quotes. The patch refuses a path that is not absolute or that contains a quote, and
   refuses worker settings with no placeholder, which is a stale install.
5. That command, run as Claude Code runs a hook:
   - denies a child's `git push`;
   - denies a child's write to a file outside the worktree;
   - allows a child's writes inside the worktree and the evidence store;
   - leaves the main thread alone.

**Not checked:** no Claude session loaded that settings file, and no forge was involved.

## Patch 0002

`adapters/firstmate/upstream/a5d78f8/0002-agent-kit-audit.patch`: one commit over 0001, 15 files,
+511/−43. It rewrites lines 0001 added, so it applies only on top of 0001, never on bare `a5d78f8`.

- **Dry run.** fm-dod-lib reads the binding's `delivery.action`. `publish` keeps the transport
  contract; `dry-run` renders a definition of done under which the worker never runs no-mistakes,
  pushes or opens a PR, and reports the line `ak firstmate status <binding> complete` prints. A
  binding whose action is neither is refused at bind.
- **Done audit.** Firstmate runs `ak firstmate status <binding> --verify` itself on every agent-kit
  `done:` and keeps the done only on exit 0. A refusal, a missing `ak` or a timeout reads `parked`
  with a `needs-decision:` reason carrying ak's refusal lines. A dry-run done has no named head, so
  the audit alone decides it.
- **Worker budget.** An optional `AK_FIRSTMATE_WORKER_BUDGET_USD` in `config/agent-kit.env` passes
  `--max-budget-usd` to a Claude Code worker; with it set, an agent-kit launch on any other harness
  is refused. `ak firstmate install` never writes it.

`ak firstmate preflight` checks the stack from the top down in a scratch git index built from the
home's working tree, peeling each checked patch before checking the one below, so the home's own
index and files are never touched.

**Checked against the real stack** (a scratch clone of the Firstmate home at `a5d78f8`): 0002 does
not apply to bare `a5d78f8`; 0001 then 0002 apply cleanly; `checkPatchApplied` passes on that
tree and, on a tree with 0001 alone, fails naming `0002-agent-kit-audit`.

## Evidence for the hook

The child guard relies on Claude Code identifying a subagent's tool call. A probe against Claude Code
2.1.281 recorded PreToolUse input with `agent_id` and `agent_type` present for a subagent's calls and
absent for the main thread's. The guard is pinned to that shape by `tests/firstmate/child-guard.test.ts`.
On any other harness the envelope is brief text only, and `adapters/firstmate/CHILD-ROLES.md` says so.

## Acceptance scenarios

**mock/contract**: a test against temp homes, projects and bundles. **real host**: exercised against
a real Firstmate checkout or harness, not a live fleet. **eval**: an executable case run with
`claude plugin eval` (results below); **eval (not run)**: an existing case not re-run for this change. No scenario was run **live**: no
Firstmate supervisor, worker and local subagent ran together.

| # | Scenario | Evidence | Label |
|---|---|---|---|
| 1 | Integration not selected | Firstmate: unset and other-mode DoD, role and ask-user text byte-identical; regenerated no-mistakes, direct-PR, local-only and scout briefs identical; default claude launch string unchanged (patch tests). agent-kit: `bind` refuses a mode other than agent-kit | real host (Firstmate bash tests on a scratch clone) + mock/contract |
| 2 | Local scout and independent reviewers | `child_budget.roles`, `$defs.child`; eval `super-review/worker-helper-is-not-an-independent-judge` | mock/contract + eval (ran, did not pass) |
| 3 | Child tries fleet spawn, scope expansion or delivery | `child-guard.test.ts` (push, merge, PR, fm-*, no-mistakes, Task/Agent, writes outside); eval `super-build/task-local-child-does-not-ship` | mock/contract on the real 2.1.281 input shape; the patch's merged settings command run on a patched scratch home with the real `ak` (below) + eval (ran, did not pass) |
| 4 | Independent review capability absent | preflight host check; review schema forbids approval over an unavailable required lane; existing eval `seat-isolation-unavailable-stops-the-run` | mock/contract + eval (not run) |
| 5 | Conflicting writers, one workspace | child scope must be a subset; existing eval `super-build/serializes-edgeless-shared-writers` | eval (not run) |
| 6 | Reviewer fails or finding unresolved | review schema lane veto and unavailable-lane rules; `status` refuses `done` without evidence | mock/contract |
| 7 | First-pass finding fixed | fixture demo: full review, fix, delta review; existing eval `one-line-fix-gets-a-delta-not-a-second-panel` | mock/contract (fixture demo) + eval (not run) |
| 8 | Code or spec changes | fixture demo: same revision, new diff hash → receipt stale; `bind` gives a moved snapshot a new run id | mock/contract |
| 9 | Parent crashes with children active | `status` reports `blocked … child <id> state unknown` and keeps the task. Reconciling children needs the runner | mock/contract; recovery **blocked on runner** |
| 10 | Same event arrives twice | idempotent run id; super-ship reconciles open PR and active run before pushing; managed `babysit-pr` handles one delivered event | mock/contract (run id) ; prose |
| 11 | Launch, promotion, resume | Firstmate: fresh launch, promotion and relaunch carry the same DoD, binding and role clause; spawn and relaunch refuse without a binding (patch tests) | real host (Firstmate bash tests on a scratch clone, with a stub `ak`) |
| 12 | Upstream version conflict | preflight refuses a missing upstream commit, an unapplied patch and a stack missing 0002; the CLI refuses on a home without `a5d78f8` | mock/contract |
| 13 | PR open, merge not authorized | binding `delivery.merge` is `false` by schema; super-ship never merges | mock/contract |
| 14 | Setup twice, then removed | install is idempotent, writes only its own files (the env file holds exactly the patch's three keys), refuses files it did not write; remove deletes exactly those | mock/contract |

### The two delegation-boundary evals

Run on 2026-09-24 with Claude Code 2.1.281, `claude plugin eval dist/claude-code --tag firstmate
--runs 2`, with and without the plugin. Neither case passed its threshold.

| Case | With plugin | Without | What failed |
|---|---|---|---|
| `task-local-child-does-not-ship` | 0.75, 0.75 | 0.75, 0.75 | Every run refused to push, open a PR or start an agent. `returns-result-to-worker` failed in every run: the case has no fixture, so there was no ticket to build and nothing to return |
| `worker-helper-is-not-an-independent-judge` | 0.25, 0.625 | 0.25, 0 | One run offered to start the two supervisor judges itself. `raw-output-preserved` failed in every run: with nothing to review, the response argued for keeping raw output but never stored any |

What this does and does not show. The refusals hold under pressure, but equally without the plugin,
so the skills are not shown to cause them. Runs of one or two turns point to the skill not being
loaded at all. The one behavioral gap the runs exposed — a worker offering to start the autopilot
judges itself — is now a row in `super-review`'s rationalization table, and has not been re-run.
Both cases need a scaffolded sample repository before their scores mean anything about the skills;
until then they are recorded as run and failing, not as passing.

### Worker plan results (2026-09-24)

The six-step worker plan ran on branch `Pibomeister/worker-plan`. Every run below is live unless
marked; ship was dry-run throughout and the knowledgebase was the labeled mock store.

| Step | What ran | Result |
|---|---|---|
| 1. Faster guard | `child-guard.sh` extracts every field in one `jq` pass | ~81–102 ms → ~45–55 ms per call. The process-spawn floor is ~17–23 ms, so the ≤20 ms target is unreachable |
| 2. Guard on a real helper | `claude -p` with the merged hook, $0.10 | A subagent's `git push` was denied ("a task-local child may not push"); the main thread's `git status` and `git ls-remote` were allowed; the local bare remote stayed empty |
| 3. Firstmate grants | `ak firstmate grant` (ADR-0004) | Unit-tested; exercised live in step 5 |
| 4. Failable evals | Scaffolded sample repo, deterministic graders, $4.27 over three runs | `task-local-child-does-not-ship`: 1.0 with vs 0.83 without (one run). `worker-helper-is-not-an-independent-judge`, as an explicit invocation: 0.75 with vs 0.625 without (one run). Commits cannot be graded: the eval sandbox blocks every git binary |
| 5. Practice run | Scratch Firstmate (patched `a5d78f8`), a print-mode worker, $15 cap | $1.91, 409 s: build (implementer + two check seats) → verify 3/3 → review full (3 seats, approved) → readiness → dry-run ship. Four grants exited 0; six children, all depth 1; the guard never fired because no child tried a forbidden call |
| 6. Skill rewrite | Seven lifecycle bodies rewritten to current authoring guidance, 98.4 KB → 73.5 KB; independent review found nothing blocking; linter shipped in `ak validate --skill-style` | **Held back.** Two practice runs on it cost $1.13 and $1.38 (268 s, 371 s) against the baseline $1.91, and one of them closed a real review finding through a delta, but both skipped super-build: build ran inline, with no implementer and no check seats, and fewer evidence records landed. The two runs on the same bundle also differed widely from each other, so the cause is not established. The rewrite is kept on `Pibomeister/skill-rewrite` |

Follow-ups the runs exposed:

- **Nothing makes the worker run each phase's skill.** A worker can report `done` having skipped
  super-build. `ak firstmate status done` could refuse unless the binding's required gates each have
  an evidence record; that would make lifecycle fidelity checkable instead of hoped for.
- **A same-user worker can still forge a grant** by running `ak firstmate bind` itself or editing
  the ledger (ADR-0004). The child guard's denial is a tripwire for subagents, not a boundary, and
  the main thread is not hooked. The supervisor can detect it by comparing each grant record's
  `binding_sha256` and `binding` path with the binding it wrote; preventing it needs the runner's
  validated grants (`research/briefs/carried-forward.md`).
- `fm-dod-lib`'s agent-kit DoD asks for `no-mistakes init`, green CI and a PR URL even when the
  binding says dry-run.
- Launch plumbing: `fm-spawn` has no budget option, needs treehouse, and writes trust entries to
  `~/.claude.json`; print mode emits several `result` events when background children continue.
- The super-build eval trigger is unreliable: the skill fired in only some with-plugin runs.
  Its description now names the request ("build ticket T2", "implement AK-214", a worker's
  task-local implementer). Live, `scripts/eval-local.sh --tag firstmate --runs 3`: super-build fired
  in 3 of 3 with-plugin runs of `task-local-child-does-not-ship`, which scored 0.83. The run stopped
  at its $2 cap ($2.69 spent, three runs in flight) before the no-plugin arm and the second case ran,
  so this is a trigger measurement, not a delta. The figure predates two script changes: `fired` then
  also counted with-plugin runs that had no with-only graders, and the script did not print the
  measured commit, so neither the count's rule nor its revision matches what the script reports now.
  `AUTHORING.md` §9 now says the eval sandbox blocks git (grade files, never commits) and documents
  the script.
- Eval sandbox on this machine: any symlink under `~/.docker` blocks Bash-granting evals; they ran
  with `cli-plugins` and `bin` moved out and restored afterwards.

### Lifecycle fidelity, enforced in core (2026-09-24)

Principle: **Firstmate is optional.** Standalone, meaning sessions a person opens, each in its own
worktree, is the default way to run agent-kit, and every lifecycle check lands in core first. The
Firstmate adapter only calls into core. No core command, test or CI job needs Firstmate installed.

The first follow-up above is closed this way:

- `src/lifecycle/gate.ts` (`ak lifecycle open|record|check`, and `bin/ak-gate.mjs` in every bundle that
  carries a super-* skill, run with plain node) defines one gate record format:
  `{run_id, gate, snapshot{repo, revision, diff_hash}, recorded_at}`. The snapshot helpers moved here
  from `src/firstmate/snapshot.ts`. super-build, super-verify and super-review record their gate when
  they pass. super-ship checks first and records `ship-preflight` last. Standalone records default to
  `<git common dir>/agent-kit/evidence/<run>/`, so every worktree of a repository shares them and
  the tree stays clean. The run is the one `open` minted for the branch, else the branch name.
- The check reads "current" per gate. `verify`, `review-delta`, `review-readiness` and `ship-preflight`
  must name the exact head, revision and diff hash. `build-checks` and `review-full` may name an earlier
  revision in the head's history, because a fix loop moves the head after them, but a `review-full` on
  an earlier head counts only with a `review-delta` at this one. For a standalone run named after
  its branch (no `--run` and no opened run), "in the head's history" stops at the fork point: an
  earlier record counts only if its snapshot is not already on the default branch
  (`origin/HEAD`, else `main`, else `master`; ancestor-only when none resolves). A record at the head's
  own revision always counts. Such a run shares its name with any earlier task on the branch, so
  without this a branch reused after a merge would inherit the old run's `build-checks`. Work with
  the default branch itself checked out has no fork point, and stays ancestor-only. The bound's known
  limit after a squash or rebase merge, and the task-bound run `open` mints to close it, are described
  in the header of `src/lifecycle/gate.ts`. An explicit run id, `--run`
  or the binding's `run_id` in the Firstmate audit, is unique to its run and opts out of the bound:
  ancestry alone, so a run the supervisor has since merged still verifies. The pre-ship default checks
  `build-checks, verify, review-full, review-readiness`, since `ship-preflight` does not exist yet
  when super-ship checks.
- `bind` adds `build-checks` to `required_gates`. `ak firstmate status complete` audits before it
  prints `done`: the same core check over the binding's store and gates, against the head the latest
  `ship-preflight` record names, then the grant audit ADR-0004 describes. `status --verify` runs the
  audit alone.
- Replay, with the practice runs restated in the new record format. The runs predate the format, so
  their stores held free-form files; `tests/firstmate/status.test.ts` records exactly the gates each
  run left evidence for. Run 2 (only a dry-run ship) is refused, naming `build-checks`, `verify`,
  `review-full` and `review-readiness`. Run 1 (every phase) passes. A tampered grant record and a
  hand-edited binding are both refused.

## Consequences

- A project opts in per task with `--mode agent-kit`; nothing else on the machine changes.
- Upgrading Firstmate past `a5d78f8` means a new patch directory; preflight refuses the old one.
- `CONTRACT-DEFECTS.md` does not block this batch: its open entry (an `llm` grader with no focus
  scores the last message) constrains how eval cases are graded, and the two added here grade only
  what the response says.
