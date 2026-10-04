# Knowledgebase backend

What an agent needs, inside an installed plugin, to run a knowledgebase operation: where this
build's commands for the seven operations are, what each operation returns when nothing can be
reached, and the rules that hold under every backend. The contract this condenses is
`adapters/knowledgebase/CONTRACT.md`, which does not ship with the plugin; the rules below come
from its §0–§3 and §6, restated so the plugin carries them. A skill that reads or writes the knowledgebase
loads this pack before its first knowledgebase operation.

## Where the commands are

In [BACKEND.md](./BACKEND.md), beside this file, and nowhere else. The backend is chosen when the
plugin is built, not when a skill runs: the operator names one in the package's `ak.install.yaml`,
and the build carries that backend's document as `BACKEND.md` (ruling
`kb-backend-bundled-at-build`). A build that named none carries the unconfigured statement there.
Either way it is this build's whole answer. A command it does not name is not run for one of these
operations, however much a tool in the working repository or on `PATH` looks like a knowledgebase
client.

## The seven operations

| Operation | What a skill uses it for | With nothing to reach |
|---|---|---|
| `readContext` | Pages of the nine kinds by scope, the run artifacts linked from them, and the project record | `unavailable` |
| `requestImpactAnalysis` | The records and code a change affects, with what the analysis covered | `unavailable` |
| `recordDecision` | A decision card, which is a run artifact and not an `adr` page | refused |
| `publishArtifact` | A page of one of the nine kinds, placed by scope, or a run artifact linked from pages | refused |
| `linkCodeEvidence` | A record bound to code at a named revision | refused |
| `proposeLesson` | A lesson as a candidate; publishing it is a separate, authorized step | refused |
| `linkPullRequests` | The source PR paired with its knowledgebase PR | nothing populated, and the ship does not fail on it |

`unavailable` is not an empty result. Empty means the knowledgebase was read and holds nothing that
matches, which is a fact. Unavailable means nothing was read, so nothing may be treated as absent
from it. A backend that is configured and cannot reach its knowledgebase returns `failed` with the
error, which is neither of the two.

A refused write is returned refused, with the artifact, as the calling skill's stop conditions say.
It is never saved into the working repository instead (release scenario 21; ruling
`central-kb-owns-project-artifacts`).

## The project record

The project record (`schemas/project.schema.json`) is a `readContext` result, selected as the
record rather than by kind, and returned with its record id, content hash and revision like any
page. It is where a review seat, a pack or the tracker chain reads what the project itself
declares: its repositories and default branches, the knowledgebase root, the standards files, the
configured guidance and the ticket system of record. `BACKEND.md` says where this build's backend
takes it from, stored or derived from the knowledgebase's own configuration.

- **Empty**: the project has no record. A skill proceeds as its own body says for a project that
  declares nothing; for standards that is an empty result, never invented preferences.
- **`unavailable`**: nothing was read. The project may declare standards, a size target or a
  tracker, and nothing here says it does not. A skill that needs a declared value reports it
  unavailable rather than proceeding as though the record were empty.
- **A coverage limitation**: a derived record the backend could not complete comes back naming the
  fields it lacks. A missing field is never filled in with a guess.

## Rules every backend obeys

`BACKEND.md` is written for one knowledgebase. These hold whichever one it is.

1. **Scope, not path.** A skill passes a scope and a kind, and the knowledgebase places the page.
   No operation takes a path the skill computed.
2. **Nine kinds and no tenth:** `adr concept foundation gotcha pattern prd process sop system`. A
   skill writes only the kinds its own body names. A kind the backend cannot write is refused with
   `needs-input` naming the gap, never written as a neighbouring kind.
3. **An `adr` is published `proposed`.** No operation accepts one.
4. **Drafted is not published.** Where a backend can only draft what a skill asked it to publish,
   the result says drafted, and the skill reports a draft.
5. **An operation `BACKEND.md` does not map refuses** with `needs-input` naming it. It is not
   approximated with a nearby command.
6. **Reads carry their coverage.** A partial or stale answer comes back with its limitation, and an
   impact report with no coverage statement is not evidence that nothing is affected.
7. **A publish is read back.** A write whose outcome is unknown is read back before it is repeated,
   under the idempotency key the calling skill's side effects name.
8. **Credentials are the operator's.** No command carries one on its command line, and nothing
   token-bearing is printed, echoed or committed.
