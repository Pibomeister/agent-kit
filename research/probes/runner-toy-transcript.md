# Toy charter runner transcript

Instrument: `AK_RUNNER_TRANSCRIPT=research/probes/runner-toy-transcript.md bun test tests/runner/runner.test.ts`.
The test creates a scratch git repository, an active human-approved charter outside its worker root, and a live `ak runner serve` process. It launches two separate seat processes per checkpoint.
The seat processes here are toy launchers. The separate normal-crewmate live smoke is recorded in stock-firstmate-live-smoke.md.

Refusal: Firstmate start with a forged standing-grant hash, no standing entry or missing runner capabilities → no run created.
Stock Firstmate home /Users/eduardopicazo/Documents/Workspace/firstmate: preflight with live task runner socket → runner-candidate, 6 checks passed; no patch or pinned commit check.
Charter: sha256:fe56ac10d8dbd57a5be3ef04c74f481fad0aa2f7f67d9e28dee5b5e400e7694c; worker revision: 2191305367b198817d91dd3778a1f6970c9688c1.
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
| align-answer | align (sha256:c7e91802e45fb7baa706f974db9522245d595392d481a77982fd7c77f7bd3123) | ruling |
| spec-approval | bound (sha256:45bf91a372cc53e333d29c4ed1e3303332f606a38108b99d76e10c6cbcf268dc) | ruling |
| build-go | build (sha256:c52f0b1c0eca9fbe9c41408a5e747a0aa11056bc1f4a47ec9e21c5b934ca714e) | ruling |
| finding-adjudication | review (sha256:42771f69483783b26fae58623480409e0ea18714c5cb4cbcdac77ce28116360d) | ruling |
| finding-adjudication | readiness (sha256:509d4aa049307da88f56e379c2cb01875807d94fe43f6109930b039ede07c13e) | ruling |
| ship-pr | ship (sha256:b70dbcb678952bf914d58c3286f92bc956a0966e90259dc2b1ede8e0c95de0c5) | ruling |

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
