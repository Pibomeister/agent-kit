# Unattended lifecycle policy

How a lifecycle phase runs when the repository or the runner's environment opts into the
`unattended` policy (ADR-0014): no
typed command and no grant starts a phase, every gate records evidence the gate tool ran itself,
and the human gate is the merge, which agent-kit never performs. Where nothing opts in, none of this applies and every phase
behaves exactly as its skill describes.

Every runner behaves the same way: a CI job, a scheduled job, a chat bot, a coding-agent platform
such as Niteshift, or a Firstmate worker. The policy names no runner.

## Selection

The policy is active when `AK_LIFECYCLE_POLICY=unattended` is set by the runner's operator, or
when `ak.lifecycle.json` on the repository's default branch (read at `refs/remotes/origin/HEAD`,
never the working tree) has `"policy": "unattended"`. Any other value of the variable is refused.
`open --ticket` stamps the run with the policy and its source, and a record or check under another
policy is refused. A bypass grant is refused under the policy.
`AK_LIFECYCLE_SUPERVISOR=<name>`, such as `firstmate`, names the run supervisor that stands in place of
a human. `AK_LIFECYCLE_SUPERVISOR_DECLARATION=<absolute path>` names its declaration: a JSON file outside
the repository that says how the supervisor meets six obligations. The contract, both file shapes and the
refusal points are in [`adapters/supervisor/CONTRACT.md`](../../adapters/supervisor/CONTRACT.md). The run, its gate records and decisions carry the
name. A phase that needs a human start refuses without a valid declaration.

## Starting a phase

From the project checkout run `node <bundle>/bin/ak-gate.mjs unattended check --phase <phase>`.
Exit 0 is the start for `super-align`, `super-bound` and `super-ship` when the policy is active and the
declaration is valid; the output names the supervisor and the declaration's digest. The four
model-started phases need no start under either policy. Exit 1 means the policy is not active or the
declaration is missing or invalid: the phase needs its typed command or a grant, or the declaration
fixed.

## Advancing without a human

Every point where a lifecycle skill waits for a human answer or approval proceeds with the answer
the skill itself recommends, recorded as an **unattended advance** that names the question and the
answer. It is never written as an approval, and nothing claims a human read it. The instances:
align's frontier rounds and its restatement approval; bound's approved-alignment precondition, capability-map review, open
document-review decisions, specification approval and ticket approvals; build's approved-ticket
precondition. A ticket whose delegation class makes a human the author is implemented by the agent
within its allowed changes, with the true class, floor and `author_kind: agent` recorded.

Every other stop still stops: a missing or unsupported prerequisite (for example a project record
that fails [`schemas/project.schema.json`](../../schemas/project.schema.json) validation; a delegation coverage limit is not one, and a
knowledgebase coverage limit is not one either, as the knowledgebase-binding reference says), a
blocking review finding, a prototype that needs a person, unprovable or failed evidence, and every
sensitive action, including production writes, deploys, releases, destructive external operations
and credential or protection changes. Merge is never the run's.

A delegation coverage limit is no project record, a valid one without delegation guidance, or a
missing `.cursor/bin/ak delegation` command. A missing `.cursor/bin/ak delegation` command is one not on `PATH`, an unknown subcommand or a usage error from an older CLI, as in a sandbox with only `node <bundle>/bin/ak-gate.mjs`. With it, a present record's validity is not checked, and the cause reads `missing .cursor/bin/ak delegation command, project record validity not checked`. Bound
records it once naming its cause and never stops a phase for it: `.cursor/bin/ak delegation` decides a present
record and is not run without one, and each ticket carries no `delegation` block and an assumption reading
`delegation unscored: <cause> (coverage limit)` that states the floor not evaluated and lists the
attached packs and required sensitive actions, as the delegation reference says. Build, verify,
review and ship take that ticket as it is: no class is recorded or derived for it, scorer inputs are
never invented, and every required sensitive action still stops. The build still declares the
implementer seat, so self-verification is still refused.

Bound still records every ticket, scored or unscored, with acceptance criteria and named verification
derived from the work source (the issue text or plan). A ticket that declares neither at all is a
coverage limit for verify, never a stop: it records the cause once and verifies with the repository
checks actually run, the project's declared test command among them when it declares one, each
recorded on the `verify` gate by the independent verifier seat with its real command, exit status
and output digest. A verify must always declare an independent seat; the gate checks its independence
against the seat the build recorded, so a build recorded with no seat leaves it unchecked. The gate
counts those checks and nothing else, refuses a verify recorded by the build's implementer seat or by
no seat, and records the limit on its ship decision and in the ship disclosure. A
ticket that declares criteria or verification the gate cannot read is judged like any other.
Outside the policy it is `unavailable`.

