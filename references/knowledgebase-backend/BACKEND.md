# No knowledgebase backend

This build was packaged with no knowledgebase backend, so it carries no command that reaches one.
This is the file the knowledgebase-backend reference pack sends a skill to for its commands, and
here every operation has the same answer.

| Operation | Result in this build |
|---|---|
| `readContext`, `requestImpactAnalysis` | `unavailable` |
| `recordDecision`, `publishArtifact`, `linkCodeEvidence`, `proposeLesson` | refused |
| `linkPullRequests` | nothing populated, and not a failure |

That holds in a repository that has knowledgebase tooling of its own: a locator, a command-line
client, or skills that read and write one. Those are not this build's commands. A skill reports the
operation unavailable or refused, as its own stop conditions say, and a human who wants the
knowledgebase reached can use that tooling directly or have the plugin rebuilt with a backend.

Configuring one is an operator task in the package source, never a step a skill takes: write the
backend's document at `adapters/knowledgebase/backends/<id>.md`, name it in `ak.install.yaml` as
`knowledgebase: { backend: <id> }`, and rebuild (`adapters/knowledgebase/CONTRACT.md` §6).
