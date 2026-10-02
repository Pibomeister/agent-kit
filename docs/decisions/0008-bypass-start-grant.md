# ADR-0008 — A supervisor-held bypass grant starts the lifecycle phases for one task

**Status:** Accepted.
**Date:** 2026-10-01.
**Authority:** the captain's request for a bypass mode for agent-kit, and the captain's choice of
start-only scope ("agent-kit: A"), both relayed by Firstmate on 2026-10-01. Amends the source
invocation law's human-only start rule for super-align, super-bound, super-review `full` and
`readiness`, and super-ship. The same-user limit under Consequences was accepted by Firstmate on the
captain's behalf on 2026-10-01, after an independent review of PR #52. Numbered 0008 because ADR-0007 is taken by the runner's standing grant on
its own branch.
**Prior art read:** `policies/invocation.yaml`, ADR-0004 (the binding as grant and its ledger),
ADR-0007 on branch `fm/ak-runner` at `63bf3c3` (the runner's standing grant for autopilot),
`schemas/charter.schema.json`, `src/firstmate/grant.ts`, `src/lifecycle/gate.ts`.

## Context

The global instructions send every engineering work item through the lifecycle, and the invocation
law says only a human starts its user-invoked phases. On 2026-10-01 a Firstmate worker on a
customer-blocking bug (ENG-4151) stopped, correctly, because no human had typed `/ak:super-align`.
The captain then allowed a one-off exception in conversation, and nothing in agent-kit could carry it.

Today a phase starts three ways: a typed command; a Firstmate binding, which covers only review and
ship and needs a patched Firstmate (ADR-0004); or the runner's standing grant, which needs a running
runner and an approved charter (ADR-0007, not merged). None fits a stock Firstmate worker that a
captain wants to run once without typing each command.

## Decision

A bypass grant is a file that stands in for the typed command of five phase starts: `super-align`,
`super-bound`, `super-review:full`, `super-review:readiness` and `super-ship`. A supervisor (Firstmate
or a human) writes it with one line, run by `node` from the bundle with the supervisor's home as the
working directory:

```
cd <supervisor home>
node <agent-kit bundle>/bin/ak-gate.mjs bypass grant --task <id> --by <who authorized it> \
  --reason <why> --out data/<task>/bypass.json --project <repo> --worktree <task worktree> [--hours <n>]
```

`node` loads nothing from the working directory. `bun` loads that directory's `bunfig.toml` preload and
`.env` before the script runs, so running the grant through `bun` from a project directory or a task
worktree would execute worker-written code inside the supervisor's grant; the supervisor never does.
The installed `ak` on `PATH` is the maintenance CLI and has no `lifecycle` subcommand. It prints the brief section the supervisor pastes into the task's
brief, naming that same script. Before each phase the worker runs `node <agent-kit bundle>/bin/ak-gate.mjs
bypass check --grant <file> --task <id> --phase <phase>`. Exit 0 is the start and leaves a use record under
`<evidence>/<run>/bypass/`. A refusal is a stop with `needs-decision`. When the worker records
`review-full`, `review-readiness` or `ship-preflight` it passes `--bypass <file> --task <id>`, and the
gate record carries `authority: {mode: "bypass", grant_id, grant, grant_sha256, authorized_by,
task_id, worktree}`. The attribution is never silently dropped once used: a typed record of a phase
that has a use record in the run carries `authority: {mode: explicit, superseded_grant_id}` and ends
the bypass for that phase (see *A started phase* below), and a snapshot recorded by hand cannot be
re-recorded with `--bypass`. `--bypass` on a gate no bypass phase records (`build-checks`, `verify`,
`review-delta`) is refused.

**Start only.** The grant starts phases and nothing else. Every approval inside a phase still stops
with `needs-decision` for the supervisor who holds the grant: super-align's explicit yes, super-bound's
specification and ticket approvals, and any remote effect of super-ship. The worker never approves its
own design, specification, tickets or publish. `bypass check` refuses any name that is not one of the
five phases, approval categories, merge, deploy and `autopilot` among them. A bypassed phase runs as
its explicit form, as if the command had been typed; it is not the delegated form and it does not
make worker-written evidence trusted.

**Trust.** The same model as ADR-0004 and the runner's standing grant: authority comes from an
artifact outside the worker's write scope, bound by hash. `grant` refuses to run from inside any
worktree or the git directory of the repository it grants, or from under a Firstmate home's
`projects/`, and refuses to write into any worktree or the git directory. It registers the file's real
path and sha256 in a ledger under the account's home directory (`~/.agent-kit/bypass/`, from the
account record, not `HOME`), and the grant and its ledger entry record who issued it: the issuing
process's working directory, the host and the Firstmate home `--out` lies in. `check` opens the grant
once and judges those bytes only: the file it opened must be the registered one (same device and
inode), and the bytes it parses must hash to the registered sha256, so swapping the path mid-check
cannot pair forged fields with a genuine hash. It refuses a file that is missing, malformed,
unregistered, copied, edited, inside any worktree or the git directory, for another repository, or
past `expires_at`, which defaults to 24 hours and is capped at 168.

