# Grok assignment-only shell segments, 2026-10-02

The 2026-10-02 A3 smoke lost one Grok trial when the host refused this discovery call:

```sh
SESSION="<SCRATCH>/sessions/<SESSION>"; find "$SESSION" -maxdepth 3 -type d; echo '=== FILES ==='; find "$SESSION" -maxdepth 3 -type f -not -path '*/terminal/*' | head -80
```

At the measured revision, `readOnlyShell` returned `false` solely because the first segment was a
bare assignment; removing that segment returned `true`. `grokReadOnlyPermissionRules` emitted no
rule for the assignment, so `dontAsk` cancelled the session consistently with the permission
repair. The smoke contained no refusal of a command the scorer already classified as read-only.

## Decision

A segment made only of one or more `NAME=value` words is read-only when every following segment is
read-only. `NAME` matches `[A-Za-z_]\w*`. The value may not contain command substitution, backticks,
or process substitution. `export`, `declare`, `readonly`, and `local` remain commands rather than
plain assignments. An assignment followed by a program in the same segment keeps its existing
classification.

The classification follows the shell effect: a bare assignment changes only the current shell. It
creates no external side effect, and discovery naturally uses a variable to avoid repeating a long
path.

## Change

The scorer now uses one shared plain-assignment classifier and accepts the exact discovery call.
`tests/learn/trigger-score.test.ts` pins that positive together with command-substitution,
declaration-command, and write-segment negatives. They failed on the exact call before the scorer
change and pass after it.

The scorer change alone does not keep a Grok subject from being cancelled: `dontAsk` cancels the
session before scoring matters. The host half is a `PreToolUse` hook in the eval subject's private
`GROK_HOME`, described below. It is part of the eval instrument only; no user-facing Grok adapter
changed.

## Why no permission rule admits the chain

The source is the user guide shipped with the Grok 1.0.46 CLI,
`docs/user-guide/22-permissions-and-safety.md` under the Grok home, section "Rule Matching
Reference", "Bash Rules":

- "Each segment is normalized before rules are matched. Leading environment assignments such as
  `RUST_LOG=debug` are stripped", and the example is an assignment in front of a program in the
  same segment. The guide does not say what an assignment-only segment normalizes to.
- "An `allow` rule can cover a quoted filename variable when it is an `ls` or `rg` file operand that
  follows `--`, carries a literal `/` or `./` prefix, or was assigned a literal path earlier in the
  same script; `echo`, `head`, and `tail` may appear alongside with literal arguments only, and
  dynamic options, writes, other programs, and Read/Edit restrictions still prompt." The chain
  passes `"$SESSION"` to `find`, one of the other programs, so it prompts whatever `Bash(find *)`
  rule exists, and under `dontAsk` a prompt is a denial.

An earlier text of this note gave a different reason (an empty stripped segment that only `Bash()`
could match). No source supports it, and it is withdrawn. A narrow rule candidate, `Bash(SESSION=*)`, was also tried
live and did not admit the chain; its receipt is not copied here.

## The mediator

`tests/learn/evals/subjects/grok-mediator.ts` is registered by the Grok subject adapter's `isolate`
as `hooks/assignment-read-chain.json` in the private home, matcher `Bash`. The hook file names the
script beside it, `hooks/assignment-read-chain.sh`, by its absolute path, which is the same command
whether the host reads `command` as a path or as an inline shell command. The mechanism is the
documented one, in the same user guide:

- `10-hooks.md:189-191`: every handler receives the model's original tool input, an `updatedInput`
  is applied after all handlers finish, and a handler that times out, crashes or prints malformed
  output never blocks the call.
- `10-hooks.md:285-310`: `updatedInput` replaces the tool input before the permission checks and the
  tool see it, silently, and must keep the tool's schema.
- `22-permissions-and-safety.md:123-136`: hooks run before the permission rules, a hook that allows
  a call skips none of the later checks, and the mode decides what no rule approved.

The hook rewrites a Bash call only when every segment is either a bare assignment of plain
`NAME=value` words or a command that `grokReadOnlyPermissionRules` admits once the assigned
variables are replaced by their literal values, and at least one segment is a bare assignment. Bare
assignment segments are dropped, and only where they always run and never decide what runs next:
after the chain start or `;`, and before `;` or `&&`, and only when they name a variable the hook's
environment does not carry, since assigning an exported one changes what later commands see. Only
variables a bare assignment set are substituted. The output keeps every field of the original tool
input (the description among them) and replaces `command` alone. It prints nothing, so `dontAsk` and
the deny rules decide the original call, for a redirect, a command or process substitution, a
backtick, a parenthesis, a backslash, a background `&`, an unclosed quote, an unassigned variable,
an unquoted glob, brace or tilde, a bare assignment in any other position or to an environment
variable, a command with a leading assignment, a command with no rule, and a truncated or unreadable
event. The rewrite is not an approval: the host's own allow and deny rules still judge the rewritten
call. The stream reports the call as the subject wrote it. The scorer's read-only classification
reads that original chain, which is why the scorer change above is still needed. The Grok adapter's
`parse` derives the files a shell call read from the same rewrite, so a read through an assigned
variable, such as `D=<skills>/super-align; cat "$D/SKILL.md"`, is recorded as the skill load the
host performed.

