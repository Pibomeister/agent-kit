# adapters/supervisor — the run supervisor contract

Under the unattended policy (ADR-0014 and its amendment of 2026-11-11), no human approves align or bound,
and no forge read backs ship. The boundary is a **run supervisor**: the system that launched the run and
watches it. The supervisor declares, in a file outside the checkout, how it meets six obligations. At final
ship it attests two facts about one head. agent-kit checks both files. agent-kit cannot authenticate them.
agent-kit does not merge: whoever the human authorized merges.

This contract names no vendor and no forge. Any system can meet it, Firstmate or another factory.

## Two supervisor seats, kept apart

The run supervisor here is not the checkpoint supervisor of autopilot. Autopilot's two independent
`supervisor` seats judge checkpoints (`adapters/runner-contract/CONTRACT.md`). The run supervisor is one
named party for a whole run. This contract binds the run supervisor only and changes no checkpoint rule.

## Naming it

| Variable | Holds |
|---|---|
| `AK_LIFECYCLE_POLICY` | `unattended`, or the policy comes from `ak.lifecycle.json` on the default branch |
| `AK_LIFECYCLE_SUPERVISOR` | The supervisor's name. It must equal the declaration's `"supervisor"` key |
| `AK_LIFECYCLE_SUPERVISOR_DECLARATION` | The absolute path of the declaration file |

## The six obligations

The declaration states, for each one, the mechanism by which the supervisor meets it. Each statement is one
non-empty line.

| Key | The supervisor commits that |
|---|---|
| `launch-and-watch` | It launched the run and watches it to the end |
| `validation-gate` | A validation gate ran at the head and passed before it attests |
| `independent-review` | A reviewer that wrote none of the change approved the head |
| `seat-separation` | The implementer, verifier and reviewer seats are filled by separate parties |
| `head-bound-evidence` | Each attested fact names the head it covers |
| `disclosure` | The pull request carries the disclosure sentence below |

Example declaration. The `contract` value names this version.

```json
{
  "contract": "agent-kit/supervisor-contract@1",
  "supervisor": "example-factory",
  "obligations": {
    "launch-and-watch": "The factory scheduler starts each run and its watcher holds the run until it ends.",
    "validation-gate": "The factory runs the full test and lint pipeline at the head and stores the result.",
    "independent-review": "A reviewer session that wrote none of the change reviews the head and records its verdict.",
    "seat-separation": "The factory dispatches implementer, verifier and reviewer as separate sessions.",
    "head-bound-evidence": "Every stored result names the 40-character head it ran against.",
    "disclosure": "The factory adds the disclosure sentence to each pull request body it opens."
  }
}
```

## The attestation at final ship

At final ship the supervisor writes one file outside the checkout.

```json
{
  "contract": "agent-kit/supervisor-contract@1",
  "supervisor": "example-factory",
  "head": "0123456789abcdef0123456789abcdef01234567",
  "pull_request": "42",
  "validation": { "result": "pass", "ref": "factory-run-7/validation" },
  "review": {
    "result": "approve",
    "reviewer": "vendor-b/model-x",
    "authors": ["vendor-a/model-y"],
    "ref": "factory-run-7/review"
  }
}
```

Identities are lower-case `provider/model` strings. The reviewer must not be among the authors.
`pull_request` is optional. `schemas/supervisor-declaration.schema.json` and
`schemas/supervisor-attestation.schema.json` carry the shape. The gate carries the rest.

## Where the files may live

Both files must sit **outside the repository**: outside the git directory and every worktree of the
project. Containment guards against a worker's accidental or in-tree write. It is not isolation: a worker
running as the same OS user can write outside the repository too. A path inside the repository, a relative
path or a project that is not a git repository is refused.

## The disclosure sentence

The pull request body carries this sentence, with the supervisor's name in place of `<name>`:

> Unattended lifecycle policy (supervisor: <name>, in place of a human): no human approved the align or bound artifacts, phase evidence is worker-attested and kept in the runner's evidence store, the supervisor attests its validation gate and independent review at the head, which agent-kit checks but cannot authenticate, and agent-kit does not merge: whoever the human authorized merges.

The check is an exact substring test on the body. Text in an HTML comment or a fenced code block does not
count.

## The sequence and its refusals

1. `open --ticket` stamps the run with the declaration's name, path and digest. A declaration that is
   invalid refuses the open. No declaration opens the run, with a note: that run cannot pass ship-preflight.
2. `unattended check --phase super-ship` refuses without a valid declaration.
3. `record --gate ship-preflight` compares the declaration in force with the stamp. A changed file, a
   missing stamp or a gate recorded under another supervisor refuses. Every such refusal ends with the same
   recovery: open a new run with `open --ticket` under the declaration in force, and record the gates again.
   On success it records the pre-ship gates, closes the run and prints the disclosure.
4. `record --gate ship-preflight --attestation <file> --body-file <file>` is final ship. It needs the
   closed run. It checks the declaration against the stamp, the attestation's shape, that the reviewer is
   not an author, that the head is present locally and descends from the shipped revision, and that the
   body carries the disclosure. It appends one entry and lists the commits after the shipped revision.
   A later attestation for a descendant head appends a further entry.

## What agent-kit checks and what it does not

The rules split by who holds them.

| Held by | Rule |
|---|---|
| The gate tests | The final-ship checks in "The sequence and its refusals" above. A verify recorded by the build's implementer seat, or by no seat, is still refused. Gate evidence binds to the revision and diff it ran at. |
| The supervisor attests per run | Its validation gate and independent review ran on the attested head and passed. The reviewer model differs from every author model. |
| The supervisor declares once | In `head-bound-evidence`: only the attested head is merged, and a moved head gets a new attestation. In `disclosure`: the posted pull request text carries the disclosure visibly. |

Gate evidence covers the shipped revision only. Commits after it carry only the supervisor's attested
evidence. The reviewer-author string comparison is a consistency guard on attested identities, not proof of
model independence. It is the one model-identity comparison in the gate, and the scoped exception to seat
independence never being a model identity (ADR-0014, amendment of 2026-11-11).

### Residual limits

- The gate does not see the forge, the posted pull request text or the merged head.
- The body match does not detect text that renders hidden: raw HTML elements, collapsed details blocks,
  indented code or link definitions.
- The opt-in policy read from the local default-branch ref is not cross-checked against any forge.
- The same-user limit: a party that runs as the same OS user can write both files. Both files are claims.
- A final-ship refusal names its cause. Fix the cause and run the final-ship command again. A head that is
  missing locally needs a fetch first.

## How an external factory declares itself

1. Pick a stable name. Set `AK_LIFECYCLE_SUPERVISOR` to it in the run's environment.
2. Write the declaration to a path outside every worktree and set
   `AK_LIFECYCLE_SUPERVISOR_DECLARATION` to its absolute path.
3. Run each worker with those variables and the policy set.
4. At final ship write the attestation and the body, and pass both to `record`.

Firstmate's own declaration is in `adapters/firstmate/SUPERVISOR.md`.
