# Design dossier — batch "learning"

Batch items: `skills/compound` and `skills/compound-refresh` (both U, rewritten for this batch),
`protocols/evidence-gate`, `roles/learn/{pattern-maintainer,reflector,consolidator,lesson-merger,skill-scout}`,
`adapters/{observation-source,review-source}`, `profiles/learning.yaml`, and the schemas
`review-event`, `review-pattern`, `episode`, `memory-run` and `learn-state`. The runtime itself is
`src/learn/`, reached through `ak learn`, and is written by a separate batch; this dossier records
the design it implements and the catalog files that describe it.

Every donor path below was verified with `git -C .donors/<dir> cat-file -e <commit>:<path>` at the
commit pinned in `provenance/upstream.lock.yaml`. Commits used: compound-engineering `05c42da9`,
claude-mem `02cd0c9c`, claude-reflect `2c892cab`.

---

## 1. Sources and their authority

| Source | What it is | What it decides here |
|---|---|---|
| `research/sources/wikiskill-summary.md` (local source `wikiskill-summary`) | A third-party summary of the WikiSkill paper, not the paper | The layering: raw, wiki, policy. A claim drawn from it is a claim about the summary until checked against the paper |
| The maintainer's learning-stack zip, sha256 `43c0b1d086574839ebf26e75e91113462b61d8454556341a2e717743e9133af7` | A working reference implementation: a review-learning loop, a memory loop, a skill index and an installer, with the claude-mem mode file under `research/sources/learning-stack/` | Mechanism and file layout for `src/learn/`, subject to the deviations in §4 |
| claude-mem at `02cd0c9c` (Apache-2.0) | The session observer | The observation store the memory loop reads; the first binding of `adapters/observation-source` |
| claude-reflect at `2c892cab` (MIT) | Correction capture and skill discovery | The correction queue the review loop reads, the correction record's shape, and the skill scout |
| compound-engineering at `05c42da9` (MIT) | `ce-compound`, `ce-compound-refresh` | The capture bar and the refresh outcomes; see `research/dossiers/knowledge.md` §1–2 for the full import analysis |

The tree under `research/sources/learning-stack/` is the learning-stack zip unpacked, less its
real-world identifiers. The organisation it was built for, that organisation's private repository
and tracker key, a customer's name, people's names and handles, and one user's scheduler label were
replaced by fictional stand-ins. Each test fixture was rewritten to match, including the event hash
a test pins, so each of the stack's own tests gives the result it gave before. Code symbols, file
paths, product vocabulary and review prose from that work were kept. The tree therefore no longer
reproduces the zip's digest in the table above, which identifies the zip as received. Git history
before the replacement still carries the originals; it was not rewritten.

Precedence is AGENTS.md's: the governing plan wins, and the rulings in
`policies/resolved-conflicts.yaml` bind wherever the sources disagree with it.

## 2. The layering, as adopted

The summary's §2 describes three layers: a raw trace log, a wiki the maintainer writes from it, and
the deployed skills. Its §7 names the property worth keeping — **the deployed layer rolls back, the
knowledge layer does not**: "You can revert production without deleting what the organization
learned from the failed deployment."

| Summary layer | Review loop | Memory loop |
|---|---|---|
| Raw | `raw/review-events.jsonl` (`schemas/review-event.schema.json`), append-only | claude-mem's observations, read-only through the adapter |
| Wiki | Pattern pages (`schemas/review-pattern.schema.json`), recomputed from raw | Episodes (`schemas/episode.schema.json`), working memory, lessons |
| Policy | Guardrail drafts, promoted by count | Confirmed lessons, and skill candidates |

`ak learn review rollback` is §7 applied: it reverts judgement and policy commits and restores the
raw log as it was. `compound-refresh` states this in its hard-gate table, and its
`rollback-keeps-the-observed-record` case (release scenario 24) exercises it.

## 3. What each role judges, and what it may not

The summary's §16 is its own extrapolation, and the reason the evidence gate exists: a poisoned
observation becomes a persistent belief, and the knowledge layer is the one that is never rolled
back. So every judged step passes `protocols/evidence-gate`: a judge proposes prose and matches,
cites only ids it was shown, and never sets a count, status, id or rate. The runtime checks
citations against its input and rejects the whole output on a miss. The gate catches an invented id,
not a real id cited for the wrong claim, and the protocol says so rather than claiming more.

