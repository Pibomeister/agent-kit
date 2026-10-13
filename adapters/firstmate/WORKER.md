# agent-kit binding (legacy patched mode)

This task runs the agent-kit lifecycle inside a Firstmate worker. Firstmate supervises; you judge the
work with the lifecycle; no-mistakes delivers it. Stock Firstmate uses the normal brief section
from `ak firstmate brief` instead. `ak firstmate bind` rendered this legacy section from
`adapters/firstmate/WORKER.md`, and every value in it is also in the binding file, which you can read
and cannot write.

| | |
|---|---|
| Task | `{{task_id}}` |
| Run | `{{run_id}}` |
| Binding | `{{binding_path}}` |
| Project | `{{project_path}}` |
| Starts from | revision `{{revision}}`, working-tree diff `{{diff_hash}}` |
| Skill bundle | agent-kit `{{bundle_version}}` for `{{host}}`, pinned at `{{bundle_path}}` (`{{bundle_hash}}`) |
| Charter | {{charter}} |
| Required gates | {{gates}} |
| Evidence | {{evidence}} |
| Delivery | `{{action}}` through no-mistakes. Never merge |

## What you were asked

The request is in `{{brief_path}}`. Two inputs there stay separate. The captain's intent is what the
person asked for, in their words; it is the only thing that feeds no-mistakes `--intent`. Firstmate's
spec is how the supervisor framed the task; it shapes the work and is never passed as intent. Record the
brief's hash on your first receipt.

## How you work

Read skills from the pinned bundle and nowhere else. Run the lifecycle in order and let each skill's own
gates decide when it is done: scout and bound the task, align on the plan, build, verify, review with
the full panel, fix, verify again, review the fix with `super-review delta`, and ship with `super-ship`.

A receipt or a verdict is evidence only for the revision and diff hash it names. When either moves, it
is stale and the gate runs again. The fix-cycle cap is the lifecycle's; at the cap you stop and report,
you do not start another cycle.

Before implementation, super-build opens your lifecycle run from your worktree with
`{{gate_cmd}} open --ticket <ticket-file> --binding {{binding_path}} --dir {{evidence_dir}}`. The run
record names this binding, so the gate finds the grants below and the audit finds the run. Every later
gate command passes `--dir {{evidence_dir}}` and no `--run`: it resolves the opened run from your
branch.

Each phase leaves a gate record when its own gates pass. Record it with
`{{gate_cmd}} record --dir {{evidence_dir}} --gate <gate>`: `build-checks` after
super-build, `verify` after super-verify, `review-full`, `review-delta` and `review-readiness` after
the matching super-review mode, and `ship-preflight` after super-ship's preconditions hold. Before it
ships, super-ship runs `{{gate_cmd}} check --dir {{evidence_dir}}`; a refusal names
the phase you skipped or whose evidence went stale, and you go back and run it. Skipping a phase is
not a shortcut: `done` is refused without its record.

## Your children

"Do the work yourself" means you keep the assignment. You may start task-local helpers inside this task
within the envelope in `adapters/firstmate/CHILD-ROLES.md`:

- At most {{max_children}} children, {{max_concurrent}} at a time, depth 1. A child never starts a child.
- Roles: {{roles}}.
- Each child gets a subset of your scope, writes only to its artifact destination, and is charged to
  run `{{run_id}}`.
- A child never pushes, merges, opens a pull request, runs `fm-*` or no-mistakes, starts an agent, or
  contacts a person. On Claude Code a hook enforces that; on any other harness it is only this rule.
- Your children are never the independent judges a supervisor arranges. Those are separate agents
  that Firstmate dispatches.

You own every child's outcome. If you cannot say what a child did, you are not done.

## Your authority

Firstmate is your delegated controller, and this binding is the grant it gives you. Before
`super-review full`, `super-review readiness` and `super-ship`, run
`ak firstmate grant --binding {{binding_path}} --operation review.full|review.readiness|ship.prepare`.
Exit 0 prints a grant record; cite it on the review or the ship record. A refusal means stop and report
`needs-decision`. Nothing outside the binding is granted, merge included.

The binding grant alone does not carry autonomous ship through. If Firstmate supplied a live runner
socket and worker token, use its current ledger and runner-collected verification evidence. Otherwise
step 7 of `super-ship` stops with `needs-input` naming trusted evidence as unavailable; report that
stop rather than shipping.

## How you ship

`super-ship` is the only thing that publishes, and it publishes through no-mistakes with review,
document and rebase skipped. A parked gate is a finding against your head: fix it through the
lifecycle and ship again, and the new push supersedes the parked run. Never answer a parked gate
inside the pipeline. With a `dry-run` delivery nothing is pushed and no pull request is opened.

## How you report

Append one line to your status file, printed by
`ak firstmate status {{binding_path}} <outcome> …`. `complete` is audited first: every required gate
needs a record current for the head your ship-preflight record names, and every grant record must name
this binding with the hash the ledger registered. A refusal prints why and `needs-decision`; nothing is
appended. For example, a complete dry run with evidence refs
`r1,v1` prints `done [at=<epoch>]: dry-run ship prepared, nothing published evidence=r1,v1`. A child in
an unknown state is reported as `blocked`, whatever else is true. Write nothing else into Firstmate's
files, and do not edit this brief.
