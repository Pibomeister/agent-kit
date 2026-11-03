# agent-kit on Cursor

Project skills live in `.cursor/skills/<id>/SKILL.md`. Type `/` in Agent chat and pick the skill, or let Agent load it from the description. Human-started skills still require the turn to begin with `/<id>`.

## super-review on a branch or pull request

1. Open a Cloud Agent (or IDE Agent) on the branch or PR.
2. Start `/super-review` with the mode (`full`, `readiness`, or `delta` inside an open run). An agent doing the work may start `full` and `readiness` (ADR-0013); that start is not approval.
3. For each reviewer seat, dispatch the matching subagent under `.cursor/agents/` (for example reviewer-standards.md, reviewer-spec.md, code-review-security.md). Each subagent has its own context window. Reviewer files set `readonly: true`.
4. The parent must not paste the author's narrative into a reviewer prompt. Isolation is conventional: Cursor does not attest excluded lineage.
5. Close findings only with independent verification evidence. The author does not sit a reviewer seat.

Plugin install (IDE): place this bundle under `~/.cursor/plugins/local/ak` so `.cursor-plugin/plugin.json` is at the plugin root. Cloud Automations do not load personal or unsynced skills; vendor `.cursor/skills/` and `.cursor/agents/` into the consuming repository.

## Skills excluded from this bundle

- None. Every authored catalog skill is under `.cursor/skills/`.

## Roles excluded from `.cursor/agents/`

- None. Every authored catalog role is a `.cursor/agents/<id>.md` subagent.
