# codex-5 — apply_patch hook input

**Fact as stated** (`C:L144`): apply_patch arrives as `tool_input.command` holding the patch text,
with no file path.

**Instrument:** codex-cli 0.153.4; source `rust-v0.153.4` (`3d2ee51`); docs fetched 2026-10-03. No
live session.

**Verdict:** verified from source and docs; not observed live. One route bypasses it.

## Evidence

Source, `core/src/tools/handlers/apply_patch.rs:469-474`:

```rust
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload> {
    apply_patch_payload_command(&invocation.payload).map(|command| PreToolUsePayload {
        tool_name: HookToolName::apply_patch(),
        tool_input: serde_json::json!({ "command": command }),
    })
}
```

`:273-279` extracts the raw patch text. PostToolUse and PermissionRequest send the same shape
(`apply_patch.rs:491-505`, `core/src/tools/approvals.rs:197-200`). The hook `tool_name` is
`apply_patch`, and `Write` and `Edit` are accepted as matcher aliases
(`core/src/tools/hook_names.rs:28-39`). The freeform tool is the only apply_patch variant on this
version (`protocol/src/openai_models.rs:310-312`).

Docs, `https://learn.chatgpt.com/docs/hooks`, "PreToolUse": "Bash and apply_patch use
tool_input.command."

## Nuances

1. **File paths exist only inside the patch body**, on `*** Add File:`, `*** Update File:`,
   `*** Delete File:` and `*** Move to:` lines. A hook has to parse them.
2. **A patch run through the shell arrives as Bash.** The exec tool's payload is
   `tool_name: bash` with `{"command": <cmd>}` (`core/src/tools/handlers/unified_exec/exec_command.rs:504-515`),
   so a heredoc into `apply_patch` misses an `apply_patch|Edit|Write` matcher entirely.

## What this changes

The Codex decoder parses every add, update, delete and move path out of the patch text and treats an
unparseable patch as touching a protected path. Its Bash decoder also recognizes an `apply_patch`
heredoc and parses that. Both become replay fixtures in M1.

## Re-derive

Read the cited lines at the tag. A live confirmation needs one `codex exec` session with a trusted
`^apply_patch$` hook that logs its input; it was designed and not run.
