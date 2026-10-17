# `ak runner` on stock Firstmate

Firstmate owns one service per crewmate run. Start it with a supervisor-held admin token and a
task-specific worker token of at least 32 characters each:

```text
AK_RUNNER_WORKER_TOKEN=<task-token> \
  ak runner serve --socket <private-socket> --state-dir <private-state> \
    --worker-root <task-worktree> --run-id <run-id> \
    --admin-token-file ~/.config/agent-kit/runner/<run-id>/admin.token \
    --seat-config <private-seat-config> --verify-config <private-verification-config> \
    --effect-config <private-effect-config> \
    --event-config <private-event-config> --loop-config <private-loop-config> \
    --kit-root <installed-bundle-root>
```

The admin token file must be mode 0600 and sit outside the Firstmate home, the worker worktree and
every git checkout or git directory. `serve` refuses worker-root and git-checkout locations;
`ak firstmate seat-judge` also checks the Firstmate home. Never
write its path into a brief or another worker-visible file. On a same-user install a deliberately
adversarial worker can still read it: these rules guard against accidents and are not isolation.

The socket parent and configs must exist outside the worker worktree and shared Git common
directory. The service holds its own state and evidence there. The worker receives only the socket
and task token. Both callers use `ak runner call <verb> --json <request-file>`, with
`AK_RUNNER_SOCKET` and `AK_RUNNER_TOKEN` set for their respective token. A supervisor command file
must be supervisor-owned; a worker-authored file never supplies effect commands.
The installed `bin/ak` exposes `runner serve|call`; `--kit-root` pins the installed bundle whose
policy and procedure the service reads. The service refuses a bundle inside the worker root.

`start` requires the approved charter to allow `runner-grants`, `trusted-evidence` and
`independent-context`. `status.autonomy` reports `autonomous` only when the live service has both
private adapters and the charter sets `audit_cadence_seconds`; otherwise it reports `guided` and
names what is missing. A charter requesting unattended mode cannot use `decide` while guided.

| Verb | Caller | JSON argument shape |
|---|---|---|
| `start` | Firstmate | `{"run":"r","charter":"/private/charter.json","implementer":"actor-id","revision":"<full-git-sha>","standing_grant":{"charter_hash":"sha256:<digest>","covers":"autopilot.start","controller":"firstmate","run_id":"r"},"excluded_actors":["author-id"]}` |
| `status`, `ledger` | Worker | `{"run":"r"}` |
| `packet` | Worker or Firstmate | `{"run":"r","card_id":"align-1"}`; returns a frozen card, operation, approving option and evidence hashes without either seat's judgment |
| `collect` | Firstmate | `{"run":"r","id":"receipt-id","source":"/private/receipt","revision":"<full-git-sha>","kind":"source"}` |
| `revision`, `verify` | Firstmate | `{"run":"r","revision":"<full-git-sha>"}` or `{"run":"r","evidence":"verify-id"}`; records a changed head or an already collected verification receipt |
| `event`, `charge` | Firstmate | `{"run":"r","key":"event-key","payload":"..."}` or `{"run":"r","limit":"fix_cycles","amount":1,"subject":"finding-id"}`; the event is persisted before its private consumer wakes |
| `delegate`, `progress`, `finish` | Firstmate | `delegate`: `{"run":"r","id":"owner-1","amount":120,"parent":"optional-parent"}` where amount is expected seconds; `progress`: `{"run":"r","id":"owner-1","kind":"commit","source":"<observed-ref>"}`; `finish`: `{"run":"r","id":"owner-1"}` |
| `verdict` | Firstmate | `{"run":"r"}` after full review and readiness; records full-change stable patch-id and head before merge preparation |
| `prepare` | Worker | `{"run":"r","card":{"id":"align-1","operation":"align.run","grant":{"charter_hash":"sha256:<digest>","covers":"align-answer"},"question":"...","options":["yes","retry"],"approve":"yes","evidence":["receipt-id"],"artifact_hash":"sha256:<digest>"}}`; `no` and `retry` cannot be the approving option, and the runner reserves a slot for its human `no` |
| `judge` | Firstmate | `{"run":"r","card_id":"align-1","seat":"seat-a","actor":"supervisor-a","dispatch":"fm-task-a","choice":"yes","rationale":"...","input_dispatches":[],"lineage":["supervisor-a"]}`; submit the other seat separately |
| `decide` | Worker | `{"run":"r","card_id":"align-1"}`; configured launchers may supply the two judgments before the decision. A card that is not the next permitted action is an error and leaves the run unchanged; decide it once its phase arrives. A launcher that fails or answers outside the options refuses the card with its error |
| `answer` | Firstmate | `{"run":"r","card_id":"align-1","choice":"no","actor":"captain","rationale":"..."}`; the runner always accepts `no` as a refusal even when the card omits it. The escalation recommends `no` by default and names the operation and approving option. After any non-approving human choice, including `retry`, every later card for that operation goes to a human until one approves. An approving answer at a charter cap stops at `cap-reached` |
| `cancel` | Firstmate | `{"run":"r","actor":"captain","rationale":"Stop this run."}`; records actor, rationale and time in the ledger, clears an open escalation and sets the durable `cancelled` stop even at a cap. A completed run cannot be cancelled. It does not undo a confirmed effect or reconcile a performed effect awaiting read-back |
| `sync`, `run-verify` | Worker | `{"run":"r"}`; sync observes the current Git revision and diff, while verification executes only the private configured command |
| `effect` | Firstmate | `{"run":"r","effect":"pr-open","target":"repo/pr-identity","input_hash":"sha256:<digest>"}` |
| `complete` | Firstmate | `{"run":"r"}` after a current ship decision, verification and remote read-back |

