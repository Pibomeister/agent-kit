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
