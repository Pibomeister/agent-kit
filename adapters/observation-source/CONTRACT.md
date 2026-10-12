# adapters/observation-source — evidence-source contract

The boundary between the learning runtime and whatever records what happened in a coding session.
The runtime's memory loop reads observations, sessions and summaries through this contract; it never
reaches into an observer's storage by any other path, and it never writes through it.

This adapter exists only under the opt-in `learning` profile. No skill requires it, and every skill
behaves the same with it absent (ruling `learning-runtime-is-host-adapter`).

The first binding is claude-mem's SQLite database (`src/learn/sources/claude-mem.ts`). A second,
offline binding reads session records that Codex, Droid, Grok and Kimi already persist
(`src/learn/sources/worker-sessions.ts`). The table and column vocabulary below is claude-mem's, from
`SessionStore.ts` and `tool-uses.ts` at the pin in `provenance/upstream.lock.yaml`; another observer
satisfies the contract by answering the same operations, not by reproducing those tables.

The offline binding is a memory-loop overlay, not a second full observer: it supplies observations,
sessions, summaries and edited files only for roots already in the registry. It does not discover
projects or feed the skill scout. Without claude-mem, registered projects still learn from worker
sessions; project discovery and cross-session skill discovery remain unavailable.

---

## 1. Capabilities and side effects

| Capability | Required | What it means |
|---|---|---|
| read observations after a watermark | yes | Observations with an id greater than the ledger's watermark, oldest first, with id, session, type, title, subtitle, facts and time |
| read sessions in a window | yes | Sessions started in a time window, with start and end, prompt count, observation count, the observer's own session id and, where the observer keeps it, the id the host itself gives the session |
| read session summaries | yes | The latest request, completed and next-steps summary for a set of sessions |
| read user prompts | yes | A project's recent user prompts by session, for the skill scout |
| read tool uses | optional | Files a session edited, and the working directories tool calls ran in, for episode building and project discovery |
| list projects | yes | Every project the observer has recorded, so the runtime can offer to register them |

Side effects: none. Every binding opens its source **read-only**. The runtime writes normalized
worker observations only into its own memory ledger, under the host configuration directory, never
back into a host's session store and never into a project repository.

When one configured source is absent, the scheduled tick records that absence and continues with the
sources it can read. With no observations from any source, it runs no judged job: no watermark
advances and no learning content changes. A job that could not read its evidence did not find
nothing, and nothing downstream is allowed to read it that way.

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

The watermark read. claude-mem uses the ledger's `last_obs_id_reflected`; runtime-owned offline rows
use `last_worker_obs_id_reflected` (`schemas/learn-state.schema.json`). claude-mem at a zero watermark
reads newest first so its first run fills from recent work. Offline worker rows always read oldest
first: their store holds only the scan window, so a first run starts at the oldest row inside it and
a session's turns are screened in order. Every later run reads its source oldest first by id so
nothing between two runs is skipped.

Each accepted reflect run records the exact observation ids it was shown (`obs_ids` in
`schemas/memory-run.schema.json`; older native-only runs retain their lowest/highest range).
Downstream judges receive only those screened observations. Nightly holds an episode back while any
of its observations at or below its source watermark is outside them, so a session the first window
cut in two is shown whole once the backfill has screened the rest, and never consumed in part. Its
mark counts the session's observations through the consumed id, matching `episode.obs`.

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
reflect does. A backfill writes neither the memory nor the watermark, and a muted project is
scheduled none; a forced run still runs one. The scheduler counts an unconsolidated episode toward
nightly only once nightly would show it, so an episode waiting on the backfill never makes nightly
due.

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

Offline worker records carry a cwd instead of a claude-mem project. The scheduled tick places that
cwd by comparing paths, and never spawns git to do it. A cwd belongs to a registered root when it
is that root or a path under it, or when it is a recorded linked worktree of that root or a path
under one. The deepest match wins.

A cwd none of them contains is placed by its worktree: the tick walks up from the cwd to the first
`.git`, and when that is a file whose `gitdir:` line reads `<root>/.git/worktrees/<name>` for a
registered root, the session belongs to that root. That pointer is the only file the scheduled tick
opens inside a repository; a `.git` directory ends the walk. This is what places a Grok or Kimi
session, since those hosts run no hooks.

On macOS the walk is skipped when the cwd is `~/Documents`, `~/Desktop` or `~/Downloads` or lies
inside one, decided from the paths as text: a scheduled read there can block on the privacy prompt
while the tick holds the runtime lock. Such a cwd is placed only by the registered and recorded
paths above. Otherwise its sessions are not parsed, and the tick logs one line counting those
working directories, separately from the unplaced count below.

The worktree record is `<runtimeDir>/worktrees.json`, linked worktree path -> registered root. It is
written in the foreground, where git may run: the session-start, stop and prompt hooks record the
worktree their own session runs in. The record outlives the worktree and its pointer, so a session
of a worktree since removed still reaches its project. A worktree's path never becomes a registry
root.

