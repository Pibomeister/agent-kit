# ADR-0004 — Under Firstmate, the binding is the delegated grant

**Status:** Accepted.
**Date:** 2026-09-24.
**Authority:** the maintainer's decision, 2026-09-24 ("Firstmate acts as the person"). Amends the
consequence in ADR-0003 that a Firstmate binding is not a grant, and the "Runner" row of ADR-0002's
unbuilt-work table, for Firstmate only.
**Prior art read:** `skills/super-review/SKILL.md` and `skills/super-ship/SKILL.md` (Authority),
ruling `entrypoint-phase-operation-split`, `adapters/firstmate/CONTRACT.md` §5,
`schemas/firstmate-binding.schema.json`, `src/firstmate/{bind,pin,schema}.ts`.

## Context

super-review `full` and `readiness` and super-ship are authority `explicit-or-delegated`, invocation
U. A human starts them, or a delegated controller starts the same protocol through `review.full`,
`review.readiness` or `ship.prepare` under a runner-validated grant. Where the host cannot validate a
grant, the entrypoint stops for explicit invocation.

There is no runner. So a Firstmate worker in delivery mode `agent-kit` reaches the authority step of
every full review, every readiness review and every ship, and stops. Firstmate then has to invoke the
phase by hand each time, although it already decided all of that when it bound the task: the binding
names the gates the worker must pass and the delivery it may perform, and it lives in the Firstmate
home's `data/<task-id>/`, outside anything the worker can write.

## Decision

Firstmate is the delegated controller, and its binding is the grant.

`ak firstmate grant --binding <path> --operation <op> [--cwd <dir>]` is the validator. It is
non-interactive. It exits 0 and prints a grant record (`operation`, `binding`, `binding_sha256`,
`task_id`, `run_id`, `granted_by: "firstmate-binding"`) only when all of these hold:

- the binding exists, parses and validates against `schemas/firstmate-binding.schema.json`;
- the binding is the one `ak firstmate bind` registered, unmodified: agent-kit's ledger at
  `~/.agent-kit/firstmate/bindings/<run_id>.json` (the account's home directory, not `$HOME`) holds a
  record for the binding's `run_id` whose `binding_path` is the binding's real path and whose
  `binding_sha256` is its current hash;
- the binding is outside the git worktree of `--cwd` (default the working directory) and outside the
  bound project and workspace, so the worker cannot have written it;
- the operation is on the slip: `review.full` needs gate `review-full`, `review.readiness` needs
  `review-readiness`, and `ship.prepare` needs `ship-preflight`. The grant authorizes the binding's
  `delivery.action` and never a merge;
- the pinned bundle the binding names still exists and hashes to the bound hash.

Otherwise it exits 1 with a one-line reason and a `needs-decision` hint. The worker stops, reports
`needs-decision` to Firstmate, and Firstmate decides or asks the captain. Any other operation, merge
and scope changes included, is refused.

The skills state the grant in the Authority section; `adapters/firstmate/CONTRACT.md` §6 carries the
table. super-ship's Authority section states the further limit the amendment below records.

## Consequences

- A bound worker runs full review and readiness review without a hand invocation per phase, and
  every such run cites the grant record it ran under. The autonomous form of `ship.prepare` stops
  without trusted evidence, as the amendment of 2026-09-30 states.
- The grant is only as strong as the binding's location. A harness that lets the worker write the
  Firstmate home defeats it, the same limit CONTRACT.md §5 already records for the binding itself.
  The record's `binding_sha256` lets a reviewer see the binding did not change between grants.
  The ledger rejects a copy or a fabricated home, because its path is not the registered one, and
  an edit in place, because its hash no longer matches. It does not stop a same-user worker from
  running bind itself or editing the ledger, which the brief forbids. `hooks/child-guard.sh` denies
  a subagent's `ak firstmate bind`, `install` or `remove` and any command or write naming the
  ledger, but it is a token-matching tripwire for a helper's accidental or naive call, not a
  security boundary: shell indirection gets past it, and the main-thread worker is not hooked for
  these at all. Detection is a real check now: each successful grant writes a grant record into the
  binding's evidence store, and `ak firstmate status complete` (or `status --verify`) refuses the run
  unless every grant record's `binding_sha256` and `binding` path match the ledger entry and the
  binding still hashes to it (`src/firstmate/audit.ts`, CONTRACT.md §4). A worker that re-binds or
  edits the ledger and the grant records consistently still passes; preventing that needs a grant
  issuer outside the worker's reach: the unbuilt runner's validated grants
  (`research/briefs/carried-forward.md`).
- The binding carries no signature. Firstmate can change it by binding again, which re-registers
  it; that is intended, since Firstmate is the controller.
- Outside Firstmate nothing changes. A host with no binding still stops for explicit invocation.
- **A real runner replaces this.** When runner-validated grants exist, `ak firstmate grant` becomes a
  thin caller of the runner's validator, or is retired and the binding feeds the runner instead. The
  record's fields are the ones a runner grant would need, so evidence citing it stays readable.
- **Reverting** is deleting `src/firstmate/grant.ts` and its `grant` case in `src/firstmate/cli.ts`,
  the paragraph in each skill's Authority section, `CONTRACT.md` §6, the authority sections of
  `WORKER.md` and `SUPERVISOR.md`, and marking this ADR superseded. Workers then stop at the authority
  step again, as ADR-0003 describes.

**Amendment, 2026-09-30.** The grant remains the authorization record, but it no longer suffices for
the autonomous form of `ship.prepare`. That form also requires the `trusted-evidence` capability,
which this host does not provide.
