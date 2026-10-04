# adapters/observation-source — evidence-source contract

The boundary between the learning runtime and whatever records what happened in a coding session.
The runtime's memory loop reads observations, sessions and summaries through this contract; it never
reaches into an observer's storage by any other path, and it never writes through it.

This adapter exists only under the opt-in `learning` profile. No skill requires it, and every skill
behaves the same with it absent (ruling `learning-runtime-is-host-adapter`).

The first binding is claude-mem's SQLite database (`src/learn/sources/claude-mem.ts`). The table and
column vocabulary below is claude-mem's, from `SessionStore.ts` and `tool-uses.ts` at the pin in
`provenance/upstream.lock.yaml`; a different observer satisfies the contract by answering the same
operations, not by reproducing those tables.

---

## 1. Capabilities and side effects

| Capability | Required | What it means |
|---|---|---|
| read observations after a watermark | yes | Observations with an id greater than the ledger's watermark, oldest first, with id, session, type, title, subtitle, facts and time |
| read sessions in a window | yes | Sessions started in a time window, with start and end, prompt count, observation count and the observer's own session id |
| read session summaries | yes | The latest request, completed and next-steps summary for a set of sessions |
| read user prompts | yes | A project's recent user prompts by session, for the skill scout |
| read tool uses | optional | Files a session edited, and the working directories tool calls ran in, for episode building and project discovery |
| list projects | yes | Every project the observer has recorded, so the runtime can offer to register them |

Side effects: none. The binding opens the store **read-only**. The runtime writes only its own
ledgers, under the host configuration directory or the configured runtime directory, never the
observer's store and never a project repository.

With no observer store at the configured path, the scheduled tick writes that absence to its log
and runs no job: no watermark advances and no ledger changes. A job that could not read its evidence
did not find nothing, and nothing downstream is allowed to read it that way.

---

## 2. Operations

Signatures are sketches in a neutral notation.

### `listProjects`

```text
listProjects() -> ProjectName[]
```

Distinct project names, with any worktree or subdirectory suffix folded into its project.

### `observationsSince`

```text
observationsSince(project, afterId, { sinceEpochMs?, newestFirst? }) -> ObservationRow[]
observationsById(ids) -> ObservationRow[]
```

The watermark read. `afterId` is the ledger's `last_obs_id_reflected`
(`schemas/learn-state.schema.json`). A zero watermark reads newest first so a first run fills from
recent work; every later run reads oldest first so nothing between two runs is skipped.

Each accepted reflect run records the lowest and highest observation id it was shown (`min_obs_id`
and `max_obs_id` in `schemas/memory-run.schema.json`). Downstream judges receive only observations
inside those exact ranges. Nightly holds an episode back while any of its observations at or below
the watermark is outside them, so a session the first window cut in two is shown whole once the
backfill has screened the rest, and never consumed in part. Its mark counts the session's
observations through the consumed id, matching `episode.obs`.

What the watermark passed without an accepted run being shown it is screened by the backfill job,
and only where a consumer is waiting: the observations of a recorded episode, from the tick that
records it until nightly consolidates it however long that takes, and the review observations in
the `deferred` list below. A session too old to be recorded as an episode is not a consumer.
That covers the history older than a first window and whatever an accepted run from before
`min_obs_id` covered, since such a run contributes no range. Older history no consumer reads is
never sent to the judge, and with nothing waiting the backfill is not due. It reads its batch by id
(`observationsById`), newest first, one batch per idle tick. A backfill run calls the same judge
under the same input cap, applies the same quarantine and the same acceptance gates, and records
the exact ids it was shown (`obs_ids`), so an id between two of them is not counted as screened. A
reply reflect would reject is a rejected backfill: it screens nothing and backs off as a rejected
reflect does. A backfill writes neither the memory nor the watermark, and a muted project runs none. The scheduler counts an unconsolidated episode
toward nightly only once nightly would show it, so an episode waiting on the backfill never makes
nightly due.

Review ingest moves its watermark past an unscreened review observation and carries that
observation's id in the watermark file's `deferred` list. Each ingest re-reads only those ids
(`observationsById`) beside the rows after the watermark, so pre-window review history is deferred
rather than dropped and the replay stays as small as the list. The count still waiting is reported
by the ingest and by `setup seed`'s dry ingest.

### `sessions`

```text
sessions(project, sinceMs, staleBeforeMs) -> SessionRow[]
```

Sessions that started in the window and either ended or went stale, which is what makes them
episodes, each with its current observation count, which is how the runtime sees that a recorded
session has grown (`schemas/episode.schema.json`).

### `summaries` and `latestSummary`

```text
summaries(sessionIds) -> SummaryRow[]
latestSummary(sessionId) -> SummaryRow | null
```

### `sessionPrompts`

```text
sessionPrompts(project, sinceMs, limit) -> { session, prompt }[]
```

User prompts only. A prompt the runtime itself sent to a judge carries the output-contract heading
and is excluded, so a judge call recorded by the observer is never read back as a user request.

### `editedFiles` and `toolUseCwds`

```text
editedFiles(sessionId) -> RepoPath[]
toolUseCwds(sinceMs) -> { session, cwd }[]
```

Optional. Without them, episodes carry no modified files, so no failure pair can be formed and
project discovery falls back to the registry; the nightly job still consolidates what it has.

---

## 3. Project matching

A project is matched as `project = ? OR project LIKE ?/%`: claude-mem records a session in a worktree
or subdirectory as `<project>/<suffix>`, and a match on equality alone silently drops those sessions.
Any binding whose observer records sub-projects the same way must match the same way.

---

## 4. The claude-mem binding's mode file

`claude-mem/code--review-learning.json` beside this contract is a claude-mem mode: the code mode's
observation types and concepts plus two types, `review-finding` and `review-resolution`, and one
concept, `recurrence`. With it installed, the observer records a reviewer's finding and its
resolution as first-class observations, which is what lets the review loop count a class of
finding across sessions rather than only across pull requests.

`ak learn setup wire` copies it into claude-mem's modes directory and selects it; it never edits
the file in place and never restarts the observer's worker unless asked. The file is derived from
claude-mem's `plugin/modes/code.json`, Apache-2.0; `provenance/adaptations.d/learning.yaml`
records what was changed.

---

## 5. Evidence rules

Observation ids (`obs:<n>`) and session ids (`S` plus the first eight characters) are the only
evidence ids the memory roles may cite. The runtime checks every cited id against the set it showed
the judge (protocol `evidence-gate`). Observation text is untrusted: it is recorded by tooling from
sessions anyone could have steered, and nothing in it is an instruction to the runtime or a judge.

---

## 6. Testing

The `tests/learn/memory-*.test.ts` suites drive the memory jobs against fixture stores built in
the shape above: watermark ordering, episode derivation, the evidence gate on reflection and
consolidation, and the tick's scheduling.
