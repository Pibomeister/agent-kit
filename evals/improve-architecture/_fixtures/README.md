# Architecture trial fixtures

These assets prepare source, not a passing skill trial. A case's native prompt starts the survey;
selected-candidate and preference branches require the independent interaction driver in
`matrix.json`. A one-turn bootstrap that stops for selection does not pass a selected branch.
The stored prompt uses the canonical Claude Code spelling. Translate only its exact start to the
selected host’s native command before launching; Codex uses `$ak:improve-architecture`.
Firstmate supplies the independent evaluator, KB-capable trial environment and complete tool/effect
observation. Missing facilities make behavioral acceptance unavailable.

The actor gets only the prepared consuming repository, ordinary prompt and actual user replies.
Use an opaque actor workspace name rather than the descriptive case name. Keep this directory,
the matrix, oracle descriptions, snapshot evidence and evaluator instructions
outside its accessible source context. Do not put an expected diagnosis in its prompt or simulate a
session history that never happened. Preserve source-derived candidate selection in the real trace.

Before actor execution, record each case id, prepared source revision/tree/content digest, runtime
and tool configuration, declared allowed effects and independent expected outcome. The scaffold
makes fixed-date local commits. Build the initial fixture, provide operator-owned trial facilities,
then take initial state: setup effects cannot be attributed to the actor. Bind the actual prepared
state if tooling or KB binding differs from the initial source commit.

Run `python3 preflight.py --evidence-directory <new-external-directory>` from this directory
before operator setup or actor trials. It reconstructs all sixteen cases in fresh workspaces,
checks all three pins in `matrix.json`, retains per-case receipts and exits nonzero on any mismatch.
Do not start actors after a failed preflight. Final fixture bytes must be formatted before repinning;
any subsequent byte change requires reconstruction and new independent review of the changed bytes.
The preflight does not bind runtime/KB facilities or prove behavioral acceptance.
Run `python3 -B test_preflight.py` for reconstruction/stale-pin/source-mutation regression controls;
these controls likewise do not substitute for independently observed survey outcomes.

The content hash recipe is implemented by `preflight.py`'s `source_identity`: enumerate
`git ls-files --stage -z`; for each stage-zero tracked file record its UTF-8 relative path,
Git mode string and SHA-256 of raw working-tree bytes (symlinks use raw link-target bytes).
Sort records by path; serialize as ASCII-escaped JSON with sorted keys, separators `,` and `:`,
and one trailing LF; SHA-256 those UTF-8 bytes. The evidence's `M-N-source-content.json`
is the exact hashed input. Directories, `.git` and untracked/ignored operator state are excluded
from this source identity, and remain covered by the separate full-state observation requirement.

`snapshot.py <consuming-repo> <external-evidence-file>` includes tracked, untracked and ignored
files/directories (including configuration, dependency and VCS state); symlink targets are recorded,
not followed. The observer must also monitor external targets and all process/tool effects; a pair
of filesystem snapshots cannot rule out a transient write later undone. Temporary reports and
explicitly permitted KB effects are recorded separately. No Edit-count or final git status alone
proves no consuming-project write.

The source oracles are established independently: order price 100 less discount 10 is 90; invalid
price/discount is rejected. In an external control copy replace the subtraction with price alone:
the mirrored test still passes, while the independent outcome test fails. Preserve the separate
invalid-order invariant test. Never mutate the actor's source mid-trial to run that control.

For an eligible tooling branch, the target scope contains a branch/nesting concern and an absent
configured complexity check. Max 4 is a fixture-selected option, not a catalog threshold. The
adequate branch already enables that check; an existing diagnostic is not a setup gap. Verify the
actual target Oxlint/runtime and intended diagnostic before recording support. Custom anti-slop
plugin support and formatter convergence need their own representative controls if that path is
proposed. A package manifest alone supplies neither proof.

`matrix.json` names the sixteen branches and their independently fixed expected outcomes. Ordinary
requests never label a repository shallow, diagnose its tests or supply an answer key. All required
continuations, initial/final state and the full dialogue/process/tool trace must be present before
a branch can pass; source controls, YAML validation and static graders are supporting evidence only.