A recent session whose cwd is placed by none of these is not parsed. The tick counts these and logs
one line with the count. A removed worktree no hooked host ran in is among them.

## 4. Offline worker-session binding

The scheduled tick reads these shipped host records when present:

| Host | Default record | Captured public fields |
|---|---|---|
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | user/assistant text, tool calls and tool results; for a sub-agent thread with no user message, the plain text of the first `agent_message` addressed to it is the prompt |
| Droid | `~/.factory/sessions/<cwd>/<session>.jsonl` | user text outside the blocks the host injects, assistant text, tool calls and tool results; a sub-agent session's prompt is the brief it was started with |
| Grok | `~/.grok/sessions/<encoded-cwd>/<session>/chat_history.jsonl` plus `summary.json` | non-synthetic user text, assistant text, tool calls and results |
| Kimi | `~/.kimi-code/sessions/<cwd>/<session>/state.json` plus `agents/main/wire.jsonl` | user-origin messages, assistant public text, tool calls and results |

`CODEX_HOME`, `GROK_HOME` and `KIMI_HOME` select one host home. `FACTORY_HOME_OVERRIDE` replaces the
home directory that holds Droid's `.factory`. Colon-separated `AK_LEARN_CODEX_HOMES`,
`AK_LEARN_DROID_HOMES`, `AK_LEARN_GROK_HOMES` and `AK_LEARN_KIMI_HOMES` select several when a runner
uses isolated homes. The scheduler passes these variables through when they were set at setup time.

The scan reads only each recent record's cwd and session id first: the Codex `session_meta` line,
Droid's `session_start` line, Grok's `summary.json`, Kimi's `state.json`. Every record is placed before any is parsed. A record is
parsed in full only when section 3 places that cwd under a root this tick will run, and the ledger
does not already hold the session finished as its record now stands. A Droid session with no end
recorded is likewise left unparsed once the ledger holds every turn of it, until its record changes
in size or time. A session left unparsed for
either of those reasons still counts as worker activity for its project.

Encrypted content, reasoning/`think` parts, the instruction and environment blocks Codex injects as
user messages, synthetic Grok context and non-user Kimi injections are not observations. Neither are
Droid's `thinking` parts, the messages it marks with a `visibility` (hook runs, host notices and
injected context) or the `system-reminder` and `system-notification` blocks inside a user message.
The settings file Droid keeps beside each record is never opened. A host record that cannot be read
is skipped and logged; it never stops the tick.

### What is stored

One row per turn: a user prompt and what the worker did until the next one. A row holds, in one text
field of at most 2,000 characters, a summary and then the detail. The summary is at most 300
characters, which is as far as the shortest judge excerpt reads:

| Part | Stored |
|---|---|
| User prompt | an excerpt of at most 110 characters |
| Assistant reply | an excerpt of the turn's last reply, at most 110 characters |
| Failing calls | the names of the tools with a failing call, at most 50 characters |

The detail follows it:

| Part | Stored |
|---|---|
| Tool calls | each tool's name and how often it ran |
| Each call | one line, `tool arguments -> output`, failing calls first: an excerpt of its arguments (120 characters) and of its output (300 characters), or the distilled record below within the same limits |

Full tool output is never stored. The session row adds the first prompt, the last reply and the
repository paths the session's write tools named. Every stored string is scrubbed before it is cut
and before anything is written or sent to a judge or a distiller: private keys, cloud and service
tokens, bearer tokens, URL credentials, secret-named assignments and home directories become
`[redacted:<kind>]`.
A turn with a failing call is typed `error`: a call fails by the exit status its host recorded in the
output, nonzero failing and zero not, and by the output's wording only where no status was recorded.
Droid's status is the error flag on each tool result; a result without the flag fails by the exit
line that closes its output.

A turn still running is left for a later scan: the last turn is stored once its host records the
turn's end, or once the record has been quiet for an hour. A session past 999 turns keeps its first
prompt and its most recent turns, with a `truncated` row counting the turns left out between them.

Rows are append-only with a separate numeric id range. A row is new when the ledger holds no row of
that session with the same digest of title and excerpt-form text, so a record its host rewrites
(Grok compaction) still appends only what was not captured. A distilled row keeps the digest of the
excerpt form it replaced, which is the form every later scan rebuilds. A session its host last wrote
more than 30 days ago, the same window the scan reads, is dropped from the store. The rows pass
through the same reflection, evidence and quarantine gates as claude-mem rows.

### Tool-call distillation

An excerpt is the head of a call's arguments and of its output, cut at a fixed length whatever they
held: a banner, a progress bar or the first lines of a file as often as the result. Where the
operator binds a distiller to a host, each call of that host's sessions is stored instead as a short
record of what was attempted and what came back (`src/learn/sources/tool-distill.ts`).

