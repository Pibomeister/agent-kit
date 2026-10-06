# claude-code-1 — hook failures

**Fact as stated** (`C:L132`): a timed-out command, http or MCP hook doesn't block. Exit code 1
without JSON is non-blocking; exit 2 blocks.

**Instrument:** claude 2.1.288 (sha256 `0298068b…640c`), docs fetched 2026-10-03, live session 1.

**Verdict:** verified. The exit-code clause is narrower than the real rule.

## Evidence

Docs, `hooks` page, "Timeouts":

> A timed-out `command`, `http`, or `mcp_tool` hook doesn't block the tool call.

Docs, `hooks` page, "Other exit codes":

> Without valid JSON on stdout, Claude Code treats exit code 1 as a non-blocking error and proceeds
> with the action, even though 1 is the conventional Unix failure code.

Installed binary. The command-hook runner marks an aborted hook `outcome:"cancelled"` with the
message `timed out after ${ms}ms` and sets no blocking error; the http and mcp_tool runners do the
same on abort. With no JSON parsed, exit 0 is success, exit 2 is blocking, and every other code falls
through to `Failed with non-blocking status code`. The default timeout constant is 600000 ms.

Live session 1 (`probes/claude-code/probe-a.out.txt`), a PreToolUse command hook with `timeout: 3`
keyed on the command text:

| Command | Hook did | Executed | Recorded as |
|---|---|---|---|
| `echo EXIT1-probe` | exit 1, stderr only | yes | debug `error: status code 1`; attachment `hook_non_blocking_error` |
| `echo EXIT2-probe` | exit 2 | no | listed in `permission_denials` |
| `echo SLEEPHOOK-probe` | slept 10 s | yes | debug `timed out after 3000ms`; attachment `hook_cancelled` |

## Nuances the design has to carry

1. **Any exit code other than 0 and 2 is non-blocking without JSON, not only 1.** That includes
   127, the code for a hook command that cannot be found, so a mistyped or uninstalled guard path
   disables the guard silently. With valid JSON on stdout the JSON decides whatever the exit code.
2. **Exit 2 blocks only on events that can block.** PostToolUse runs after the tool. On Stop,
   SubagentStop and a few other events the binary treats exit 2 with empty stdout and a
   "no such file" stderr as a missing script, not a block.
3. **Timeouts have exceptions:** Agent SDK callback hooks block on timeout for PreToolUse, and a hook
   marked `async: true` has no timeout at all.

## What this changes

A guard emits a JSON deny with exit 0, as `adapters/firstmate/hooks/child-guard.sh` already does,
and never relies on an exit code to block. A missing, crashing or slow guard lets the call through,
so the guard is early feedback and never the boundary. A SessionStart self-check can report a
missing guard; it cannot make the missing guard block.

## Re-derive

`bash probes/claude-code/probe-a.sh setup && bash probes/claude-code/probe-a.sh run && bash probes/claude-code/probe-a.sh check`
with the OAuth credentials file present. Docs: `curl -s https://code.claude.com/docs/en/hooks.md`.
