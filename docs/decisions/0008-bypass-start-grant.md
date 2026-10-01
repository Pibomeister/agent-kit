# ADR-0008 — A supervisor-held bypass grant starts the lifecycle phases for one task

**Status:** Accepted.
**Date:** 2026-10-01.
**Authority:** the captain's request for a bypass mode for agent-kit, and the captain's choice of
start-only scope ("agent-kit: A"), both relayed by Firstmate on 2026-10-01. Amends the source
invocation law's human-only start rule for super-align, super-bound, super-review `full` and
`readiness`, and super-ship. Numbered 0008 because ADR-0007 is taken by the runner's standing grant on
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
or a human) writes it with one line, from outside the repository:

```
ak lifecycle bypass grant --task <id> --by <who authorized it> --reason <why> \
  --out <supervisor home>/data/<task>/bypass.json --project <repo> [--hours <n>]
```

It prints the brief section the supervisor pastes into the task's brief. Before each phase the worker
runs `ak lifecycle bypass check --grant <file> --task <id> --phase <phase>` (or the bundle's
`bin/ak-gate.mjs bypass check`). Exit 0 is the start and leaves a use record under
`<evidence>/<run>/bypass/`. A refusal is a stop with `needs-decision`. When the worker records
`review-full`, `review-readiness` or `ship-preflight` it passes `--bypass <file> --task <id>`, and the gate record
carries `authority: {mode: "bypass", grant_id, grant, grant_sha256, authorized_by, task_id}`.

**Start only.** The grant starts phases and nothing else. Every approval inside a phase still stops
with `needs-decision` for the supervisor who holds the grant: super-align's explicit yes, super-bound's
specification and ticket approvals, and any remote effect of super-ship. The worker never approves its
own design, specification, tickets or publish. `bypass check` refuses any name that is not one of the
five phases, approval categories, merge, deploy and `autopilot` among them. A bypassed phase runs as
its explicit form, as if the command had been typed; it is not the delegated form and it does not
make worker-written evidence trusted.

**Trust.** The same model as ADR-0004 and the runner's standing grant: authority comes from an
artifact outside the worker's write scope, bound by hash. `grant` refuses to run from a checkout of
the repository it grants and refuses to write into any of its worktrees or its git directory. It
registers the file's real path and sha256 in a ledger under the account's home directory
(`~/.agent-kit/bypass/`, from the account record, not `HOME`). `check` refuses a file that is
missing, malformed, unregistered, copied, edited, inside any worktree or the git directory, for
another repository, or past `expires_at`, which defaults to 24 hours and is capped at 168.

**One task, one run.** `check` and `record --bypass` take the task id from the brief as `--task`,
never from the grant file, and refuse unless it equals the grant's `task_id`. The first successful
use writes its run id into the grant's ledger entry, and every later use from another run is refused.

## Consequences

- A captain-authorized task runs align through ship without a human typing a command, and its
  approvals reach the supervisor as `needs-decision` lines instead of being skipped.
- Without a grant nothing changes: every phase stops at its authority step as before.
- The limit: a same-user process that runs `grant` from outside the repository, or edits the ledger,
  still produces a grant `check` accepts. The refusals above stop a worker that writes a grant inside
  its worktree or runs `grant` from it, which is the mistake or shortcut a worker is likely to try,
  but they are not a security boundary. Preventing a deliberate same-user forgery needs host write
  isolation or a grant issuer outside the worker's account, which is what the runner provides.
- Revoking a grant is deleting its file; `check` then refuses.
- When the runner lands, a bypass grant can become a runner-issued grant with the same fields. Records
  citing it stay readable because the attribution names the grant by hash.
- Reverting is deleting the bypass section of `src/lifecycle/gate.ts`, its tests, the bypass
  paragraphs in the four skills, `policies/invocation.yaml` `bypass`, and marking this ADR superseded.
