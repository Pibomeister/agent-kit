# codex-4 — hook failures

**Fact as stated** (`C:L143`): a callback error, timeout or malformed response fails without
blocking.

**Instrument:** codex-cli 0.153.4; source `rust-v0.153.4` (`3d2ee51`); docs fetched 2026-10-03. No
live session.

**Verdict:** verified from source and docs; not observed live.

## Evidence

Source. A timeout yields `hook timed out after {}s` (`hooks/src/engine/command_runner.rs:285-327`).
Spawn errors, invalid JSON and non-zero exits become `Failed` with no block
(`hooks/src/events/pre_tool_use.rs:205-212`, `:253-259`, `:278-291`). The default timeout is 600 s;
SessionEnd and Interrupt default to 1 s and are capped at 3 s (`hooks/src/engine/discovery.rs:740-763`).

Docs, `https://learn.chatgpt.com/docs/hooks`:

> An explicit supported denial can block an action, but a PreToolUse callback error, timeout, or
> malformed response can fail the hook without blocking the tool.

and, under tool coverage, "Treat tool hooks as a useful guardrail, not a complete enforcement
boundary."

## Nuances

1. Plain non-JSON stdout is ignored, not marked failed.
2. Exit 2 with empty stderr fails rather than blocks.
3. The managed load failure in codex-3 is the only fail-closed case.

## What this changes

The same conclusion as claude-code-1, now on both hosts: a guard that crashes, hangs or prints
garbage lets the call through. The guard is feedback in front of the sandbox, credentials, CI and
branch protection, and its contracts say so.

## Re-derive

Read the cited lines at the tag. A live confirmation needs one `codex exec` session with a copied
login and trusted hooks that sleep past their timeout, print malformed JSON and exit 1; it was designed
and not run.
