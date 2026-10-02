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

## Change and remaining host gap

The scorer now uses one shared plain-assignment classifier and accepts the exact discovery call.
Fixture tests pin that positive together with command-substitution, declaration-command, and
write-segment negatives. They failed on the exact call before the scorer change and pass after it;
no live host was called.

Grok's permission grammar cannot safely admit an assignment-only segment. The host strips leading
assignments before matching allow rules, leaving an empty command. `Bash()` is the only rule that
could match that normalized form, but it is an empty prefix and would approve every command. No
rule is emitted. The exact call therefore remains a cancelled invalid session, and its existing
reason names the refused Bash call. The adapter header records the same fail-closed boundary.

Live proof is a separate, pre-approved Grok-only smoke that the captain will run after this change
lands. It must establish whether a future host grammar can admit the assignment-only discovery
shape while continuing to refuse a write.