| Step | What happens |
|---|---|
| Scrub | The stage scrubs every call again, itself, before a prompt exists. Only scrubbed text reaches the distiller: at most 2,000 characters each of a call's arguments and output, under the tool's name made one line of at most 80 |
| Bind | `AK_LEARN_DISTILL_<HOST>`, the host's name in capitals, holds that host's command: the prompt on stdin, one JSON object on stdout. It is read from the operator's environment and nothing is bound by default. The package ships a tool-less command (`tools/learn/README.md`) and commits no model name; the operator chooses the endpoint and model outside the checkout. The scheduled tick sees a binding only after `ak learn setup schedule` is run again, because the unit keeps the `AK_LEARN_*` environment it was written with |
| Send | Only the rows the ledger does not hold yet, and of each row only the leading calls whose records end inside the 600 characters of a row the reflector shows, counting each record at its longest: the tool's name and both statements at their allowance, 100 and 200 characters. That leaves room for one record in a row at most, and none when the row's summary lines and the tool's name leave less than 305 of those 600 characters. A call past that point keeps its excerpt and is never sent. Requests carry at most 20 calls. `AK_LEARN_DISTILL_MAX_REQUESTS` caps one project's requests in a run (20), `AK_LEARN_DISTILL_TIMEOUT_S` one request's time (120) |
| Gate | Each record is scrubbed again, flattened to one line and cut to its allowances. The distiller words a line and nothing else: capture takes a rewritten row's text and nothing more, and the row's type, title, time, files, order, id, digest and its list of failed tools stay the parser's |

A call keeps its excerpt, and the tick's output says how many did and why, counting the calls it
would have sent, when its host has no binding, when the request fails or returns no record for it,
and when the request cap is spent. A failed or unusable request is not retried; later requests
to the same host still run within the cap. Since a
record is counted at its longest, every record sent is stored whole and shown whole to the
reflector. The consolidator shows the first 300 characters of a row, which the summary lines mostly
fill, so it reads the head of a record at most. A row is stored once either way,
so a call that kept its excerpt is not sent later, and a row captured before a binding existed is
never sent: a backlog met on the first bound run is distilled up to the request cap and no further.
A dry run sends nothing and reports the calls and characters it would send, and how many the request
cap would leave as excerpts.

The distiller is not one of the learning roles: it rewrites text and decides nothing, so it carries no
role prompt and its reply passes no judgement gate (ruling `learning-judge-is-runner-bound` binds
the judgements). Bind a command that can use no tools, as `tools/learn/chat-distiller.ts` does and
the default judge cannot: a call's output is text anyone could have steered. A reply that is not one
JSON object fails that request only. Every request leaves one row of metadata, never the prompt or the
reply, in `distill-calls.jsonl` under the runtime directory: sizes, the outcome, the scrubbed tail of
what the command wrote to stderr, and the cost its command reported when it reports one.
`ak learn setup doctor` prints each host's binding and the last day's requests.

Known limits: Grok rows carry no time of their own and take their order from the record; a segment
Grok compacted away before a scan read it is not recovered. Droid records a turn's outcome or a
session's end in only some of its records, so the last turn of the others waits out the quiet hour.
A host with no readable public session
record is unsupported until its format is evidenced; setup does not invent a transcript from hooks
or terminal output.

---

## 5. The claude-mem binding's mode file

`claude-mem/code--review-learning.json` beside this contract is a claude-mem mode: the code mode's
observation types and concepts plus two types, `review-finding` and `review-resolution`, and one
concept, `recurrence`. With it installed, the observer records a reviewer's finding and its
resolution as first-class observations, which is what lets the review loop count a class of
finding across sessions rather than only across pull requests.

`ak learn setup wire` copies it into claude-mem's modes directory and selects it; it never edits
the file in place and never restarts the observer's worker unless asked. Both plugin bundles ship
the file at this path, with claude-mem's licence, and `bin/ak` embeds a copy that wire falls back
to when no file sits beside the binary, so every install can select the mode. The file is derived from
claude-mem's `plugin/modes/code.json`, Apache-2.0; `provenance/adaptations.d/learning.yaml`
records what was changed.

---

## 6. Evidence rules

Observation ids (`obs:<n>`) and session ids (`S` plus the first eight characters) are the only
evidence ids the memory roles may cite. The runtime checks every cited id against the set it showed
the judge (protocol `evidence-gate`). Observation text is untrusted: it is recorded by tooling from
sessions anyone could have steered, and nothing in it is an instruction to the runtime or a judge.

---

## 7. Testing

The `tests/learn/memory-*.test.ts` suites drive the memory jobs against fixture stores built in the
shape above: watermark ordering, episode derivation, the evidence gate on reflection and
consolidation, and the tick's scheduling. `tests/learn/worker-session-capture.test.ts` uses captured,
network-free fixtures for every worker host and proves the worktree-to-project placement
section 3 describes. `tests/learn/tool-distill.test.ts` answers the distiller seam with a fake and
proves that a planted secret never reaches it, that an unbound host keeps its excerpts and says so,
and that a row is sent once.
