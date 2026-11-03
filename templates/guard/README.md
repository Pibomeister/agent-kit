# Review-session guard policy

`review-session.policy.json` is the policy `ak guard hook pre-tool-use` loads to deny reads of Claude Code's session store (`**/.claude/projects/**`). Wire it yourself; nothing in the install turns it on:

```bash
ak guard hook pre-tool-use --policy templates/guard/review-session.policy.json --host claude-code
```

The pattern matches session transcripts under `.claude/projects/` in the workspace and under `~/.claude/projects/`. It does not match the host's own memory files: project `CLAUDE.md`, `~/.claude/memory/`, or `~/.claude/settings.json` and other files under `~/.claude/` outside `projects/`.

The guard is feedback, not a security boundary. A missing, timed-out or crashing hook lets the call through; a seat that never ran the hook is not confined by this file. Codex guard support is deferred to CS-12 (`research/briefs/constitution-support-plan.md`), so on Codex the transcript-on-disk channel stays uncovered.
