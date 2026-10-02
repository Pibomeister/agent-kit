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
change and pass after it; no live host was called.

## Status: blocked on the Grok host

The goal was that a subject writing this chain is not cancelled on Grok. The scorer change does not
reach that: `dontAsk` cancels the session before scoring matters, and no permission rule this
adapter can emit admits the chain. The evidence is the user guide shipped with the Grok 1.0.46 CLI,
`docs/user-guide/22-permissions-and-safety.md` under the Grok home, section "Rule Matching
Reference", "Bash Rules". No live session was run.

What it says about each way a rule could have admitted the chain:

- **Rules for the assignment-stripped command.** "Each segment is normalized before rules are
  matched. Leading environment assignments such as `RUST_LOG=debug` are stripped", and the example
  is an assignment in front of a program in the same segment. The guide does not say what an
  assignment-only segment normalizes to.
- **Rules for the variable argument.** "An `allow` rule can cover a quoted filename variable when it
  is an `ls` or `rg` file operand that follows `--`, carries a literal `/` or `./` prefix, or was
  assigned a literal path earlier in the same script; `echo`, `head`, and `tail` may appear alongside
  with literal arguments only, and dynamic options, writes, other programs, and Read/Edit
  restrictions still prompt." The chain passes `"$SESSION"` to `find`, which is one of the other
  programs, so it prompts whatever `Bash(find *)` rule exists, and under `dontAsk` a prompt is a
  denial ("a denial under `dontAsk`", same section).
- **A rule for the raw assignment-prefixed form.** The same passage says matching sees the
  normalized words, and the `find` segments carry no assignment to match.

So the documented grammar refuses this chain for its `find "$SESSION"` segments, and the one
recorded run, the cancelled A3 smoke session, agrees with it. The earlier text of this note gave a
different reason (an empty stripped segment that only `Bash()` could match); no source supports
that, and it is withdrawn. The adapter emits no new rule, and its header and
`grokReadOnlyPermissionRules` cite the passage above.

The same passage admits the equivalent chain written with `ls` or `rg` in place of `find`, which the
existing `Bash(ls *)` and `Bash(rg *)` rules would cover. The adapter cannot make a subject choose
that spelling. Closing the gap needs a decision outside this change: a Grok release whose grammar
covers a variable operand to `find`, or a different permission mode for the eval. The passage also
bears on the adapter header's older statement that `echo $VAR` and `test -n "$VAR"` remain
admitted, which was already marked unverified.
