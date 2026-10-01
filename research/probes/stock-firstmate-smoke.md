# Stock Firstmate live smoke handoff

The runner test in `tests/runner/runner.test.ts` drives a charter-approved toy run through the
live CLI and records its checkpoint ledger in `runner-toy-transcript.md`. With
`AK_RUNNER_STOCK_FM_HOME` set to the actual unmodified Firstmate home, it also checks stock
preflight against a live task runner socket. Its seat commands are toy processes, so this is not
yet evidence that Firstmate dispatched crewmate seats.

The remaining smoke belongs to the **Firstmate supervisor**, not to an implementing crewmate. Use
stock Firstmate's ordinary brief, spawn, status and inbox commands:

1. Create a scratch Git project and a toy charter outside its worker worktree. Include a
   `standing_grants` entry for `autopilot.start` and a human approval bound to the active charter
   hash. Keep its remote effect local to a toy read-back target; publish nothing to a production
   repository.
2. Build Agent Kit with `ak build --profile all`. Run `ak firstmate preflight` against this
   unmodified home and the scratch project. Do not apply 0001/0002, change Firstmate's default
   branch or require no-mistakes `auto_fix` to be zero.
3. Scaffold a normal local-only crewmate brief with `fm-brief.sh`, add the section from
   `ak firstmate brief`, and spawn with `fm-spawn.sh --mode local-only --yolo off`. A task-scoped
   `ak runner serve` process holds the charter, tokens, seat and effect configurations, state and evidence outside the task
   worktree and its shared Git common directory. Pass only its worker token and socket to the
   crewmate.
4. For a frozen checkpoint, dispatch two separate Firstmate crewmates under ordinary briefs.
   Keep their inputs separate. Firstmate submits their distinct task identities, lineages and
   judgments through the runner's supervisor-token `judge` calls, then steers the implementing
   crewmate to `decide`. Repeat through align, bound, build, verify, review and ship. The toy PR
   target is a local read-back fixture.
5. Capture the actual Firstmate task metadata and status lines, each runner decision artifact,
   the final ledger, the read-back result and the refusal cases. State clearly that this was a
   scratch local-only run. A status `done` without a current runner ledger is a failure.

The Firstmate home already passed stock preflight in guided mode. The test transcript also records
`runner-candidate` preflight against its live socket. The real KB adapter is a follow-up and is
not part of this smoke. The private file evidence store implements `src/runner/evidence.ts`'s
interface so the later adapter can replace it without changing grant or checkpoint logic.
