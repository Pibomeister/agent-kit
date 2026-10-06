# codex-3 — managed delivery

**Fact as stated** (`C:L142`): requirements.toml `[hooks]` enforces the configuration but doesn't
distribute the scripts; `[features].hooks = true` forces hooks on.

**Instrument:** codex-cli 0.153.4; source `rust-v0.153.4` (`3d2ee51`); docs fetched 2026-10-03;
`probes/codex/codex-local-checks.sh` section M, the installed binary in a `--network none` container
with a file mounted at `/etc/codex/requirements.toml` (no model called).

**Verdict:** verified.

## Evidence

Source. requirements.toml accepts `allow_managed_hooks_only`, `[features]` and `[hooks]`
(`config/src/config_requirements.rs:999`, `:1007-1009`). `managed_dir` is used only as the hook's
source path for display and the trust key (`hooks/src/engine/discovery.rs:297-309`); nothing copies or
checks the scripts. Pinned features override user configuration
(`core/src/config/managed_features.rs:151-193`). `hooks` is a stable feature, on by default
(`features/src/lib.rs:1144-1149`); with the feature off, managed hooks do not run either
(`hooks/src/engine/mod.rs:237-260`).

Docs, `https://learn.chatgpt.com/docs/hooks`, notes for managed hooks:

> Codex doesn't distribute the scripts in managed_dir; your enterprise tooling must install and
> update them separately.

> To enforce managed hooks even for users who disabled hooks locally, pin [features].hooks = true in
> requirements.toml alongside [hooks].

Local checks (`probes/codex/codex-local-checks.out.txt`), user config `features.hooks = false`, a
managed PreToolUse hook whose script directory does not exist in the container:

```text
req-pinned   ([features] hooks = true + [hooks]):  source=system trust=managed managed=True
req-unpinned ([hooks] only):                       (no hooks listed)
```

`codex features list` with an empty `CODEX_HOME` prints `hooks  stable  true`.

## Nuances

1. The pin matters only against a user's `hooks = false`; the feature is on by default.
2. **A missing managed script still loads.** It fails at run time (exit 127) and, by codex-4, fails
   open.
3. A managed hook that fails to *load*, such as an empty command or a bad matcher, aborts session
   start with "failed to load required managed hooks" (`hooks/src/registry.rs:81-87`). That is the one
   fail-closed path on this host.
4. `allow_managed_hooks_only = true` drops user, project, session and plugin hooks.

## What this changes

Managed delivery on Codex is two separate jobs: requirements.toml (written by device management)
and the guard install itself, shipped as a pinned package. The guard's setup documentation names
both, and a SessionStart self-check reports a missing script, because the host will not.

## Re-derive

`bash probes/codex/codex-local-checks.sh`.