**One task.** `check` and `record --bypass` take the task id from the brief as `--task`, never
from the grant file, and refuse unless it equals the grant's `task_id`. `grant` records the task's
own worktree, which must be one of the repository's, and `check` and `record --bypass` compare it with the worktree of
the directory they run from, never with a flag: `--project` must name that same worktree, so another
task's worktree is refused even with the right `--task` and `--project` naming the granted one. The grant is
not bound to a run: the lifecycle opens new runs after align, so any run under the task may use it.
A check without `--phase` writes nothing.

**A started phase.** A phase check, or a gate recorded with `--bypass`, writes the run's use record
for that phase under `<evidence>/<run>/bypass/`, and that record is the one place the start lives.
An expired grant cannot finish the phase. Two things continue it. A fresh grant that passes the
check in full, for the same task and worktree as the grant that started the phase, records with its
own attribution plus `superseded_grant_id` naming the grant it replaces. A typed record without
`--bypass` records `authority: {mode: explicit, superseded_grant_id}` naming the grant in force, so
a human finish after a bypassed start is visible rather than a silent strip, and it marks the use
record ended (`ended_at`, `ended_by_snapshot`, and in `ended_grant_ids` every grant that has held
the phase in the run, which the use record keeps in `held_grant_ids`). The end holds for the whole
task, not only that run: `check` and `record --bypass` derive the task's ended set each time from
every run's use record for the phase in the evidence store, so a run opened after a fix
(`open --ticket`) cannot resume bypass for that phase with an ended grant. A typed record in a run
that never checked the phase still ends the grant that held it in an earlier run from the same
worktree. Nothing in this is written to the ledger: the worker never writes `~/.agent-kit`, so a
ledger the host keeps read-only to the worker does not stop a typed end. **Trust:** the use records
live in the evidence store under the git common directory, which the worker can write, so a worker
that deletes or edits them can lift an end, exactly as with the run-level end. The task-wide end
guards against accidents, not against a determined worker.
Every grant a typed record ended stays refused at `check` and at `record --bypass` for that phase of
the task, even after a re-start; only a fresh grant for the same task re-starts the phase, rewriting
the use record with `superseded_grant_id`. A grant for another task or another worktree is
refused. The mirror holds too: a gate recorded by hand at a snapshot cannot be relabelled by
re-recording that snapshot with `--bypass`, even after a check starts the phase under a grant.

## Consequences

- A captain-authorized task runs align through ship without a human typing a command, and its
  approvals reach the supervisor as `needs-decision` lines instead of being skipped.
- Without a grant nothing changes: every phase stops at its authority step as before.
- **The same-user limit, accepted.** A worker runs as the same OS user as the supervisor, so it can
  run `grant` from a directory outside the repository, or write the ledger, and get a grant `check`
  accepts. On a single-user install the refusals guard against accidents and shortcuts, not against
  a determined worker. The issuer fields make a self-issued grant visible to an audit that compares
  them with where the supervisor issues from; a worker can forge them too. Firstmate accepted this
  limit on the captain's behalf on 2026-10-01, as the runner's admin-token ruling did. The follow-up
  is an issuer outside the worker's account: the runner, or a separate uid.
- Revoking a grant is deleting its file; `check` then refuses.
- When the runner lands, a bypass grant can become a runner-issued grant with the same fields. Records
  citing it stay readable because the attribution names the grant by hash.
- Reverting is deleting the bypass section of `src/lifecycle/gate.ts`, its tests, the bypass
  paragraphs in the four skills, `policies/invocation.yaml` `bypass`, and marking this ADR superseded.
