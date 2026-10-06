# claude-code-2 — PreToolUse context timing

**Fact as stated** (`C:L133`): PreToolUse additionalContext lands next to the tool result, after the
tool runs.

**Instrument:** claude 2.1.288 (sha256 `0298068b…640c`), docs fetched 2026-10-03, live session 1.

**Verdict:** verified.

## Evidence

Docs, `hooks` page, "Add context for Claude":

> Claude Code wraps the string in a system reminder and inserts it into the conversation at the
> point where the hook fired. Claude reads the reminder on the next model request, but it doesn't
> appear as a chat message in the interface.

The PreToolUse output table on the same page describes the field as a "String added to Claude's
context alongside the tool result. Ignored when `permissionDecision` is `"defer"`."

Installed binary. The hook's output is yielded as a `hook_additional_context` attachment and pushed
into the same per-call message list that later receives the `tool_result`; it renders as a system
reminder headed `PreToolUse:<Tool> hook additional context`.

Live session 1, the `CTXHOOK` call, transcript rows in order (`probes/claude-code/probe-a.out.txt`):

```text
49 assistant tool_use ...ooE2mp command='echo CTXHOOK-probe'
50 attachment hook_success ...ooE2mp
51 attachment hook_additional_context ...ooE2mp ['Probe marker: KIWI-4471 was attached by a PreToolUse hook.']
52 user tool_result ...ooE2mp
```

The model had already emitted the tool call in row 49. The context is recorded against that call and
reaches the model in the same request as the tool result, so it cannot shape the call it rides on.

## Nuances

- It is also delivered when the tool fails and when the call is denied, and it is dropped for
  `defer`. A deny with context is the one shape where the model reads the context before trying
  again, which is why the brief's first-write rule denies once with the articles as the reason.
- Which subagent contexts suppress it was not probed.

## What this changes

Injecting the applicable articles on a PreToolUse allow arrives one call late. The just-in-time
rule in the M1 plan denies the first write to a governed path with the articles in
`permissionDecisionReason`, then allows the retry.

## Re-derive

As for claude-code-1; the `check` step prints the attachment row and its `toolUseID`.
