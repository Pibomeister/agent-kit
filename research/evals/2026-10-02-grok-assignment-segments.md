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
as `hooks/assignment-read-chain.json` in the private home, matcher `Bash`. The mechanism is the
documented one, in the same user guide:

- `10-hooks.md:189-191`: every handler receives the model's original tool input, an `updatedInput`
  is applied after all handlers finish, and a handler that times out, crashes or prints malformed
  output never blocks the call.
- `10-hooks.md:285-310`: `updatedInput` replaces the tool input before the permission checks and the
  tool see it, silently, and must keep the tool's schema.
- `22-permissions-and-safety.md:123-136`: hooks run before the permission rules, a hook that allows
  a call skips none of the later checks, and the mode decides what no rule approved.

The hook rewrites a Bash call only when a bare assignment segment assigns at least one variable and
every segment, after zero or more leading plain `NAME=value` words, is either a bare assignment or a
command that `grokReadOnlyPermissionRules` admits once the assigned variables are replaced by their
literal values. Bare assignment segments are dropped, and only where they always run and never
decide what runs next: after the chain start or `;`, and before `;` or `&&`. Only variables a bare
assignment set are substituted. A command keeps its own leading assignments, written out as
literals, since they are its environment and the host strips them before matching. The output keeps
every field of the original tool input (the description among them) and replaces `command` alone.
It prints nothing, so `dontAsk` and the deny rules decide the original call, for a
redirect, a command or process substitution, a backtick, a parenthesis, a backslash, a background
`&`, an unclosed quote, an unassigned variable, an unquoted glob, brace or tilde, a bare assignment
in any other position, a command with no rule, and a truncated or unreadable event. The rewrite is not an approval: the host's own allow and
deny rules still judge the rewritten call. The stream reports the call as the subject wrote it, so
the scorer reads the original chain, which is why the scorer change above is still needed.

`tests/learn/evals-subjects.test.ts` runs the rewrite on the exact chain, on assignment-prefixed
reads, and on the refused forms, checks each rewritten segment against the emitted rules, and runs
the registered hook script as a process on `PreToolUse` events.

## Live evidence

Two receipts, both measured at revision `988a88199ab4b177210343152b9e397247dbdb8c` without
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

The live proof ran the prototype mediator (sha256
`83412eac5917cd97331eb2f7e90c466bfbbbaa559e643a19602c68386282aa23`), not the file committed here. The
committed mediator returns the same output as the prototype for both receipted commands: the same
rewritten read chain, and no rewrite for the write control. It differs elsewhere, and none of these
differences has run on the live host:

- It refuses more: a backslash anywhere, and an unquoted glob, brace or tilde, which the prototype
  would have quoted into a literal. A `$` inside single quotes stays literal instead of being
  substituted.
- It matches rules against the literal words joined by single spaces, the form the guide says the
  host matches, where the prototype matched its own quoted output. Exact-form rules such as
  `git status -sb` therefore admit a rewritten segment.
- It keeps a command's leading assignments as that command's environment, where the prototype
  dropped them and substituted them into the command and into later segments. It declines a bare
  assignment beside `||` or `|`, after `&&`, or at the end of the chain, where the prototype dropped
  it and kept the neighbouring operator.
- It is registered as a script beside the hook file, the layout of the guide's own example.

No session was run for this revision.

## Follow-up, not fixed here

Both receipts carry the isolation leak the adapter already declares: "the host's bundled platform
skills, fetched into the private home at start and advertised beside the bundle's". It is recorded
as a finding for a later change.
