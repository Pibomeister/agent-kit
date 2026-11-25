# Research dossier — elephant-goldfish-model

Sources:

- The pin in `provenance/upstream.lock.yaml`, id `egm`, commit
  `403d8881d62022490637d740657b33f01e321ea8` (2026-10-30). Every path below was
  verified with `git -C .donors/google_elephant-goldfish-model cat-file -e
  403d8881d62022490637d740657b33f01e321ea8:<path>`.
- The PRD "Adapting the Elephant-Goldfish Model to agent-kit" (2026-11-02). This
  dossier records what the pin contains and what agent-kit already adapted. It
  does not add seats, schemas, or probe arms.

Donor files are cited as `egm@403d8881d62022490637d740657b33f01e321ea8:<path>`
with a `#L` anchor where a line matters. Line numbers are the pin's.

This dossier records decisions. It builds nothing.

Copy no host-capability matrix or launch-flag table from EGM's testing notes.
Those notes name hosts, flags, and billed live runs. The content denylist
rejects that class of table in catalog files. `research/` is exempt, and this
file still does not copy them.

---

## 1. The donor

| Field | Value |
| --- | --- |
| Lock id | `egm` |
| Repository | `google/elephant-goldfish-model`, https://github.com/google/elephant-goldfish-model |
| Commit | `403d8881d62022490637d740657b33f01e321ea8`, committed 2026-10-30T08:43:28Z |
| License | Apache-2.0. `egm@403d8881d62022490637d740657b33f01e321ea8:LICENSE`. Byte-identical to `provenance/licenses/google_elephant-goldfish-model.LICENSE`. Copyright 2026 Google LLC |
| NOTICE | None at the pin. Root `NOTICE` carries an attribution entry. Nothing is copied over |
| Clone | `.donors/google_elephant-goldfish-model`, full history, written by `tools/donors/clone.sh` |
| Snapshots | `provenance/donor-snapshots/egm@403d8881d620/` holds every path an adaptations row cites |

Lock comment: catalog donor, no EGM plugin, probe plus comprehension and
cold read. Count those files with the catalog donors, not with the
research-only pins (`tester-army-e2e`, `blocks`).

The GS-004f provenance test pins each living-doc claim as one whole line.
After CRLF folds to LF, the trimmed expected line must occur exactly once,
and no other line may contain the locator. A second mention of a locator in
a pinned file is forbidden. The fix for a new honest mention is to update
the pin. Rewrapping a pinned line is in scope and turns red. Dated host-facts
files are pinned by sha256 of the raw bytes. Free-text claims elsewhere are
review's job.

---

## 2. What is taken

Six donor paths. Each has at least one `provenance/adaptations.yaml` row.
Apache-2.0 section 4(b) is the change note on that row.

| Donor path | Taken | Lands in |
| --- | --- | --- |
| `agents/comprehension.md` | Naive-reader seating. Paraphrase first, under "What this proposes" and "How the existing system works, per this document" (2 to 5 sentences each). An unparaphrasable section is a finding. Scan the rest of the document before flagging a term. General engineering terms are never flagged (`#L35-L48`, `#L56-L57`) | `roles/doc-review/comprehension/ROLE.md`, `skills/doc-review/SKILL.md`, `skills/doc-review/skill.yaml` |
| `skills/egm-resolve/SKILL.md` | Contest must cite evidence the reviewer could read. Escalate when the fact lives only as a team convention or a verbal decision. Do not contest a comprehension gap. Do not add context only to satisfy a reviewer (`#L58-L78`) | same three files |
| `resources/document_standards/implementation-readiness-standard.md` | Zero-decision rule: a schema, an API path, a dependency, or handling for a new edge case that the ticket does not settle fails the bar (`#L12-L18`) | `skills/super-bound/SKILL.md`, `skills/super-bound/skill.yaml`, `references/delegation/REFERENCE.md` |
| `agents/codebase_details.md` | Proposed files are not findings. Absence of a path the plan will create is not a defect (`#L50`) | same three files |
| `tests/integration/test_claude.py` | Parent-only marker. Spawn a new child, not a fork or a resume. Score the child's transcript and launch configuration. A missing resume field is the freshness signal (`#L97-L147`) | `src/review-isolation-probe/children.ts` |
| `tests/integration/test_codex.py` | Child-thread join from the host's started-thread id. Exclude the parent thread. File reads are host command events, not a Read tool | `src/review-isolation-probe/children.ts` |

Elephant and goldfish names stay out of the catalog. Seats keep being named for
what they judge.

---

## 3. What is not taken

The PRD's non-goals, checked against the pin:

- EGM's skills, slash commands, and file workflow (`concepts_brief.md`,
  `design_draft.md`, `docs/designs/`).
- An ordered stage sequence for doc-review.
- A new context-manifest schema.
- Numeric launch targets.
- One question per turn.
- Convergence on two clean rounds with a cap that turns open findings into
  accepted trade-offs.
- Recursive README bootstrap (`egm-bootstrap`).
- Changing `independent-context`, `trusted-evidence`, or autonomous-mode
  eligibility on any host.

Reviewers starting fresh every round is already covered here by ruling
`reviewer-continuity-not-amnesia`, with the scoped exception in §4.

---

## 4. Rulings

`comprehension-seat-stays-naive`. The comprehension seat and the ticket cold
reader get no prior-finding packet. Each round is a new instance. Continuity
still holds for every other seat.

`comprehension-gap-not-contestable`. A comprehension finding resolves in one of
four ways: add the definition or the link; publish a `concept` or `adr` page and
link it; `escalated` to the human; or rejected by the human. Never rejected on
the author's word.

---

## 5. Coverage limits

Phase 1a asked for a live isolation probe on Claude Code, Codex, and Mastra
Code. Fixture arms exist. Live arms need a host login.

| Id | What it covers | Status |
| --- | --- | --- |
| GAP-MASTRA | Mastra Code has no adapter on main and no CLI dispatch path. Child transcripts are unobservable unless a fixture or an operator-supplied file provides them | recorded, not a pass. `src/review-isolation-probe/hosts.ts` |
| GAP-PROBE | GS-004e Claude Code and Codex live probe arms did not run. They need a login nobody granted. No credential was copied, read, or used | recorded, not a pass. `research/host-facts/2026-11-18/GAP-PROBE.md` |

Neither row is a pass of R3. Adapter `isolated-review-context` stays `partial`.

---

## 6. Catalog count

Verify against `provenance/upstream.lock.yaml` and `provenance/adaptations.yaml`,
not against an older README.

Lock donors: 15. Research-only Apache pins with no catalog adaptation:
`tester-army-e2e`, `blocks`. Semantic-hook MIT pin that is not a catalog donor:
the mizchi lint hook recorded in the lock.

Catalog donors with at least one adaptation under `skills/`, `roles/`,
`packs/`, `protocols/`, `references/`, `policies/`, or `adapters/`:

- ten MIT: compound-engineering, superpowers, pocock, addy, omc, omx,
  builderio-skills, pstack, claude-reflect, common-skills
- two Apache-2.0: claude-mem, egm

Twelve catalog donors. EGM is the second Apache-2.0 catalog donor because
comprehension, cold read, and the isolation probe already adapt its files.
