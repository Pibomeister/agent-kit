# claude-code-7 — compaction

**Fact as stated** (`C:L138`): project-root CLAUDE.md is re-read after compaction.

**Instrument:** claude 2.1.288 (sha256 `0298068b…640c`), docs fetched 2026-10-03, live session 3.

**Verdict:** verified.

## Evidence

Docs, `memory` page, "Instructions seem lost after `/compact`": "after `/compact`, Claude re-reads
it from disk and re-injects it into the session." Docs, `context-window` page, the table of what
survives compaction: "Project-root CLAUDE.md and unscoped rules | Re-injected from disk".

Installed binary: post-compact cleanup clears the memory-file cache and sets the next load reason
to `compact`, which the InstructionsLoaded hook receives as `load_reason`.

Live session 3 (`probes/claude-code/probe-c2.out.txt`), one process, each message sent after the
previous result: a Bash `sed` changed `ROOT-TOKEN-alpha7` to `ROOT-TOKEN-omega4` in CLAUDE.md, then
`/compact`, then a tool-less question.

```text
{"load_reason":"session_start","memory_type":"Project","file_path":"<probe>/C2/proj/CLAUDE.md"}
{"load_reason":"compact","memory_type":"Project","file_path":"<probe>/C2/proj/CLAUDE.md"}
```

The reply quoted `ROOT-TOKEN-omega4`, the value on disk after the edit, not the one loaded at session
start.

A first attempt inside live session 2 queued `/compact` behind the other messages; it compacted after
the final question, so no reload was observed there. That is why session 3 exists.

## Nuances

- Nested CLAUDE.md files and `paths:` rules are not re-read until something triggers them again.
- The re-read applies to main-thread compaction; compaction inside a subagent was not probed.
- A `--resume` starts a new process that loads with `session_start`, so it cannot stand in for this
  probe.

## What this changes

A compiled core in project-root CLAUDE.md, or imported from it, survives compaction on this host.
Path-scoped articles do not until their path is touched again, which the M1 guard's first-write
rule covers.

## Re-derive

`python3 probes/claude-code/probe-c2.py` with the OAuth credentials file present.
