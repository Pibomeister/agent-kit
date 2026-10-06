# codex-2 — hook trust

**Fact as stated** (`C:L141`): non-managed hooks are skipped until trusted, with trust recorded per
hash. Managed hooks are trusted by policy.

**Instrument:** codex-cli 0.153.4; source `rust-v0.153.4` (`3d2ee51`); docs fetched 2026-10-03;
`probes/codex/codex-local-checks.sh` sections L2 and M (no model called).

**Verdict:** verified. What the hash covers is narrower than "the hook".

## Evidence

Source. `hooks/src/engine/discovery.rs:713-719` registers a handler only when it is enabled and its
status is Managed or Trusted, or the bypass flag is set; `:794-811` assigns Managed, Trusted,
Modified or Untrusted. The hash is a sha256 of the normalized hook definition
(`discovery.rs:766-792`, `config/src/fingerprint.rs:50-62`), stored as
`[hooks.state."<file>:<event>:<group>:<handler>"].trusted_hash` (`hooks/src/lib.rs:113-123`,
`config/src/hook_config.rs:27-33`). Only the user and session-flag layers may hold trust state
(`hooks/src/config_rules.rs:8-29`). Managed sources are `/etc/codex/config.toml`, MDM, cloud, legacy
managed config and requirements.toml `[hooks]` (`discovery.rs:208-242`, `:823-839`).

Docs, `https://learn.chatgpt.com/docs/hooks`, "Review and trust hooks":

> Codex records trust against the hook's current hash, so new or changed hooks are marked for review
> and skipped until trusted.

> Managed hooks from system, MDM, cloud, or requirements.toml sources are marked as managed, trusted
> by policy, and can't be disabled from the user hook browser.

Local checks (`probes/codex/codex-local-checks.out.txt`), the hook list reported over
`codex app-server`:

```text
fresh user hook:                      source=user trust=untrusted
after recording trusted_hash:         source=user trust=trusted
after editing the script body only:   source=user trust=trusted   (hash unchanged)
after changing timeout 5 -> 7:        source=user trust=modified  (hash changed)
req-pinned (requirements.toml):       source=system trust=managed managed=True
```

## Nuances

1. **The hash covers the hook definition, not the script it runs.** Editing a trusted script is never
   re-reviewed; changing its command string, timeout or position is.
2. `codex exec` has no review step. A new non-managed hook stays silently skipped in headless runs
   until it is trusted in the TUI's `/hooks`, by a hand-written `trusted_hash`, or by
   `--dangerously-bypass-hook-trust`.
3. A hook in an untrusted project's `.codex/config.toml` is not listed at all.

## What this changes

`ak guard setup wire` on Codex has to record trust, or tell the operator to, or the guard never runs
headless. Because a trusted hook's script can change unseen, the guard runs from a pinned install
outside the workspace and its own version is part of what the done gate records.
`adapters/codex/CONTRACT.md` §6 says none of this about the learning hooks it already wires.

## Re-derive

`bash probes/codex/codex-local-checks.sh` (needs docker and the installed native binary for the
managed half).
