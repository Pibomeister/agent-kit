# adapters/supervisor — the run supervisor contract

Under the unattended policy (ADR-0014 and its amendment of 2026-11-11), no human approves align or bound,
and no forge read backs ship. The boundary is a **run supervisor**: the system that launched the run and
watches it. The supervisor declares, in a file outside the checkout, how it meets six obligations. At final
ship it attests two facts about one head. agent-kit checks both files. agent-kit cannot authenticate them.
agent-kit does not merge: whoever the human authorized merges.

This contract names no vendor and no forge. Any system can meet it, Firstmate or another factory.

## Two supervisor seats, kept apart

The run supervisor here is not the checkpoint supervisor of autopilot. Autopilot's two independent
[`supervisor`](../../roles/supervisor/ROLE.md) seats judge checkpoints ([`adapters/runner-contract/CONTRACT.md`](../runner-contract/CONTRACT.md)). The run supervisor is one
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

Identities are lower-case `provider/model` strings. The schemas' `pattern` values are ECMA-262 regular
expressions in unicode mode, as Ajv compiles them: the identity pattern uses `\p{Lu}\p{Lt}` classes, and the
test fixtures must keep agreeing with it. The reviewer must not be among the authors.
`pull_request` is optional. [`schemas/supervisor-declaration.schema.json`](../../schemas/supervisor-declaration.schema.json) and
[`schemas/supervisor-attestation.schema.json`](../../schemas/supervisor-attestation.schema.json) carry the shape. The gate carries the rest.

## Where the files may live

Both files must sit **outside the repository**: outside the project directory, its work tree, its git
directory and every worktree of the project. They must also sit outside each repository that encloses the
project, which is any directory above the project that holds a `.git` entry: outside that directory, its work
tree, its git directory and every one of its worktrees. A home directory that is a work tree holding the
project is such a repository, so a folder under it is refused too. Containment guards against a worker's
accidental or in-tree write. It is not isolation: a worker running as the same OS user can write outside the
repository too. A path inside the repository or an enclosing repository, a relative path, a project that is
not a git repository and a `.git` entry above the project that git cannot read are refused. The refusal for an
enclosing repository names its toplevel.

## The disclosure sentence

The pull request body carries this sentence, with the supervisor's name in place of `<name>`:

> Unattended lifecycle policy (supervisor: <name>, in place of a human): no human approved the align or bound artifacts, phase evidence is worker-attested and kept in the runner's evidence store, the supervisor attests its validation gate and independent review at the head, which agent-kit checks but cannot authenticate, and agent-kit does not merge: whoever the human authorized merges.

The check is an exact substring test on the body. Text in an HTML comment, a code block or an HTML block that opens
with anything other than a comment does not count. The check follows the CommonMark block structure that decides
where those start and end. Block quotes and list items are containers. A fence opens and closes only 0 to 3 columns
past its container's markers, and it ends where its container ends. A line four columns past them is indented code.
A line 0 to 3 columns past them opens an HTML block by any of the seven CommonMark start conditions, save that a
lone tag does not interrupt a paragraph. A block that opens with `<pre`, `<script`, `<style`, `<!--`, `<?`, `<!`
and a letter, or `<![CDATA[` ends at the line that holds its end marker. Any other HTML block ends before a blank
line, and every one ends where its container ends. Its lines are read raw: no code span forms there and every
comment opener hides. A comment opener inside a fence or an inline code span starts no comment, and a backtick
fence line has no backtick in its info string. In a paragraph, any other comment opener hides text to its closer or
to the end of the paragraph. A backslash escape, raw HTML, an autolink and an inline link's destination and title
take their backticks before a code span opens. Raw HTML and a link's destination and title count as not shown. From
a construct the check does not model, such as an extended autolink or a link definition, it reads the rest of the
paragraph in a fallback reading: no code span forms and every comment opener hides. A comment that an HTML block
leaves open hides the rest of the page until a later HTML block line closes it. The sentence must show under both
CommonMark readings in use, 0.29 in cmark-gfm and 0.31 in pandoc. They differ on whether `<!-->`, `<!--->` or `<?>`
ends the HTML block it opens, so the check reads the body both ways. Where they part on an HTML block start or end,
such as `<!` and a lower-case letter, the tag names `source`, `search` and `textarea`, or a lone end tag or
self-closing tag named `pre`, `script` or `style`, nothing from that line on counts. The same holds from a lone
carriage return. A leading byte order mark is dropped, and a CRLF is one line ending.

## The sequence and its refusals

