# claude-code-6 — hook decisions and permission rules

**Fact as stated** (`C:L137`): hook decisions don't bypass permission deny or ask rules.

**Instrument:** claude 2.1.288 (sha256 `0298068b…640c`), docs fetched 2026-10-03, live session 1.

**Verdict:** verified.

## Evidence

Docs, `permissions` page, "Extend permissions with hooks":

> PreToolUse hook decisions don't bypass permission rules. Claude Code evaluates deny and ask rules
> regardless of what a PreToolUse hook returns: a matching deny rule blocks the call, and a matching
> ask rule still prompts even when the hook returned `"allow"` or `"ask"`.

Installed binary: the permission pipeline logs `Hook returned '<decision>' for <tool>, but deny rule
overrides` and `… but ask rule/safety check requires full permission pipeline`.

Live session 1 (`probes/claude-code/probe-a.out.txt`), a hook returning
`permissionDecision: "allow"` for both commands:

```text
[DEBUG] Hook returned 'allow' for Bash, but deny rule overrides: Permission to use Bash with command echo DENYME-ALLOWHOOK has been denied.
[DEBUG] Hook returned 'allow' for Bash, but ask rule/safety check requires full permission pipeline
```

Neither command executed; both are in `permission_denials` (the session ran with
`--permission-prompts none`, so the ask became a denial).

## Nuances

- The reverse holds: a hook deny, or exit 2, beats an allow rule. That is the direction a guard uses.
- The binary also lets a plugin mod that handles `tool.check` override ask rules, and deny rules on a
  machine without managed settings or a Team or Enterprise plan. A guard shipped as a hook does not
  use that path.
- The changelog records two repairs that this fact depends on: `2.1.77` fixed a hook `"allow"`
  bypassing deny rules, managed ones included, and `2.1.101` fixed a hook `"ask"` downgrading a deny
  into a prompt. A host older than 2.1.101 breaks this fact.

## What this changes

A guard can only tighten what permissions allow; it can never loosen a deny. The M1 acceptance
criterion "a missing or crashing guard widens nothing the sandbox and permissions allow" follows on
this host from this fact together with claude-code-1.

## Re-derive

As for claude-code-1.
