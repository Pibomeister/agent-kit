# Changelog

## 0.1.117

GS-017-01 T01 behavior-policy. Runner.start freezes mandatory checks at the start revision.

## 0.1.116

Donor pins. Pre-push and receipts see `.donors/` at lock pins (GAP-19 partial).

## 0.1.114

The semantic-lint Stop hook is opt-in. It no longer POSTs changed files just because
`~/.config/agent-kit/jev.env` exists.

To keep the check, export `AK_JEV_ENABLED=1` into the host process that runs the hook.
For a Firstmate worker, set it in the environment the worker pane launches with. Firstmate does not
pass the supervisor's current environment through, and with config/launch-env-allowlist the name must
be listed. Codex passing its
environment through to hook commands is not yet receipted. Unset, empty, `0`, and any
other value skip quietly before the hook reads the key file or the repository.

`AK_JEV_ENABLED=1` is explicit. Every skip then prints a host message (no-input, duplicate,
in-progress, and missing-key). A keyed user on the old default never saw those.

See `docs/semantic-lint.md`.