1. `open --ticket` stamps the run with the declaration's name, path and digest. A declaration that is
   invalid refuses the open. No declaration opens the run, with a note: that run cannot pass ship-preflight.
2. `unattended check --phase super-align`, `--phase super-bound` and `--phase super-ship` refuse without
   a valid declaration.
3. `record --gate ship-preflight` compares the declaration in force with the stamp. A changed file, a
   missing stamp, a gate recorded under another supervisor, or a working tree with uncommitted changes
   refuses. Untracked files that git does not ignore count as uncommitted changes. The gate record is judged
   at the tree it ran at, so those changes would ship in no revision: commit what should ship, remove or
   git-ignore the rest, then record the gates again. A refusal for the file, the stamp or another supervisor
   ends with the same recovery: open a new run with `open --ticket` under the declaration in force, and
   record the gates again. On success it checks the pre-ship gates, records `ship-preflight` with a
   [`supervisor`](../../roles/supervisor/ROLE.md) entry that names the declaration, closes the run and prints the disclosure.
   `record` also refuses, for any gate of an opened run, a supervisor name that differs from the one the
   run was opened under.
4. `record --gate ship-preflight --attestation <file> --body-file <file>` is final ship. It needs the
   closed run. It checks the declaration against the stamp, the attestation's shape, that the reviewer is
   not an author, that the head is present locally and descends from the shipped revision, and that the
   body carries the disclosure. It appends one entry and lists the commits after the shipped revision.
   A later attestation for a descendant head appends a further entry.

Final ship invocation: `node <bundle>/bin/ak-gate.mjs record --gate ship-preflight --attestation <file>
--body-file <file> --project <dir> --run <id> [--dir <store>]`. Run it in a process that has the policy and
both supervisor variables set, with the declaration file unchanged since the run was opened. The `--attestation`
path must be absolute. The exit status is 0 when it records, 1 when it refuses and 2 for a usage error. It
never waits: every outcome is immediate.

Final ship reads the worker's repository, which the worker can write. Its reads of the head, its descent and
the commits after the shipped revision, and its read of the policy from the default-branch ref, run with the
options that `FINAL_SHIP_GIT` in `src/lifecycle/gate.ts` names. They turn off lazy fetch, replace refs and
signature display. So a missing object runs no promisor remote's program, replace refs cannot change the
history the checks see, and no `gpg.program` runs in the supervisor's process. A git older than 2.44 rejects
`--no-lazy-fetch`, and final ship refuses. Any other program-valued key that git reads in the worker's
repository is outside this guarantee. Only OS user separation between the worker and the supervisor closes it.
A fetch that the supervisor runs in the worker's repository reads that configuration too.

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
- The body match does not detect text that renders hidden by other means. These are a tag or an attribute in the
  fallback reading that follows a construct the check does not model, raw HTML that leaves open an element a
  browser hides (such as `script`, `style` or `title`) or an attribute value that runs on into later text,
  collapsed details blocks and image descriptions. They also include footnote and link definitions that no
  reference uses, which the renderer drops with the lines that continue them. The match reads a table as paragraph
  text. Its reading of tabs and of lazy continuation lines is approximate.
- The opt-in policy read from the local default-branch ref is not cross-checked against any forge.
- The same-user limit: a party that runs as the same OS user can write both files. Both files are claims.
- A final-ship refusal names its cause. Two kinds of cause need different action:
  - Fix the cause and run the final-ship command again. The causes are a declaration that is absent, invalid
    or changed since the run was opened (restore the stamped file), a supervisor name in the environment or
    the attestation other than the run's (use the run's supervisor), a run that ship-preflight has not closed
    (record ship-preflight first), a relative attestation path, an attestation inside the repository or a
    repository that encloses it, a `.git` entry above the project that git cannot read, an attestation or body
    that cannot be read or fails a check, a reviewer among the authors, and a head that is missing locally
    (fetch it first).
  - Open a new run: a head that does not descend from the shipped revision, or a run with no supervisor stamp.
    These refusals print the same recovery line as the ship-preflight refusals: open a new run with
    `open --ticket` under the declaration in force, and record the gates again.

## How an external factory declares itself

1. Pick a stable name. Set `AK_LIFECYCLE_SUPERVISOR` to it in the run's environment.
2. Write the declaration to a path outside every worktree of the project and of every repository that
   encloses it, and set `AK_LIFECYCLE_SUPERVISOR_DECLARATION` to its absolute path.
3. Run each worker with those variables and the policy set.
4. At final ship write the attestation and the body, and pass both to `record`.

Firstmate's own declaration is in [`adapters/firstmate/SUPERVISOR.md`](../firstmate/SUPERVISOR.md).
