# `ak runner` on stock Firstmate

Firstmate owns one service per crewmate run. Start it with a supervisor-held admin token and a
task-specific worker token of at least 32 characters each:

```text
AK_RUNNER_WORKER_TOKEN=<task-token> \
  ak runner serve --socket <private-socket> --state-dir <private-state> \
    --worker-root <task-worktree> --run-id <run-id> \
    --admin-token-file ~/.config/agent-kit/runner/<run-id>/admin.token \
    --seat-config <private-seat-config> --verify-config <private-verification-config> \
    --effect-config <private-effect-config>
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

`start` requires the approved charter to allow `runner-grants`, `trusted-evidence` and
`independent-context`. It does not require `event-delivery`: storing an event does not yet deliver
it to a worker or supply that capability to a skill.

| Verb | Caller | JSON argument shape |
|---|---|---|
| `start` | Firstmate | `{"run":"r","charter":"/private/charter.json","implementer":"actor-id","revision":"<full-git-sha>","standing_grant":{"charter_hash":"sha256:<digest>","covers":"autopilot.start","controller":"firstmate","run_id":"r"},"excluded_actors":["author-id"]}` |
| `status`, `ledger` | Worker | `{"run":"r"}` |
| `packet` | Worker or Firstmate | `{"run":"r","card_id":"align-1"}`; returns a frozen card, operation, approving option and evidence hashes without either seat's judgment |
| `collect` | Firstmate | `{"run":"r","id":"receipt-id","source":"/private/receipt","revision":"<full-git-sha>","kind":"source"}` |
| `revision`, `verify` | Firstmate | `{"run":"r","revision":"<full-git-sha>"}` or `{"run":"r","evidence":"verify-id"}`; records a changed head or an already collected verification receipt |
| `event`, `charge` | Firstmate | `{"run":"r","key":"event-key","payload":"..."}` or `{"run":"r","limit":"fix_cycles","amount":1,"subject":"finding-id"}`; event storage alone does not deliver it to a worker |
| `prepare` | Worker | `{"run":"r","card":{"id":"align-1","operation":"align.run","grant":{"charter_hash":"sha256:<digest>","covers":"align-answer"},"question":"...","options":["yes","no"],"approve":"yes","evidence":["receipt-id"],"artifact_hash":"sha256:<digest>"}}` |
| `judge` | Firstmate | `{"run":"r","card_id":"align-1","seat":"seat-a","actor":"supervisor-a","dispatch":"fm-task-a","choice":"yes","rationale":"...","input_dispatches":[],"lineage":["supervisor-a"]}`; submit the other seat separately |
| `decide` | Worker | `{"run":"r","card_id":"align-1"}`; configured launchers may supply the two judgments before the decision. A card that is not the next permitted action is an error and leaves the run unchanged; decide it once its phase arrives. A launcher that fails or answers outside the options refuses the card with its error |
| `answer` | Firstmate | `{"run":"r","card_id":"align-1","choice":"yes","actor":"captain","rationale":"..."}`; settles the escalated card without relaunching seats. The escalation names the operation and approving option. After a non-approving human choice, every later card for that operation goes to a human until one approves, regardless of worker revision or artifact label. A listed `retry` reopens the checkpoint but does not erase an earlier human refusal. An approving answer at a charter cap stops at `cap-reached` |
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
six required fields plus the runner's operation and approving option; the crewmate reports it
through its normal Firstmate status and inbox rather than
polling, and Firstmate relays the human's ruling with `answer`. A changed worktree makes old evidence stale. After normal delivery changes the head,
`sync`, `run-verify`, review and ship must run again before `complete` can succeed. Merge and deploy
are never granted by these commands.

For worker-authored checkpoint evidence, the worker writes a file, calls `sync`, and reports its
path, proposed id and kind to Firstmate. The supervisor copies it into private runner intake and
calls `collect` with the admin token. Firstmate returns the accepted id and hash through the task
inbox. Only then does the worker name that evidence id on a prepared card. The file the worker
wrote is a proposal, never the runner's trusted gate record.
