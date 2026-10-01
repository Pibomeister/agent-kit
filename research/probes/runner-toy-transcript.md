# Toy charter runner transcript

Instrument: `AK_RUNNER_TRANSCRIPT=research/probes/runner-toy-transcript.md bun test tests/runner/runner.test.ts`.
The test creates a scratch git repository, an active human-approved charter outside its worker root, and a live `ak runner serve` process. It launches two separate seat processes per checkpoint.
The seat processes are toy launchers. A normal Firstmate crewmate spawn with two Firstmate-dispatched seat crewmates remains a separate live smoke gate.

Refusal: Firstmate start with a forged standing-grant hash, no standing entry or missing runner capabilities → no run created.
Stock Firstmate home /Users/eduardopicazo/Documents/Workspace/firstmate: preflight with live task runner socket → runner-candidate, 6 checks passed; no patch or pinned commit check.
Charter: sha256:9fa95a8524fcaa3073121c8ddf29d7412f6f52906b4b156f15779abab1575671; worker revision: 19e4b073fdf819e8dc61903033d8f4695f7471e9.
`call start` with worker token → refused (exit 1); supervisor token plus charter-bound standing grant → run `created` with private start attestation (exit 0).
`call status` for another run through this task-scoped worker token → refused (exit 1).
`call collect` with worker token → refused (exit 1); supervisor collected source evidence outside worker root (exit 0).
`call prepare` + `call decide` on `align.run`, grant `align-answer` → complete; seat-a and seat-b launched separately.
`call prepare` + `call decide` on `bound.run`, grant `spec-approval` → complete; two separate seat processes received packets without peer judgments.
`call prepare` + `call decide` on `build.dispatch`, grant `build-go` → complete; two separate seat processes received packets without peer judgments.
`call run-verify` → service executed configured verification command, captured its output outside worker root, and entered `verifying`.
`call prepare` + `call decide` on `review.full`, grant `finding-adjudication` → complete; two separate seat processes received packets without peer judgments.
`call prepare` + `call decide` on `review.readiness`, grant `finding-adjudication` → complete; two separate seat processes received packets without peer judgments.
`call prepare` + `call decide` on `ship.prepare`, grant `ship-pr` → complete; two separate seat processes received packets without peer judgments.
`call effect` `pr-open` twice → one read-back-confirmed remote write; second call returned the persisted result.
Service crash (`SIGKILL`) and restart on the same socket → stale socket recovered; replayed ship card returned its prior result; ledger stayed at six entries.
`call complete` → `complete`. Persisted run ledger:

| Checkpoint | Decision | Outcome |
|---|---|---|
| align-answer | align (sha256:94103a4f93ea6883d87113071824427a503b7bb300e3a60230a04738e1e7b532) | ruling |
| spec-approval | bound (sha256:e0f54f592c57f7da1f216c2e81e36c18c6627f4c381ec2590bc5480a1667f371) | ruling |
| build-go | build (sha256:b5f618d5b3d13fb803ef48efc2547e4cc9a1ec003eb8728dfc84d95d48764ada) | ruling |
| finding-adjudication | review (sha256:c6a089ecf4aa03dbab23adef09f6fecaaab024bea6134590202c1a1fef917d0b) | ruling |
| finding-adjudication | readiness (sha256:49ce67a402b86d67127378b203afcfc750e2b7e8f336e788ca7c96137bb40625) | ruling |
| ship-pr | ship (sha256:4c103a71d0745629f70df5894dbef602ca124bc36f51c7b07d67bc186d4c953a) | ruling |

Refusal: forged charter hash and a merge grant presented for `align.run` → `needs-input`, rule `runner:grant`.
Refusal: same actor in both seats and a seat input containing the other dispatch → rejected before judgment.
Refusal: alignment budget 0 → persisted `cap-reached` after restart.
Refusal: human-experience question → named-human escalation; tracked worktree edit after receipt → stale-evidence escalation.
Refusal: out-of-charter remote target and changed input at an existing remote target → rejected; read-back mismatch for all six remote effect kinds; duplicate event key → no second event or grant.
Refusal: third fix cycle on one finding → `cap-reached` with two cycles recorded.
Restart: replaying a decided card returns its recorded result; ledger remains one entry.
Refusal and recovery: delivery changed tracked source after PR open; complete refused until sync, current verification, repeat review/ship, remote push read-back and existing PR read-back.
Refusal: worker-root file submitted as trusted gate evidence → rejected.
Refusal: runner evidence path under a linked worktree's shared git common directory → rejected before directory creation.