`tests/learn/evals-subjects.test.ts` runs the rewrite on the exact chain, on other
assignment chains, and on the refused forms, checks each rewritten segment against the emitted rules, and runs
the registered hook script as a process on `PreToolUse` events.

## Live evidence

Two prototype receipts, both measured at revision `988a88199ab4b177210343152b9e397247dbdb8c` without
`.donors/`, default install. Compact copies are in `research/evals/2026-10-02-results/`; the
per-session event lists and the served-model name are dropped, every other field is verbatim.

| Receipt | Read chain | Deliberate write control |
|---|---|---|
| `grok-assignment-probe.json`, before the mediator | cancelled: `host cancelled refused Bash call` | cancelled, target file not created |
| `grok-assignment-mediator-final.json`, with the mediator | completed: reply `READ_CHAIN_OK`, stop reason `end_turn` | cancelled, target file not created |

The read chain is the smoke's chain with a probe session directory. The write control is
`echo deliberate-control > "<SCRATCH>/write-control.txt"`.

Guarded spend across the probes was 0.15461148 USD against a 1 USD cap. That figure includes a
conservative 0.10 USD reserve for one attempt that ended in an assembly error and left no receipt.

Those two receipts ran the prototype mediator (sha256
`83412eac5917cd97331eb2f7e90c466bfbbbaa559e643a19602c68386282aa23`). The committed mediator returns
the same output as the prototype for both receipted commands: the same rewritten read chain, and no
rewrite for the write control. It differs elsewhere:

- It refuses more: a backslash anywhere, and an unquoted glob, brace or tilde, which the prototype
  would have quoted into a literal. A `$` inside single quotes stays literal instead of being
  substituted.
- It matches rules against the literal words joined by single spaces, the form the guide says the
  host matches, where the prototype matched its own quoted output. Exact-form rules such as
  `git status -sb` therefore admit a rewritten segment.
- It declines a command with a leading assignment, where the prototype dropped the assignment and
  substituted it into the command and into later segments. It declines a bare assignment beside
  `||` or `|`, after `&&`, or at the end of the chain, where the prototype dropped it and kept the
  neighbouring operator. It declines a bare assignment to a variable already in the environment,
  such as `PATH` or `HOME`, where the prototype dropped it.
- It is registered as a script beside the hook file, named by its absolute path.

### The committed mediator on the live host

Two further sessions were approved to prove the committed hook, each with no retry.

| Receipt | Revision | Hook `command` | Read chain |
|---|---|---|---|
| `grok-assignment-mediator-committed.json` | `938ace6e994099884388e0438e9d1681556390e9` | `assignment-read-chain.sh`, a bare name | cancelled: stop reason `cancelled`, one turn, no reply |
| `grok-assignment-mediator-absolute.json` | `280c9532966d00350c0e56803b94cc67fc3b03bb` | the script's absolute path | completed: reply `READ_CHAIN_OK`, stop reason `end_turn`, two turns |

Both ran the same mediator file (sha256
`bf996c71e5bff177f5a96951d2f4e6da3797ef25bcb4611984420ffea65816af`) through `runSubject` and the
adapter's own `isolate`, on the smoke's chain with a probe session directory, which the stream
reports verbatim in both. The second is the proof that a subject writing this chain is no longer
cancelled. The sessions cost 0.00495992 USD and 0.007769 USD; guarded spend is 0.1673404 USD against
the 1 USD cap. No write control was run for either; the two receipts at `988a881` cover it.

Two things changed between the cancelled session and the completed one, and the pair of sessions
does not say which one mattered:

- The hook script now enters the adapter's directory before it starts the runtime. Run by hand
  after the first session, the script as it then was printed the right rewrite but took 11 to 35 s
  from a working directory under the scratch directory, against 0.2 to 0.4 s from the worktree; on
  this machine the temporary directory above the scratch directory is very large. The guide gives
  a hook 5 s by default and says one that times out fails open (`10-hooks.md`, Key Fields).
- The hook file now names the script by its absolute path and sets `timeout` to 30. A bare name is
  not found when a shell runs it as a command, so a host that reads `command` as an inline shell
  command would have failed open as well.

Before the second session the registered command was run three times from the session's working
directory under the isolation environment, twice as a path and once through `sh -c`. Each exited 0
with the exact rewrite, in 431, 74 and 138 ms. `tests/learn/evals-subjects.test.ts` runs the
registered command both ways from a scratch directory inside the 5 s limit.

Not observed: the host's stream carries the call as the subject wrote it, so neither the rewritten
command nor the hook's run appears in the session output. The evidence that the rewrite was applied
is that the chain completed under `dontAsk`, where the same host cancelled it without a working
hook.

## Follow-up, not fixed here

Both receipts carry the isolation leak the adapter already declares: "the host's bundled platform
skills, fetched into the private home at start and advertised beside the bundle's". It is recorded
as a finding for a later change.

The approved four-session follow-up on the landed repair is recorded in
[the 2026-10-02 Grok follow-up smoke](2026-10-02-grok-smoke-2.md).
