# adapters/firstmate — for the supervisor

What agent-kit offers a Firstmate home, in the order a supervisor meets it. Load a skill's own file
only when the task in front of you needs it; this index is enough to route.

## Before the first task

| Step | Command | What it proves |
|---|---|---|
| Build the full bundle | `ak build --profile all` | Both host bundles contain autopilot and the lifecycle |
| Stock preflight | `ak firstmate preflight --fm-home <home> --project <repo>` | Normal brief and spawn commands, checkout, host and bundle; no patch, pin or no-mistakes auto-fix policy required |
| Start the runner | `ak runner serve --socket <private> --state-dir <private> --worker-root <task-worktree> --run-id <id> ...` | Private charter, standing grant, evidence and separately dispatched seats are checked at run time |

Use `adapters/runner-contract/CLI.md` for the request and private configuration shapes.

The stock preflight reports guided mode without a runner socket. A socket is a candidate, not a
grant: `start` must validate the standing grant in a captain-approved charter and the worker's
first autopilot step must read that attestation. The runner's state and evidence are outside the
worker worktree and Git common directory.

## Per task

Use `ak firstmate brief` to render an Agent Kit section into a normal Firstmate brief. Spawn the
task with its existing `--mode no-mistakes`, `direct-PR` or `local-only`. Firstmate's own status,
inbox, recovery and merge policy remain authoritative. Dispatch both supervisor seats as separate
ordinary crewmates, never as children of the implementing worker, and submit their judgments to
the runner. A seat launcher may automate that dispatch through stock Firstmate commands.

For each frozen card, obtain a peer-free packet with `ak runner call packet`, then call
`ak firstmate seat-launch` once for each seat. It uses stock `fm-brief.sh --scout` and
`fm-spawn.sh --scout`. After each seat's report arrives, call `ak firstmate seat-judge`; it checks
the scout task record and submits the bounded verdict under the supervisor token. Keep that token
in a mode-0600 file outside this home, the worktree and any git checkout (default
`~/.config/agent-kit/runner/<run>/admin.token`) and never name its path in a brief; on a same-user
install this guards against accidents, not against a deliberately adversarial worker. Steer the
implementer to `decide` after both judgments are recorded. Request shapes are in
`adapters/runner-contract/CLI.md`.
`seat-judge` writes its runner request beside that private token, not in the scout's writable
`data/<task>/` directory.

No-mistakes auto-fix values need not be zero. If the pipeline changes the head, the runner
invalidates prior verification and review evidence; sync, verify and review again before done.

## Who owns what

| You (Firstmate) | The worker (agent-kit) | no-mistakes |
|---|---|---|
| Intake, dispatch, worktree, steering, recovery, PR watch, merge where yolo allows it, teardown | Scout, build, verify, review, fixes, delta review, the fix-cycle cap, the ship decision | Re-running test and lint on the shipped head, push, pull request, CI |

The runner decides checkpoints from two independent supervisor judgments and charter evidence.
The implementer does not review its own patch. A missing seat, a failed seat launcher or disagreement is one
escalation through Firstmate's normal needs-decision protocol; relay the human's ruling with
`ak runner call answer`, which settles that card with the chosen option. Only the card's approving
option advances the run; any other choice keeps it at that stage, opens nothing, and sends the worker
back to prepare a revised card. After a human's non-approving answer, every later card for that
operation escalates to a human again until one approves. The runner always offers `no` as a refusal
even when the worker's card omitted it, and a human `retry` also keeps the human gate. A supervisor
may call `ak runner call cancel` with actor and rationale before completion; the ledger records
who stopped the run, why and when. It does not undo an already confirmed effect or reconcile a
performed effect still awaiting read-back. `adapters/runner-contract/CLI.md` owns
the full `answer` rules.

## Legacy patched binding

The commands below document existing patched-home installations. Stock Firstmate does not call
`ak firstmate bind`, `install` or `grant`, and does not add an `agent-kit` delivery mode.

## What your binding grants

The binding is your grant to the worker for `review.full`, `review.readiness` and `ship.prepare`
(CONTRACT.md §6). The worker checks it with `ak firstmate grant` before each and cites the record.
When the check refuses, the worker stops and sends `needs-decision`: decide it yourself or ask the
captain. Merge is never on the binding and stays yours.

The binding remains the grant for the three operations in this adapter. For a charter-bound
autopilot run, start the separate `ak runner` service with the charter, private state, two seat
launchers and verification command before handing its worker token and socket to the crewmate.
Without that live service, autonomous ship stops with trusted evidence unavailable.

## Granting bypass for one task

When the captain authorizes a task to run without typed phase commands, write a bypass grant with the
installed agent-kit bundle's gate script, run by `node` from the home, and paste the section it prints
into the brief:

```
cd <home>
node <agent-kit bundle>/bin/ak-gate.mjs bypass grant --task <task-id> --by <who authorized it> \
  --reason <why> --out data/<task-id>/bypass.json --project <repo> --worktree <task worktree> [--hours <n>]
```

**One grant per run, issued automatically.** A grant is valid only in the lifecycle run it is first
used in, and every new run needs one: super-build's `open --ticket` starts a run per ticket, and a ship
after the head moves past a closed run starts another. Expect one fresh grant per run. When a worker reports `needs-decision` because its check was refused as "first used in run …",
issue a fresh grant with the same command, task and worktree, under a new `--out` (for example
`data/<task-id>/bypass-<n>.json`), and send the worker the section it prints. That is not a new
authorization: the captain's bypass for the task already covers it, so do not ask the captain again.
Do not reissue for any other refusal; an expired grant, a wrong task or worktree, an edited file or an
approval card are still decisions.

`<agent-kit bundle>` is the installed plugin's directory, or `dist/claude-code` after `ak build`. Run it
with `node` and with the home as the working directory, never through `bun` and never from a project
directory or a task worktree: `bun` loads the working directory's `bunfig.toml` and `.env` before the
script runs, so a worker-written file there would run inside your grant. The `ak` command on `PATH` is
the maintenance CLI and has no `lifecycle` subcommand.

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
