# claude-code-4 — AGENTS.md loading

**Fact as stated** (`C:L135`): AGENTS.md is skipped by default when a CLAUDE.md exists;
`claude-md-and-agents-md` loads both (v2.1.277 or later).

**Instrument:** claude 2.1.288 (sha256 `0298068b…640c`), docs fetched 2026-10-03, live sessions 2
and 4.

**Verdict:** verified. Where the setting may be written, and the version it needs, are both
narrower than the sentence suggests.

## Evidence

Docs, `memory` page, "When Claude Code reads AGENTS.md": with both files present, Claude reads
"Your `CLAUDE.md` files only", and the step list says Claude looks for "a `CLAUDE.md`,
`.claude/CLAUDE.md`, or `CLAUDE.local.md` in your working directory or any directory above it, other
than your `~/.claude/CLAUDE.md`. If you find one, Claude reads it instead of `AGENTS.md` unless you
set **Project instructions** to `claude-md-and-agents-md`." The values table gives that value as
"Your `CLAUDE.md` and `AGENTS.md` files together, each directory's `CLAUDE.md` files first and its
`AGENTS.md` after them."

Docs, `settings-reference` page: the setting is
`pluginConfigs["agents-md@builtin"].options.instructionFiles`, and

> Claude Code ignores project and local entries because it substitutes these values into plugin
> hook, MCP, and LSP configurations, and a cloned repository must not be able to supply them.

Changelog `2.1.277` (September 18, 2026): "Added AGENTS.md support: in a project with no CLAUDE.md,
Claude Code reads AGENTS.md instead". Changelog `2.1.281`: the same support extended to other
providers and to sessions with telemetry disabled.

Installed binary: the enum `["claude-md","claude-md-or-agents-md","claude-md-and-agents-md","managed-only"]`
with `claude-md-or-agents-md` the default, and the skip list
`["CLAUDE.md",".claude/CLAUDE.md","CLAUDE.local.md"]`.

Live session 2 (`probes/claude-code/probe-c.out.txt`), default setting, CLAUDE.md and AGENTS.md in
the project root: the InstructionsLoaded log shows CLAUDE.md only, and the reply reports no
`AGENTS-TOKEN-*` in context.

Live session 4 (`probes/claude-code/probe-b.out.txt`), the same project with the setting passed
through `--settings`: the reply lists both `ROOT-TOKEN-omega4` and `AGENTS-TOKEN-bravo3`. The
InstructionsLoaded log still shows CLAUDE.md only; the debug log shows the built-in
`cc-plugin-agents-md` hooks module finding `AGENTS.md`.

## Nuances

1. **A repository cannot turn the setting on.** Project and local settings are ignored for it; only
   user settings, `--settings` and managed settings count.
2. **AGENTS.md arrives through a built-in plugin, not the memory loader**, so an InstructionsLoaded
   hook does not report it.
3. The value is not named in the `2.1.277` changelog line, and the oldest binary on this machine
   (2.1.280) already carries it, so "2.1.277 or later" is the earliest the feature could be and is not
   independently confirmed for the value itself.

## What this changes

A compiled core cannot rely on a host setting the repository controls. The brief's shape, a
CLAUDE.md that imports `@AGENTS.md`, loads the core on every setting, which is how this repository's
own `CLAUDE.md` already works.

## Re-derive

`bash probes/claude-code/probe-c.sh setup && bash probes/claude-code/probe-c.sh run`, then
`bash probes/claude-code/probe-b.sh`.
