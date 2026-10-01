# adapters/firstmate — for the supervisor

What agent-kit offers a Firstmate home, in the order a supervisor meets it. Load a skill's own file
only when the task in front of you needs it; this index is enough to route.

## Before the first task

| Step | Command | What it proves |
|---|---|---|
| Apply patches 0001 then 0002 | A maintainer, by hand, to a clone at `a5d78f8` | Nothing in `ak` applies them |
| Preflight | `ak firstmate preflight --fm-home <home> --project <repo>` | Upstream commit, both patches applied in order, host capabilities, the pinned bundle's contents, the project's no-mistakes `auto_fix` values, the evidence store |
| Install | `ak firstmate install --fm-home <home>` | Writes `config/agent-kit.env`, `config/agent-kit/worker-settings.json` and, with `--evidence`, `config/agent-kit/evidence.env`; nothing else |

Preflight fails closed. With no knowledgebase configured, a home can only run in dry-run against a
labeled mock evidence store (`--evidence mock --evidence-location <dir>`).

## Per task

Brief the task with `--mode agent-kit`. The patched fm-brief calls `ak firstmate bind`, which writes
the binding into `data/<task-id>/` and returns the section it inserts into the brief. Spawn, relaunch
and promote carry the same contract, because all three read it from `fm_dod_block`.

## Who owns what

| You (Firstmate) | The worker (agent-kit) | no-mistakes |
|---|---|---|
| Intake, dispatch, worktree, steering, recovery, PR watch, merge where yolo allows it, teardown | Scout, build, verify, review, fixes, delta review, the fix-cycle cap, the ship decision | Re-running test and lint on the shipped head, push, pull request, CI |

Review judgment is the worker's alone. Do not add a reviewer to an `agent-kit` task, and do not answer
one of its parked no-mistakes gates yourself: the worker fixes the problem through its lifecycle and
ships again.

When a checkpoint needs two independent judgments, dispatch them as separate agents. Never ask the
worker's own helpers.

## What your binding grants

The binding is your grant to the worker for `review.full`, `review.readiness` and `ship.prepare`
(CONTRACT.md §6). The worker checks it with `ak firstmate grant` before each and cites the record.
When the check refuses, the worker stops and sends `needs-decision`: decide it yourself or ask the
captain. Merge is never on the binding and stays yours.

The binding is still the grant for `ship.prepare`, but on this host a delegated ship ends in a
`needs-input` stop naming trusted evidence as unavailable, not a `done … PR <url>` line, until a
runner supplies trusted evidence.

## Granting bypass for one task

When the captain authorizes a task to run without typed phase commands, write a bypass grant from
the home, not from the task's worktree, and paste the section it prints into the brief:

```
ak lifecycle bypass grant --task <task-id> --by <who authorized it> --reason <why> \
  --out data/<task-id>/bypass.json --project <repo> --worktree <task worktree> [--hours <n>]
```

The section tells the worker to pass `--task <task-id>` to every check and to `record --bypass`;
a check for another task, or run from any worktree but the task's, is refused. Issue it from the
home itself: `grant` refuses from inside a task checkout or `projects/`, and records where it ran so
an audit can spot a grant you did not issue. It cannot stop a same-user worker issuing one from
elsewhere; ADR-0008 records that limit as accepted.
It starts super-align, super-bound, super-review full and readiness, and super-ship for that task
only, until it expires (24 hours by default). It starts phases only: the worker still sends you
`needs-decision` for every approval inside them — the design yes, the specification and ticket
approvals, and every push, pull request or publish — and you answer each one. It never covers merge
or deploy. Delete the file to revoke it. ADR-0008 has the design and its trust limit.

## What the worker sends back

One status line at a time (CONTRACT.md §4):

| Line | Meaning |
|---|---|
| `done … PR <url> checks green evidence=…` | Shipped; the evidence refs are the receipts and the review it rested on |
| `done … dry-run ship prepared, nothing published evidence=…` | A dry run; nothing left the machine |
| `needs-decision …` | A decision only you or the captain can make, including the fix-cycle cap |
| `blocked … child <id> state unknown` | The worker cannot account for a helper and is keeping the task |
| `failed …` | Failed, or cancelled, with who cancelled it |

## Skills a supervisor may want

| Need | Skill |
|---|---|
| Handle one delivered PR event without starting a watcher | `babysit-pr`, managed mode |
| Assess one delivered batch of review feedback | `receiving-review`, managed mode |
| Understand what the worker's review did | `super-review`, and its lane report |
| Understand what shipping did | `super-ship` and `skills/super-ship/references/transport-no-mistakes.md` |