| Role | Judges | Its output becomes |
|---|---|---|
| `learn/pattern-maintainer` | Which pattern each new review event belongs to | Pattern pages; status by the runtime's count |
| `learn/reflector` | A repository's working memory from new observations | `memory.md`, replaced only on a passing gate |
| `learn/consolidator` | Lessons from a window of episodes | `hypothesis` lessons; `confirmed` by count |
| `learn/lesson-merger` | Duplicates and contradictions among lessons | Supersession; nothing deleted |
| `learn/skill-scout` | Repeated user requests across sessions | Skill candidates, never installed |

## 4. Deviations from the reference implementation

1. **No repository writes.** The zip already writes its ledgers under the host configuration
   directory; this package makes it a stated boundary. A guardrail that names a team file as its
   target is offered as a draft (ruling `central-kb-owns-project-artifacts`).
2. **No model routing.** The zip selects a model per loop, one environment variable each with a
   named default (`skills/stack-setup/references/INTEGRATION-GUIDE.md` §5.12). Here the judge is
   one operator-configured command, `AK_LEARN_JUDGE`, and nothing in the catalog names what answers it (ruling
   `learning-judge-is-runner-bound`).
3. **Drafts, not publications.** A promoted guardrail, a confirmed lesson and a skill candidate
   reach the knowledgebase as candidates only. `compound` publishes on a human's say-so or under a
   lesson-publication grant (ruling `learning-drafts-not-publishes`).
4. **A host adapter, not a dependency.** Every skill behaves the same with the runtime absent; the
   runtime only adds evidence (ruling `learning-runtime-is-host-adapter`).
5. **Vendor names removed from catalog text.** The mode file's named review products and review
   skills become generic descriptions; the adaptation row records the change.

## 5. Known limits carried forward

- The summary's §15 notes the wiki grows forever. Retirement and supersession bound what is active,
  not what is stored.
- When the review source is unavailable, ingestion contributes no review events and records no
  unavailability; re-ingestion is idempotent, so the events are delayed rather than lost
  (`adapters/review-source/CONTRACT.md` §1).

## 6. Session-start delivery per host

One function builds the block every host receives: `sessionStartBlock` in
`src/learn/memory/session-context.ts`. What differs per host is which hook output the host feeds to
its model, so `hostHooks` in `src/learn/setup/wire.ts` holds one hook list per host and
`ak learn setup wire` merges each into that host's own configuration. Each row was established
from the documentation shipped with, or published for, the version named, read on 2026-10-05.

| Host | Carrying event | What the host's documentation says | Written to |
|---|---|---|---|
| Claude Code | `SessionStart` | `adapters/claude-code/CONTRACT.md` §7 | the host's `settings.json` |
| Codex | `SessionStart` | `adapters/codex/CONTRACT.md` §6 | `$CODEX_HOME/hooks.json` |
| Droid 0.233.0 | `SessionStart` | Factory's hooks reference: on exit 0, "For `UserPromptSubmit` and `SessionStart`, stdout can add context" | the file `droidHookFile` selects, below |
| Kimi Code 2.1.1 | `UserPromptSubmit` | Kimi's hooks page: only `PreToolUse`, `Stop` and `UserPromptSubmit` return anything to the main flow, every other event is "observation-only", and for `UserPromptSubmit` "returned text is appended to context" | one marked block of `[[hooks]]` tables in `$KIMI_CODE_HOME/config.toml` |
| Grok 1.0.46 | `PostToolUse` | `docs/user-guide/10-hooks.md` in the Grok home: the event table gives `SessionStart` and `UserPromptSubmit` no output the model reads, and `PostToolUse` `additionalContext` "Adds a note for the model next to the tool result" | `$GROK_HOME/hooks/agent-kit-learn.json`, a file this runtime owns |

**Droid** needs nothing host-specific in the hook: it runs the same `ak learn hook session-start`
as Claude Code. The configuration has two homes. A standalone `hooks.json` holds events at its top
level and `settings.json` holds them under `hooks`, and where both declare an event the standalone
file's list replaces the other: the 0.233.0 binary merges the two as an object spread, standalone
last. `droidHookFile` therefore writes to the file whose `SessionStart` Droid reads. Droid parses
both as JSON with comments; this runtime reads strict JSON, so a file carrying a comment is refused
with nothing written to it, since a merge that cannot see every hook cannot be trusted to keep them. Droid
also keeps bookkeeping keys of its own beside the events in `hooks`; `openHookFile` hands the merge
event lists only and puts every other key back where it was.

