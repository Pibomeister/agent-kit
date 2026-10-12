# Host fixtures for the learning wiring

Inputs for `tests/learn/setup-wire-hosts.test.ts` and `tests/learn/hook-carrier.test.ts`.
Nothing here is read by a host; no file holds a credential.

| File | Origin |
|---|---|
| `droid/settings.json` | Captured: the `hooks` key of a real Droid 0.233.0 `~/.factory/settings.json`, with its non-event keys (`claudeHooksImported`, `importedClaudeHooks`) as Droid wrote them. Paths rewritten to `/home/operator`; every other settings key dropped except two harmless ones. |
| `droid/session-start.stdin.json` | Doc-derived: the common hook input of Factory's hooks reference (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`) plus SessionStart's `source`. |
| `kimi/config.toml` | Captured: the `[[hooks]]` tables and marker comments of a real Kimi Code 2.1.1 `~/.kimi-code/config.toml`, three managed blocks included. Paths rewritten; provider, model and service tables replaced by one neutral table. |
| `kimi/*.stdin.json` | Doc-derived: the base hook input of Kimi Code's hooks page (snake case), plus the fields its event reference names for that event. |
| `grok/*.stdin.json` | Doc-derived: the stdin envelope of Grok 1.0.46's `docs/user-guide/10-hooks.md` (camel case, with the `hook_event_name` compatibility key). |

A doc-derived payload is what the host's documentation says it sends, not a recording of a session.
The tests pin how this runtime reads those documents, and the wiring's behaviour on captured
configuration. What was and was not measured against the hosts themselves is recorded in
`research/dossiers/learning.md` §6.