The private seat config names exactly two launchers, each with `seat`, `actor`, `lineage` and a
`command` argv array. Each receives a frozen card on stdin and returns JSON with `choice` and
`rationale`. Seat launchers and effect commands run from the private state directory with worker-root
runtime configuration and `PATH` entries removed. The verification command alone runs from the worker
root, so it executes worker-controlled code under the runner's OS identity; isolate that identity
from supervisor secrets when workers may be adversarial. Under stock Firstmate those launchers must
dispatch separate ordinary crewmates, not children of the implementing worker. Alternatively
Firstmate submits `judge` after arranging both crewmates itself. The private verification config is
`{"command":["..."]}`. Use absolute script and file paths in the private seat and effect configs;
their working directory is the state directory, and a worker-root `node_modules/.bin` entry is not
available on the filtered `PATH`. The optional private
effect config is `{"adapters":[{"effect":"pr-open","read_back":["..."],"perform":["..."]}]}`;
`{target}` and `{input_hash}` in an argv element are replaced by the runner. A request cannot
carry either command array.

The private event config is `{"command":["..."],"timeout_ms":10000}`. The supervisor supplies
the timeout; the runner guesses no cap. Its command receives
`{"run":"r","key":"event-key","payload":"..."}` on stdin and returns a matching
`{"run":"r","key":"event-key"}` only after handing the wake to the controller. It receives a
run-scoped worker socket token, never the admin token. The private loop config has the same
command and timeout shape. A timed-out consumer or loop command leaves status guided until a
successful retry. On a charter cadence the loop receives a `probe` request listing every active delegate
and the recorded procedure identity; it must return the same `probed` list and a `progress` list
whose entries name delegate, side-effect kind and observed ref. For each delegate with no side
effect within its expected runtime, it receives `stand-down-replace` with a stable key and returns that key,
`stood_down:true`, a replacement id and its expected runtime after read-back. Failure leaves the
delegate active and status guided. Both config files must be outside the worker root and shared
Git directory. Restarting the service replays unacknowledged events and resumes the audit timer
for active delegates.

On stock Firstmate, `ak firstmate seat-launch` accepts the runner's `packet` JSON, a private
evidence directory, the captain's intent file and the implementer worktree. It registers a new
task, runs stock `fm-brief.sh --scout`, fills its brief with the frozen packet and hash-checked
evidence, and runs stock `fm-spawn.sh --scout`. After that crewmate writes its normal report,
`ak firstmate seat-judge` reads the final `{"choice":"...","rationale":"..."}` line, checks
Firstmate's scout task metadata and submits `judge` with the supervisor token from
`--admin-token-file`. Its request file stays beside that private token, outside the scout's task
directory. Use distinct task
ids and worktrees for the two seats. Firstmate owns their normal status and teardown lifecycle.

A refusal is an operation result or CLI error. A `needs-input` result contains one escalation with
six required fields plus the runner's operation and approving option; its options always include
the runner's `no`, even if the worker's card did not. The crewmate reports it
through its normal Firstmate status and inbox rather than
polling, and Firstmate relays the human's ruling with `answer`. A changed worktree makes old evidence stale. After normal delivery changes the head,
`sync`, `run-verify`, review and ship must run again before `complete` can succeed. Merge and deploy
are never granted by these commands.

The runner pins an absolute Git executable when the service starts. Each snapshot Git subprocess
has a ten-second limit, and a nonregular Git index or HEAD refuses the snapshot. Snapshotting reads
raw worktree bytes and recursively reads attached nested repositories, so large trees and nested
repositories add I/O cost. Git ignores remain relevant to untracked files: `.git/info/exclude` can
hide a top-level file, nested repository ignores can hide nested edits, and a gitlink whose `.git`
entry is absent is not traversed. Keep gate evidence and verification tied to the actual source
tree; the fingerprint alone does not establish that these hidden files were reviewed.

For worker-authored checkpoint evidence, the worker writes a file, calls `sync`, and reports its
path, proposed id and kind to Firstmate. The supervisor copies it into private runner intake and
calls `collect` with the admin token. Firstmate returns the accepted id and hash through the task
inbox. Only then does the worker name that evidence id on a prepared card. The file the worker
wrote is a proposal, never the runner's trusted gate record.