**Kimi** discards `SessionStart` output, so the block rides the first prompt of a session.
`ak learn hook session-start --host kimi` prints it once per session id, and the same command with
`--arm` on `SessionStart` and `PostCompact` clears that mark, so a resumed or compacted session
receives a current block on its next prompt. The mark is a file under the runtime directory named
by a digest of the session id (`src/learn/memory/delivery.ts`). Kimi rejects a `[[hooks]]` table
carrying any key beyond `event`, `matcher`, `command` and `timeout`, so the tables carry no marker
of their own: the block is delimited by two comment lines, and `withHookBlock` replaces or removes
exactly the lines between them. A file whose markers are not one ordered pair is refused. So is one
this runtime's TOML parser cannot read, which on some Bun versions includes a valid file holding a
date or time value, and one
whose root table assigns `hooks` as a key, since TOML allows no `[[hooks]]` table after that.

**A refused file stops its own host only.** `wire` checks every file before it writes any, prints
each refusal with what to change, skips that host, wires the others and exits nonzero. `setup
verify` reports the skipped host as `not wired:` with the same reason, and `setup uninstall` passes
over a JSON file it cannot read unless a line of it names a hook of this runtime. Claude's hooks and
the claude-mem settings count as one host.

**Grok** gives a hook no way to speak before the model's first turn. The block arrives as
`additionalContext` with the first tool result of a session, under the same once-per-session mark.
A session that calls no tool never receives it. Grok's instruction files do not close that gap: the
user-level ones (`$GROK_HOME/AGENTS.md` and `$GROK_HOME/rules/`) apply to every project where the
block belongs to one, and the per-project ones live in the repository, where a ledger's contents
are not written (deviation 1 in §4). The one carrier Grok documents ahead of the first turn is the
launch flag `--rules`, which appends its text to the session's system prompt. A configuration file
cannot set it, so `wire` does not use it; a launcher that passes the output of
`ak learn hook session-start` through that flag delivers the block at session start, and on a
wired machine the same session then receives it a second time with its first tool result. Grok
clips `additionalContext` at 10,000 characters, so `sessionStartBlockWithin` fits the block itself
rather than letting the host cut it mid-line. Guardrails come first and are kept whole, memory and
lessons keep their normal cap, and the skill roster takes whatever room is left: it is cut on a line
and ends with a one-line note that it was shortened. The memory cap is lowered only when guardrails,
memory and lessons overshoot the clip without the roster. The carrier is wired on `PostToolUse` with
no matcher, because the first tool call of a session can be any tool. The cost is one CLI start after
every tool call in every Grok session on the machine, which after the first finds the delivery mark
and prints nothing. A subagent that runs `PostToolUse` under its own `sessionId` receives the full
block once, and since no `SessionStart` runs for it, nothing re-arms its mark. Grok also loads Claude
Code's hook entries by default (the compatibility rows of its hook-sources table), so on a machine
wired for both, a Grok session runs Claude Code's two hooks as well: nothing in Grok reads what
that `session-start` prints, and that `stop` queues the same debounced ingestion a Claude Code
session would.

A session in a linked worktree resolves to the main repository on every one of these paths:
`sessionRoot` falls back to `mainRepoRoot`, which follows the git common directory, so no ledger or
registry entry is created for a worktree.

**What was measured, and what was not.** `tests/learn/setup-wire-hosts.test.ts` and
`tests/learn/hook-carrier.test.ts` pin the merge on captured Droid and Kimi configuration files and
the hook's output on each host's documented payload. Each host's own CLI then loaded a scratch home
wired by `ak learn setup wire`: `droid doctor --config` and `kimi doctor` reported no issue and
`grok inspect --json` listed the three entries, and the first two reported an error on a control
file holding a malformed hook. No session was run on any of the three hosts, because a session is a
model call. That a running session's model receives the block therefore rests on each host's
documentation as quoted above, not on an observation.
