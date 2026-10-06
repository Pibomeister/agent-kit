# codex-1 — PreToolUse "ask"

**Fact as stated** (`C:L140`): PreToolUse `permissionDecision: "ask"` is parsed but unsupported: the
hook is marked failed and the call proceeds.

**Instrument:** codex-cli 0.153.4; source `rust-v0.153.4` (`3d2ee51`); docs fetched 2026-10-03. No
live session (README, "Live sessions").

**Verdict:** verified from source, a unit test and the docs; not observed live.

## Evidence

Source, `hooks/src/engine/output_parser.rs:458-460`:

```rust
Some(PreToolUsePermissionDecisionWire::Ask) => {
    Some("PreToolUse hook returned unsupported permissionDecision:ask".to_string())
}
```

`hooks/src/events/pre_tool_use.rs:234-240`: an `invalid_reason` sets `HookRunStatus::Failed` and
records an error entry; only a `block_reason` sets `Blocked`. `core/src/hook_runtime.rs:219` returns
`PreToolUseHookResult::Continue` when nothing blocked. The unit test
`unsupported_permission_decision_fails_open` (`hooks/src/events/pre_tool_use.rs:555-584`) asserts
this path.

Docs, `https://learn.chatgpt.com/docs/hooks`, "PreToolUse":

> permissionDecision: "ask", legacy decision: "approve", continue: false, stopReason, and
> suppressOutput are parsed but not supported yet. Codex marks the hook run as failed, reports the
> error, and continues the tool call.

## Nuances

1. **`"allow"` without `updatedInput` fails the same way** (`output_parser.rs:453-457`). On this
   version a PreToolUse hook can deny, rewrite the input or add context; it cannot ask and cannot
   pre-approve.
2. Any `additionalContext` in the same "ask" output is dropped (`pre_tool_use.rs:224`).
3. Another matching hook that denies still stops the call.
4. Hooks marked async never apply decisions (`hooks/src/engine/mod.rs:154-156`).
5. Approving or refusing an approval prompt is the separate `PermissionRequest` event.

## What this changes

The Codex encoder emits deny only. An "ask first" action becomes a deny whose reason names the
approval path, never an `ask`, because an `ask` on this host runs the action.

## Re-derive

Read the cited lines at the tag. A live confirmation needs one `codex exec` session with a copied
login and a trusted hook that returns `ask`; it was designed and not run.
