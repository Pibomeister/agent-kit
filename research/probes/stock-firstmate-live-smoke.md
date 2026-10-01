# agent-kit stock-Firstmate live smoke — run aks-1 (2026-10-01)

Scratch local-only project `ak-smoke` (exists only for this test). Nothing was published; the pr-open target was a local read-back fixture.
Firstmate home: /Users/eduardopicazo/Documents/Workspace/firstmate, unmodified upstream Firstmate. No 0001/0002 patches, no pinned base, no agent-kit delivery mode, and no no-mistakes auto_fix change.
agent-kit under test: Pibomeister/agent-kit commit 63bf3c3 (worktree fm-ak-runner), built with `ak build --profile all`.

## Steps and results
- Stock preflight, guided mode (no socket): 6/6 ok (preflight-guided.txt).
- `ak runner serve`: private state, socket and configs under data/ak-smoke-run, outside the worker worktree and its git dir.
- Preflight with the live socket against the worker worktree: 6/6 ok, runner check "socket exists" (preflight-runner.txt).
- `start` with the worker token: refused (exit 1). With the supervisor token: created, start_authority.kind=standing-grant naming aks-1/firstmate/autopilot.start/charter hash (start.log).
- The implementer was an ordinary Firstmate crewmate, task aks-impl, local-only, yolo off, spawned with `fm-spawn.sh` and an `ak firstmate brief` section.
- Six checkpoints. At each one the supervisor collected evidence, then dispatched two separate ordinary Firstmate scout crewmates (aks-seat-a-*, aks-seat-b-*; 12 total, each in its own worktree, Claude Sonnet, inputs separate). The supervisor then submitted the two `judge` calls, and the worker called `decide`.
- Checkpoints in order: align-1, spec-1, build-1, review-1, readiness-1, ship-1. All rulings are unanimous (ledger-final.json).
- Runner-owned verification: `run-verify` recorded verify-49e0dfd1-e3b0c442.
- `effect pr-open` was called twice. The first wrote and read back the input hash. The second returned the same persisted result (idempotent).
- `complete` exit 0; ledger status=complete at revision 49e0dfd.

## Final ledger
| checkpoint | decision | ruling |
|---|---|---|
| align-answer | align-1 | approve-direction |
| spec-approval | spec-1 | approve-spec |
| build-go | build-1 | start-build |
| finding-adjudication | review-1 | accept-findings |
| finding-adjudication | readiness-1 | ready-to-ship |
| ship-pr | ship-1 | open-pr |

## Defects found
- D1 2026-10-01T20:58:10Z: supervisor collect refused 'evidence is stale for current revision' because untracked harness state (.omc/, written by the worker's Claude plugin) appeared after the run snapshot; diff_hash counts untracked harness dirs, so any harness that writes into the worktree invalidates evidence.
- D2: a worker cannot `collect` evidence, and the brief section does not tell it to hand evidence paths to the supervisor. The handoff (worker writes the evidence file, syncs, prepares, reports the path; supervisor collects) had to be invented by Firstmate. The brief should spell it out, or the runner should accept a worker-proposed evidence file that the supervisor confirms by hash.
- D3: there is no stock seat launcher that dispatches Firstmate crewmates. Firstmate wrote seat.sh/judge.sh (here) itself. agent-kit should ship a stock-Firstmate seat launcher (fm-brief --scout + fm-spawn + report-to-judge) so supervisors don't hand-roll it.
- D4: the installed ak@agent-kit plugin predates the runner, so the worker had to read skills from the build's dist. `ak update` (separate packaging work) should cover this once published.

## Runner branch follow-up

- D1: runner snapshots now omit only untracked `.omc/` and `.omx/` harness scratch. Tracked files
  in those directories and untracked source files still change the diff hash. The standalone
  lifecycle snapshot keeps its original behavior. `tests/runner/runner.test.ts` covers the split.
- D2: `ak firstmate brief` now tells the worker to sync, hand Firstmate an evidence path/id/kind,
  wait for supervisor `collect` and its returned hash, then prepare the card.
- D3: `ak firstmate seat-launch` and `seat-judge` now wrap stock scout brief/spawn and
  report-to-runner judgment. They validate the frozen packet, private evidence hashes and the
  Firstmate scout task record. `tests/firstmate/seat.test.ts` covers the command path.
- D4 remains with separate bundle installation work. This local-only smoke did not publish a
  project change or exercise the central KB adapter.
