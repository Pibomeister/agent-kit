# ADR-0008 — A supervisor-held bypass grant starts the lifecycle phases for one task

**Status:** Accepted.
**Date:** 2026-10-01. Amended 2026-10-06: a grant holds in each run of its task while that run is its
branch's current run, for at most 12 hours (see **Every run of the task**).
**Authority:** the captain's request for a bypass mode for agent-kit, and the captain's choice of
start-only scope ("agent-kit: A"), both relayed by Firstmate on 2026-10-01. Amends the source
invocation law's human-only start rule for super-align, super-bound, super-review `full` and
`readiness`, and super-ship. The same-user limit under Consequences was accepted by Firstmate on the
captain's behalf on 2026-10-01, after an independent review of PR #52. The 2026-10-06 amendment is
the captain's decision, relayed by Firstmate, reversing the run binding chosen on 2026-10-02.
Numbered 0008 because ADR-0007 is taken by the runner's standing grant on
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
  --reason <why> --out data/<task>/bypass.json --project <repo> --worktree <task worktree> --hours 12
```

`node` loads nothing from the working directory. `bun` loads that directory's `bunfig.toml` preload and
`.env` before the script runs, so running the grant through `bun` from a project directory or a task
worktree would execute worker-written code inside the supervisor's grant; the supervisor never does.
The installed `ak` on `PATH` is the maintenance CLI and has no `lifecycle` subcommand. The grant
command prints the brief section the supervisor pastes into the task's brief, naming that same script. Before each phase the worker runs `node <agent-kit bundle>/bin/ak-gate.mjs
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
past `expires_at`, which defaults to 12 hours and is capped at 12. `grant` refuses `--hours` above 12,
and `check` refuses any grant whose `expires_at` is more than 12 hours after its `created_at`, so a
grant issued under the earlier 168-hour cap is refused rather than carried across runs.

**One task.** `check` and `record --bypass` take the task id from the brief as `--task`, never
from the grant file, and refuse unless it equals the grant's `task_id`. `grant` records the task's
own worktree, which must be one of the repository's, and `check` and `record --bypass` compare it with the worktree of
the directory they run from, never with a flag: `--project` must name that same worktree, so another
task's worktree is refused even with the right `--task` and `--project` naming the granted one.
A check without `--phase` writes nothing.

**Every run of the task.** A grant holds in each lifecycle run of its task while that run is its
branch's current run, from its worktree, until it expires or its file is deleted. The lifecycle
opens a new run when super-build runs `open --ticket`, and a ship after the head moves past a closed
run needs another, opened the same way; the same grant starts the phases in each. The current run is
the one the lifecycle resolves without `--run`: the run `open` last recorded for the branch the
check runs on, or before any such run the branch-named one. A branch-named id is lossy (`feat/x` and
`feat-x` share `feat-x`, and a case-insensitive store folds `FEAT-X` into it), so it is refused when
another branch opened a run under it or another local branch shares it, case aside, and when the
branches cannot be listed; such a branch opens a run with `open --ticket` first. `check` and `record
--bypass` refuse every other run: an earlier run of the branch, another branch's run, or a run id
the worker makes up. Three cases still reach a run another task made. A branch reused for a new task
keeps its earlier task's run current until `open --ticket` opens the new one, a branch-named run
whose branch was deleted is no longer seen as shared, and a worker that checks out another task's
branch reaches that task's run. The binding guards against accidents, not a determined worker, like
the rest of this section. `--run .` and `--run ..` are refused as run ids, since they would put a
run's records at or above the store root.

*Amendment, 2026-10-06.* From 2026-10-02 until this amendment a grant was valid only in the run it was
first used in, claimed by an exclusive create of `<store>/grant-runs/<grant>.json`, and every later run
took a fresh grant. The captain had chosen that over carrying a grant across runs because five review
rounds kept finding a path where an old grant resumed. The captain reported that it stalled workers
instead: on 2026-10-06 workers stopped three times for a fresh grant by hand (eng-4175 once,
eng-4176 twice). The captain reversed it on 2026-10-06: delete the run claim, keep the typed end per
run and phase, and shorten a grant's life to a 12-hour default and a 12-hour maximum. The 12-hour
cap now bounds how long one grant is good across runs, in place of the run claim, and the task,
repository and worktree checks are unchanged. Review of the amendment found that without the claim a
grant could start a phase in another task's run by naming it with `--run`; the captain chose, on
2026-10-06, to bind the run to the branch instead of adding new state, which review then narrowed to
the branch's current run.

**A started phase.** A phase check, or a gate recorded with `--bypass`, writes the run's use record
for that phase under `<evidence>/<run>/bypass/`, and that record is the one place the start lives.
An expired grant cannot finish the phase. Two things continue it. A fresh grant that passes the
check in full, for the same task and worktree as the grant that started the phase, records with its
own attribution plus `superseded_grant_id` naming the grant it replaces. A typed record without
`--bypass` records `authority: {mode: explicit, superseded_grant_id}` naming the grant in force, so
a human finish after a bypassed start is visible rather than a silent strip, and it marks the use
record ended (`ended_at`, `ended_by_snapshot`, and in `ended_grant_ids` every grant that has held
the phase in the run, which the use record keeps in `held_grant_ids`). The bypass is then over for that
phase in that run: every grant it ended is refused at `check` and at `record --bypass` there, even
after a re-start, and only a fresh grant for the same task re-starts the phase, rewriting the use
record with `superseded_grant_id`. The end is per run: a later run is a fresh start, and the same
grant starts the phase there. Only the branch's current run accepts the grant, and a new current run
comes only from `open --ticket`, so restarting a phase a typed record ended takes a run opened that
way; the captain accepted this with the amendment, and the use records of both runs show it. A grant for
another task or another worktree is refused. The mirror holds too: a gate recorded by hand at a
snapshot cannot be relabelled by
re-recording that snapshot with `--bypass`, even after a check starts the phase under a grant.
`--dir` is refused with a bypass grant, at `check` and at `record --bypass`, so the use records and
typed ends a supervisor audits stay in the default evidence store. Nothing in this is written to
the ledger: the worker never
writes `~/.agent-kit`. **Trust:** the use records live in the evidence store under the git common
directory, which the worker can write, so a worker that deletes or edits them can lift an end. It
guards against accidents, not against a determined worker. A typed record and a
`bypass check` of the same phase in the same run at the same moment are not serialized; the check
refuses when it sees the end appear while it ran, which narrows that window without closing it.

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
