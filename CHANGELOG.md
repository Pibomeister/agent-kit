# Changelog

## 0.1.114

The semantic-lint Stop hook is opt-in. It no longer POSTs changed files just because
`~/.config/agent-kit/jev.env` exists.

To keep the check, export `AK_JEV_ENABLED=1` into the host process that runs the hook
(Claude Code, Codex, or a Firstmate worker). Unset, empty, `0`, and any other value skip
quietly before the hook reads the key file or the repository.

See `docs/semantic-lint.md`.