## Recording each phase

Every gate except `ship-preflight` is recorded with the evidence command after `--`; the tool runs
it in the project, stores the output by digest and records argv, exit status and times:

```sh
node <bundle>/bin/ak-gate.mjs record --gate <gate> -- <command> [args...]
```

| Phase | Gate | A command that shows it |
|---|---|---|
| align | `align` | `.cursor/bin/ak kb read` of the published concept and ADR |
| bound | `bound` | `.cursor/bin/ak kb read` of the published plan record and ticket |
| scout | `scout` | the dossier's read-back, or the bounded search that found nothing more to scout |
| build | `build-checks` | the project's test command |
| verify | `verify` | the verification command, with the receipts as `--receipt` |
| review | `review-full`, `review-delta`, `review-readiness` | the read-back of the review artifact |

Under a knowledgebase coverage limit, align and bound record a read-back of the run's own record
instead (the restatement, or the plan record and ticket, written outside the repository and read
with `/bin/cat`), and scout reads back its unpublished dossier the same way.

A non-zero exit is recorded as failed evidence; a later passing run of the same argv replaces it.
A command that changes the working tree is refused. Align, bound and scout recorded before the run
opens land in the branch-named run, and `open --ticket` imports those at the opening revision with
their original times. A later read-back is a new record with its own time, never history relabelled.

## Shipping

`open --ticket` stamps the run with the declaration's name, path and digest. A run opened with no
declaration cannot pass ship-preflight.

`record --gate ship-preflight` checks the declaration in force against that stamp, runs the pre-ship
check (all six earlier phases, current, passing), refuses with every unmet item and refuses a working tree with
uncommitted changes, which include untracked files that git does not ignore (commit what should ship, remove or
git-ignore the rest, then record the gates again), and on success closes
the run and prints the disclosure and each gate's commands. Every refusal in the declaration steps ends
with one recovery: open a new run with `open --ticket` under the declaration in force and record the
gates again. Put the disclosure in the pull request text. Under no-mistakes delivery, edit the opened
pull request's text once the pipeline returns: that is the only pull-request write. The sentence is:

> Unattended lifecycle policy (supervisor: <name>, in place of a human): no human approved the align or bound artifacts, phase evidence is worker-attested and kept in the runner's evidence store, the supervisor attests its validation gate and independent review at the head, which agent-kit checks but cannot authenticate, and agent-kit does not merge: whoever the human authorized merges.

Final ship is `record --gate ship-preflight --attestation <file> --body-file <file>`. The attestation is a
file the supervisor writes outside the repository, named by an absolute path. `shipUnattended` (`src/lifecycle/gate.ts`) runs the
final-ship checks listed in "The sequence and its refusals" of
[the supervisor contract](../../adapters/supervisor/CONTRACT.md). It appends the result to the closing
record and lists the commits after the shipped revision. Those commits are covered by the supervisor's
attestation only.

A host-unattested verifier is a recorded note rather than a refusal under this policy: the evidence
is worker-attested, and the trust boundary is the declared supervisor. Self-verification is still refused.

## Operator setup (once per repository)

Nothing here is done by an agent or by agent-kit.

1. Opt in with `AK_LIFECYCLE_POLICY=unattended` in the runner's environment, or commit `ak.lifecycle.json`
   with `{"policy": "unattended"}` to the default branch.
2. Pick the supervisor's name and set `AK_LIFECYCLE_SUPERVISOR`.
3. Write the declaration to a path outside every worktree of the project and of every repository that
   encloses it, and set `AK_LIFECYCLE_SUPERVISOR_DECLARATION` to its absolute path. [`adapters/supervisor/CONTRACT.md`](../../adapters/supervisor/CONTRACT.md) has the
   shape and an example. [`adapters/firstmate/SUPERVISOR.md`](../../adapters/firstmate/SUPERVISOR.md) has Firstmate's.
4. Decide who merges. agent-kit does not merge: whoever the human authorized merges, and protects the
   default branch as the project requires.

## Limits

agent-kit checks both supervisor files and cannot authenticate them. It does not show that the supervisor
ran its validation gate, that the independent review happened, or that the seats were separate. A party
that can write outside the repository can forge either file. Phase evidence is worker-attested. Local checks
run with the task's privileges and guard against misconfiguration and accidents, not a determined task on
the same account.
