# codex-8 — hook context cap

**Fact as stated** (`C:L147`): hook additionalContext is capped near 2,500 tokens by default.

**Instrument:** codex-cli 0.153.4; source `rust-v0.153.4` (`3d2ee51`); docs fetched 2026-10-03. No
live session.

**Verdict:** verified. The unit is an estimate from bytes, and oversized text is spilled, not cut.

## Evidence

Source, `hooks/src/output_spill.rs:12`:

```rust
pub(crate) const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT: usize = 2_500;
```

Tokens are estimated as bytes divided by four, rounded up (`utils/string/src/truncate.rs:4`,
`:71-74`). Text over the limit is written to `<temp_dir>/hook_outputs/<thread_id>/<uuid>.txt`, and
the model receives a head-and-tail preview with the saved path (`output_spill.rs:64-91`, `:126-131`).
A handler may set `additionalContextLimit`, where 0 means unlimited
(`config/src/hook_config.rs:175-184`).

Docs, `https://learn.chatgpt.com/docs/hooks`, "Large hook output":

> By default, Codex limits each model-visible hook-output message to roughly 2,500 tokens. If a hook
> returns more, Codex saves the full text under <temp_dir>/hook_outputs/<session_id>/<uuid>.txt and
> gives the model a head-and-tail preview with the saved-file path.

and "Omit additionalContextLimit to use the default 2500-token threshold."

## Nuances

1. The default is about 10,000 bytes, not a tokenizer count.
2. It applies per handler per message, so several matching hooks add up.
3. Spilled text stays on disk in full, secrets included.

## What this changes

A guard's reason and any just-in-time articles stay well under 10,000 bytes, or the model reads a
truncated preview. The brief's three to eight articles per first-write deny fit if each is carried as
its id, its one-line rule and its safe path rather than its full text.

## Re-derive

Read the cited lines at the tag.
