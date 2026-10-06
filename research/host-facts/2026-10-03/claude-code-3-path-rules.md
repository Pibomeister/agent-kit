# claude-code-3 — path-scoped rules

**Fact as stated** (`C:L134`): `.claude/rules/*.md` files with `paths:` load when Claude reads a
matching file, not on every tool use.

**Instrument:** claude 2.1.288 (sha256 `0298068b…640c`), docs fetched 2026-10-03, live session 2.

**Verdict:** verified, with one widening on this version: Write and Edit also trigger the load.

## Evidence

Docs, `memory` page, "Path-specific rules":

> Path-scoped rules trigger when Claude uses the Read, Write, or Edit tool on a file matching the
> pattern, not on every tool use.

Changelog, entry `2.1.288` (October 2, 2026):

> Fixed path-scoped `.claude/rules` and nested CLAUDE.md files not loading when Write or Edit creates
> or changes a file in their scope (previously only Read loaded them)

Installed binary. The Read tool queues a nested-memory load; in 2.1.288 the Write and Edit tools do
too, through the same trigger list. The same search over the 2.1.287 binary on this machine finds no
Write or Edit trigger site. Bash, Grep and Glob never queue one.

Live session 2 (`probes/claude-code/probe-c.out.txt`). Three rules, scoped to `src/read/**`,
`src/write/**` and `src/bash/**`; the task ran Bash `cat src/bash/b.ts`, a grep under `src/bash`,
Read `src/read/a.ts` and Write `src/write/new.ts`. The InstructionsLoaded hook logged:

```text
session_start    CLAUDE.md
path_glob_match  .claude/rules/read-scope.md   trigger src/read/a.ts
path_glob_match  .claude/rules/write-scope.md  trigger src/write/new.ts
```

`bash-scope.md` never loaded, although Bash read a file in its scope twice.

## Nuances

- "Reads" alone is accurate through 2.1.287. From 2.1.288 the first Write to a new file in scope
  loads the rule, but the rule still arrives after that Write has run.
- A shell command that touches a file in scope loads nothing.

## What this changes

Path rules are delivery, not enforcement, and they arrive after the first touch. They suit judgment
articles. A hard constraint on a path cannot rest on them: a script or `sed` reaches the file without
loading the rule.

## Re-derive

`bash probes/claude-code/probe-c.sh setup && bash probes/claude-code/probe-c.sh run && bash probes/claude-code/probe-c.sh check`.
