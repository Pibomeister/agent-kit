# adapters/knowledgebase — host contract

Contract only. No implementation lives here, and the package ships no backend (§6).

Project-derived material — context, standards, decisions, requirements, plans, ticket artifacts,
review ledgers, solutions and lessons — is owned by a **central knowledgebase**, not by the
application repository and not by this package (plan §1.2, §8; ruling
`central-kb-owns-project-artifacts`). This file defines the narrow
interface every skill uses to reach it: seven operations, their guarantees, their failure modes, and
the two release scenarios they exist to satisfy.

---

## 0. The vocabulary, and where it is defined

The authority is `docs/decisions/0001-kb-document-vocabulary.md` (**ADR-0001**, Accepted
2026-09-19). This contract is written against it and restates only what an implementer of these
operations needs; the ADR governs where the two disagree.

### Two artifact classes, one adapter

ADR-0001 §2. The distinction is load-bearing and decides which operation a skill calls.

| | **KB documents** | **Run artifacts** |
|---|---|---|
| What | Curated, human-readable, long-lived pages | Revision-bound, schema-validated operational records |
| Vocabulary | The nine `KBDocumentType` kinds below | `common#/$defs/schema_id` |
| Validated by | The KB's own templates and review | `schemas/*.schema.json` plus the plan §5.2 envelope (`common#/$defs/envelope`) |
| Reviewed | By a human | Not prose; proof |
| Stored | As KB pages | In the KB's run-scoped storage, **linked from** pages, never rendered as curated prose |

A `gotcha` says *why* something is true and a human reviews it. A verification receipt says *what
happened at a revision* and is proof. Neither converts into the other.

### `KBDocumentType` — the nine kinds

```text
adr · concept · foundation · gotcha · pattern · prd · process · sop · system
```

These are the kinds the KB implementation already has. **agent-kit adds no tenth kind** — inventing
one would fork a working tool's vocabulary for no behavioral gain, and `ak validate` rejects a kind
outside this set.

Two consequences a writer gets wrong if left implicit:

- **A skill does not choose a kind freely.** ADR-0001 §3 is a per-skill emission table fixing which
  kind and which run artifact each skill may write. A skill absent from that table writes nothing
  durable. The table is the authority; this contract does not copy it.
- **A skill does not compute a KB path.** ADR-0001 §7: placement is by **scope**, resolved against
  the KB's component model most-specific-match-first. A skill passes a scope through the adapter.
  Directory names stay configurable (plan §8); central ownership does not.

### The application-local paths do not survive

ADR-0001 §1 replaces the design brief's repository-local targets with central equivalents: the
glossary and `concept`/`system` pages replace the app-local context file, `gotcha` and `pattern`
replace the app-local solutions tree, and `adr` (created `proposed`) replaces app-local decision
records. `ak validate` scans skill bodies for the retired write targets (`src/denylist.ts`,
`LOCAL_DOC_TARGET_TERMS`).

### Substitutability

agent-kit does not depend on one KB implementation. The adapter is the boundary: any KB satisfying
the seven operations in §2 and supporting the nine kinds is substitutable, and §6 is how one is
bound.

---

## 1. Capabilities and side effects

This adapter supplies `kb-read` and `kb-write` (`common#/$defs/capability`). Neither coding-agent
host provides them (`adapters/claude-code/CONTRACT.md` §3, `adapters/codex/CONTRACT.md` §3); the host
supplies transport only.

Side effects (`common#/$defs/side_effect`): `kb-draft` and `kb-publish`. `kb-publish` is a
`common#/$defs/remote_side_effect`, so every publishing operation carries an idempotency key and a
read-back per `adapters/runner-contract/CONTRACT.md` §5.

With no KB configured, `kb-read` operations return an explicit **unavailable** result and `kb-write`
operations refuse. They never fall back to writing the working repository — that failure is release
scenario 21, and it is the single most common way a donor's behavior survives where it should not.

### Capabilities this adapter supplies

| Capability | Unconfigured | What the refusal is |
|---|---|---|
| `kb-write` | `fails-closed` | A refusal; never a write to the working repository (release scenario 21) |

This table is read by `ak build` and `ak validate` (`loadAdapterSupplies` in
`src/packaging/install.ts`), the way §3 of each host contract is read for what the host provides. A
row is a claim that this adapter refuses rather than degrades when it is not configured, and that
claim is what lets an install that attaches the adapter package a skill requiring the capability at
`autonomous` although neither host provides it: the capability is then not silently absent, because
an operation needing it refuses instead of proceeding without it (ruling
`fail-closed-adapter-lifts-ceiling`). Whether this adapter is attached is the install's decision,
stated in `ak.install.yaml`; with no such file, it is.

`kb-read` is deliberately **not** a row, although this adapter supplies it. Unconfigured, it returns
an explicit unavailable result and the run continues past it, so its absence is reported rather than
refused. That is honest, but it is not failing closed, and a skill requiring `kb-read` stays capped
at `guided` on a host that lacks it, attached knowledgebase or not.

### Which backend a bundle carries

A bundled skill works from the package's own files alone, so the commands behind the seven
operations travel in the bundle, and which knowledgebase they reach is decided when it is built
(§6; ruling `kb-backend-bundled-at-build`). The install states it in `ak.install.yaml`
(`schemas/install.schema.json`):

```yaml
attached: [runner-contract, knowledgebase]
knowledgebase:
  backend: <kebab-case id>
```

The key selects what the bundle says, not a mode. `kb-write` fails closed with a backend or without
one, so the table above lifts the same skills either way; what changes is whether an operation
reaches a knowledgebase or refuses. With no `knowledgebase:` key, and with no install file at all,
the bundle carries the unconfigured statement. Naming a backend while `attached:` leaves this
adapter out is an error (`packaging.install-backend-unattached`), and so is naming one that has no
document (`packaging.install-backend-undocumented`).

---

## 2. The seven operations

Signatures are sketches in a neutral notation; the wire form belongs to the implementation. `Ref`
types are opaque handles the KB issues. `Result<T>` is either `T` or a structured failure carrying
`common#/$defs/operation_status` and, for `needs-input`, an `escalation`.

Which operation a skill calls follows from §0's two classes: `publishArtifact` writes both, and its
`placement` argument is what declares the class. `recordDecision` writes the `decision` **run
artifact** — the decision card, with its options and evidence. An `adr` **page** is a different
thing and takes the `publishArtifact` KB-document path; a decision card is frequently the evidence a
proposed `adr` cites, which is why both exist.

### `readContext`

```text
readContext(project: ProjectRef, selector: ContextSelector) -> Result<KBDocument[]>
```

- **Inputs** — `project` is `common#/$defs/project_ref`. `selector` names one or more of the nine
  `KBDocumentType` kinds and a scope, optionally narrowed by tag, revision or recency. It may also
  select run artifacts linked from those pages, which return as links, not as page bodies.
- **Outputs** — zero or more documents, each with its KB record id, content hash and last-modified
  revision, so a caller can bind evidence to what it actually read.
- **Failure modes** — KB unreachable → `failed` with the error. KB reachable but the project has no
  record → an **empty result**, which is a fact, not an error; a skill that needs context and finds
  none stops rather than inventing it. Partial results (some types unavailable) are returned with an
  explicit coverage limitation, never silently truncated.
- **The project record** — `selector` may name the project record instead of kinds. The result is
  the one `project` artifact (`schemas/project.schema.json`) with the same record id, content hash
  and revision, or an empty result where the project has none. Every consumer of the project's own
  declarations reads it here: the review seats' standards and requirements, the project-scoped packs
  and guidance values `attach-pack` reads, and the tracker chain's system of record
  (`adapters/tracker/CONTRACT.md` §2). The backend supplies it, stored or derived from the
  knowledgebase's own configuration, and its document says which (§6). A derived record meets the
  schema as a stored one does; a required field the backend cannot derive is a coverage limitation
  naming that field, never a value filled in.
- **Side effects** — none. Read-only.

### `recordDecision`

```text
recordDecision(decision: DecisionArtifact) -> Result<KBRecordRef>
```

- **Carries** `schemas/decision.schema.json`, envelope-bearing per `common#/$defs/envelope`. This is
  a **run artifact** (§0), not a page.
- **Inputs** — the decision with its question, bounded options, chosen option, evidence references
  and affected artifact hashes.
- **Outputs** — the KB record ref plus the stored content hash, for the caller's own evidence chain.
- **Failure modes** — a decision whose evidence references do not resolve is refused. A decision that
  supersedes an existing one must name it in `envelope.supersedes`; an unnamed conflict is refused
  rather than merged.
- **Side effects** — `kb-draft`, then `kb-publish` when authority permits.
- **Note** — recording the applicable **existing** decision, or an explicit no-new-decision result,
  is a valid outcome. A mechanical fix does not force a fresh ADR: absence of a decision is a
  recordable outcome, not a gap to fill with prose (plan §8, ADR-0001 §5).

### `publishArtifact`

```text
publishArtifact(artifact: EnvelopeArtifact, placement: Placement) -> Result<KBRecordRef>

Placement = { class: "kb-document", kind: KBDocumentType, scope: Scope }
          | { class: "run-artifact", run: RunRef, links: KBRecordRef[] }
```

- **Carries** any artifact whose `envelope.schema` is in `common#/$defs/schema_id` — `project`,
  `ticket`, `dossier`, `finding`, `review`, `verification`, `charter`, `decision`, `event`, `lesson`,
  `handoff-record`, `evaluation`, `map`, `plan-record`, `ship-evidence`, `run-ledger`.
- **Inputs** — the artifact, plus the `placement` that declares its §0 class. A `kb-document`
  placement names one of the nine kinds and a **scope**; the KB resolves the scope to a location
  (ADR-0001 §7) and the caller supplies no path. A `run-artifact` placement names the run and the KB
  records the artifact should be linked from.
- **Outputs** — the KB record ref and stored content hash.
- **Failure modes** — an artifact failing its own schema is refused before any write. A `kind` outside
  the nine is refused; the caller does not invent a tenth. Whether a `kb-document` placement's kind
  is one ADR-0001 §3 assigns to the calling skill is not enforced: that table is prose, and no check
  reads it (`AUTHORING.md` §4.1).
- **ADR lifecycle** — an `adr` is published with status `proposed`. **No operation in this contract
  accepts one**, and no skill may call one that appears to: acceptance happens in review and never by
  the author (ADR-0001 §4). `policies/authority-defaults.yaml` treats KB acceptance as an authority a
  skill does not hold, which is the same principle as this package's review independence and its rule
  that an author may not close their own finding.
- **Side effects** — `kb-publish`. Idempotency key derived per runner-contract §5 from the artifact
  hash, so republishing an unchanged artifact after a restart is a no-op success.

### `linkCodeEvidence`

```text
linkCodeEvidence(record: KBRecordRef, evidence: CodeLocation[]) -> Result<KBRecordRef>
```

- **Inputs** — `evidence` entries are `common#/$defs/code_location`: repository, revision, path,
  optional symbol and line range. The revision is mandatory, which is what makes the link survive a
  later edit.
- **Outputs** — the updated record ref.
- **Failure modes** — a location whose revision the KB cannot resolve is refused rather than stored
  as a dangling pointer. Moving a line number does not create a new link or invalidate an existing
  one, because links bind to revision plus symbol, not to a line alone (release scenario 9).
- **Side effects** — `kb-publish`.

### `requestImpactAnalysis`

```text
requestImpactAnalysis(project: ProjectRef, query: ImpactQuery) -> Result<ImpactReport>
```

- **Inputs** — a subject (a symbol, a public contract, a document, a decision) and the scope to
  consider.
- **Outputs** — an `ImpactReport` listing affected records and code locations **with an explicit
  coverage statement**: what the analysis covered, what it could not, and how current its graph is.
- **Failure modes** — a stale or partial graph produces an explicit coverage limitation, never a
  confident-looking empty answer (release scenario 14). Unavailable analysis returns unavailable; a
  caller that needed it stops rather than substituting its own guess at consumer counts.
- **Side effects** — none. Read-only.

### `linkPullRequests`

```text
linkPullRequests(source: PullRequestRef, kb: PullRequestRef) -> Result<PairedPRLink>
```

- **Inputs** — the source-repository PR and the paired KB PR.
- **Outputs** — the `PairedPRLink` with both refs, the link state, and the KB PR's current check
  status.
- **Failure modes** — see §4. A link that cannot be established is reported, not assumed.
- **Side effects** — `kb-publish` and, where the link is written back onto the source PR,
  `pr-comment`. Both are remote effects under runner-contract §5.
- **Availability** — optional. Where no KB integration is configured, a shipping skill populates
  nothing and does not fail; the paired-PR path is exercised only when a KB is present.

### `proposeLesson`

```text
proposeLesson(lesson: LessonArtifact) -> Result<KBProposalRef>
```

- **Carries** `schemas/lesson.schema.json`.
- **Inputs** — the lesson, its supporting evidence references, and any lesson it supersedes.
- **Outputs** — a **proposal** ref. `proposeLesson` proposes; it does not publish.
- **Failure modes** — a lesson with no resolvable supporting evidence is refused. A successful
  routine run that produced no new knowledge proposes nothing; inventing a lesson to have an output
  is release scenario 23.
- **Authority** — publication requires explicit authorization or a charter grant covering
  `publish-lesson` (`common#/$defs/grantable_action`). "Ship happened" is not permission to rewrite
  project knowledge (plan §7.1, ruling `entrypoint-phase-operation-split`).
- **Side effects** — `kb-draft`. `kb-publish` only on the authorized promotion step.
- **Learning runtime** — under the opt-in `learning` profile, a review pattern promoted to a
  guardrail and a lesson the runtime confirmed both arrive here as `candidate` proposals and
  nothing more. A ledger status such as `active` or `confirmed` is a count the runtime kept, not an
  authorization, so it never reaches `kb-publish` on its own (ruling
  `learning-drafts-not-publishes`).

---

## 3. Centrality (release scenario 21)

A KB write stays central (ruling `central-kb-owns-project-artifacts`, ADR-0001 §1). No operation in
this contract, and no skill calling one, may create or
extend a documentation tree inside the application repository — no `docs/`, no `CONTEXT.md`, no
`plans/`, no ADR directory, no `.scratch/` artifact store.

What the working repository may contain is fixed and small (plan §1.2): source, tests, a KB locator,
the package pin, and the necessary host/CI wiring.

Transient run material — parallel-agent notes, sandbox output, checkpoints — lives in the
runner-owned workspace, not in the repository and not in the KB. Sanitized durable receipts are
published to the KB afterwards.

`ak validate` fails a skill whose outputs name a repository path where a KB operation belongs; the
corresponding eval case asserts that no application-local docs tree appears.

---

## 4. The paired-PR requirement (release scenario 22)

Preserved exactly as stated in plan §8 and reaffirmed by ADR-0001 §6, including what it is **not**.
The authority split is the model: the KB owns git-backed decisions and reviewed history, the runner
owns command authorization and receipts, and neither claims the other's surface.

1. A source PR links to its associated KB PR through `linkPullRequests`.
2. A **source merge event** — delivered by the runner as an `event` artifact
   (`adapters/runner-contract/CONTRACT.md` §6) — activates the existing KB merge coordinator. The
   package activates the coordinator; it does not reimplement it.
3. The coordinator still honors the KB's own checks, branch-protection rules, all related source
   dependencies, and retry and idempotency rules. Activation never bypasses a KB check.
4. **This is not an atomic cross-repository merge.** No operation here makes the source merge and the
   KB merge succeed or fail together, and no skill may describe it as though it did.
5. **A blocked KB merge stays visible and retryable.** It is reported with its blocking reason and
   remains in a retryable state. It is never reported as complete, never closed to make a ship
   summary read cleanly, and never silently dropped because the source side merged.

The state a skill reports after a source merge is the state the read-back observed: source merged,
KB merge pending or blocked with its reason. A ship report that says "shipped" while a paired KB
merge is blocked is a false completion.

---

## 5. Known limitation

The seven operations contain no atomic claim primitive: two runs writing the same KB record
concurrently are serialized by the KB, not by this interface. This is recorded rather than patched
with an eighth operation. In practice the gap is covered by runner-contract §5 — a `kb-publish` key
derived from the artifact hash makes a concurrent duplicate a detectable conflict at read-back rather
than a silent overwrite, and a changed input hash under a reused key refuses. A skill that needs
exclusive access to a KB record requests it from the runner, which owns serialization; it does not
implement locking in its body.

---

## 6. Backends: how a bundle reaches a knowledgebase

A **backend** is one knowledgebase implementation's binding of §2: the commands each operation
runs, and what that knowledgebase can and cannot do. The package ships none and names none. Each
backend is one document, and a bundle carries at most one (ruling `kb-backend-bundled-at-build`).

### Where it lives and how it reaches the bundle

`adapters/knowledgebase/backends/<id>.md`, named by the install's `knowledgebase.backend` (§1).
The skills that perform these operations load `references/knowledgebase-backend/REFERENCE.md`,
which carries the rules every backend obeys and sends a skill to
`references/knowledgebase-backend/BACKEND.md` beside it for the commands. As written, `BACKEND.md`
is the unconfigured statement: every read `unavailable`, every write refused, never a write to the
working repository (§3). That is what a bundle with no backend carries. With one configured,
`ak build` emits the backend's document at `BACKEND.md`'s place in the bundle, so no skill body and
no link changes (`BUNDLED_BACKENDS` in `src/packaging/install.ts`, read by `planBundle`). The
document's relative links are resolved from `backends/`, and what they reach is bundled like any
other dependency.

The directory is the registry. A backend is added by adding its document: no row here, no catalog
entry and no schema names one, so a downstream tree binds its knowledgebase with a new file and an
install key, and edits nothing the package owns. The document is checked like the rest of
`adapters/`: its links must resolve, its ruling citations must name rows that exist, and it must
pass the model-routing denylist.

### What a backend document states

It is written for the agent that loads it mid-task, in the terms of §2.

1. **The locator.** How a command finds the knowledgebase from the working directory, and what an
   operation returns when it cannot: `unavailable` for a read, a refusal for a write.
2. **Each operation's commands.** One entry per operation in §2. An operation the document does
   not map refuses with `needs-input` naming the gap, and is never approximated with a
   neighbouring command.
3. **Results.** How each command's exit status and output map onto
   `common#/$defs/operation_status`, the empty result and the coverage limitation, so that a
   project with no records, an unreachable knowledgebase and a partial answer stay three results.
4. **The kinds it writes.** Which of the nine it can write. A kind it cannot write is refused with
   `needs-input` and never written as a neighbouring kind. ADR-0001 §3's assignment of kinds to
   skills applies on top of it and is not widened by it.
5. **Draft and publish.** Which writes draft (`kb-draft`) and which publish (`kb-publish`). For a
   write it can only draft, the result says drafted and the calling skill reports a draft, never a
   publication; §4's paired-PR honesty is the same rule for the merge.
6. **The project record.** Where it comes from, stored or derived, and each field's source when it
   is derived (§2).
7. **Run artifacts.** Where the backend stores them, or that it stores none. With no store,
   `publishArtifact` under a `run-artifact` placement does not publish: the result says so and the
   skill reports the artifact unpublished. What the document does instead, if anything, such as
   linking the artifact's digest from a page, links material kept outside the working repository's
   tracked tree and never creates a store inside it (§3).
8. **Credentials.** How the operator's environment supplies any credential, and that no command
   carries one on its command line.

A backend that cannot honour a rule of §2–§4 says so in its document and refuses the affected
operation; it does not narrow the rule. Nothing in §0–§5 names a backend or depends on one.

---

## 7. Testing

Tests this adapter owns, in `tests/adapters/` and `tests/scenarios/`, except items 13–15, which are
in `tests/packaging.test.ts`:

1. **No local docs tree** — for every skill whose outputs are project-derived, a fixture run leaves
   the working repository free of any documentation directory (scenario 21).
2. **No tenth kind** — a publish naming a `kind` outside the nine is refused, and `ak validate` fails
   a skill declaring one.
3. **Emission-table conformance** — not enforced. ADR-0001 §3 is prose, so nothing checks that a
   skill publishes only the kinds it assigns, or that a skill absent from it publishes no KB
   document. `schemas/skill.schema.json` holds a tagged output to the nine kinds and no further
   (`AUTHORING.md` §4.1).
4. **An ADR is proposed, never accepted** — publishing an `adr` yields status `proposed`, and no
   operation or skill path reaches acceptance (ADR-0001 §4).
5. **Scope, not path** — a publish carrying a computed KB path rather than a scope is refused
   (ADR-0001 §7).
6. **Unavailable KB refuses, never falls back** — with no KB configured, `kb-write` operations refuse
   and no repository file is created.
7. **Empty is not an error** — `readContext` against a project with no records returns an empty
   result, and the calling skill stops rather than proceeding on invented context.
8. **Coverage limitation surfaces** — a stale impact graph produces an explicit limitation in the
   report and in whatever artifact consumes it (scenario 14).
9. **Publish idempotency** — republishing an unchanged artifact after a simulated restart performs no
   second remote effect; a changed artifact under a reused key refuses (scenario 20).
10. **Paired-PR honesty** — a blocked KB merge is reported blocked and retryable, and the ship report
    does not read as complete (scenario 22).
11. **Lesson restraint** — a successful routine run with no new knowledge proposes no lesson
    (scenario 23); an unauthorized promotion of a proposed lesson is refused (plan §7.1).
12. **Rollback independence** — rolling back a published skill revision leaves the supporting lesson
    and evidence history intact (scenario 24), because lessons are KB pages with supersession and
    skills are package files.
13. **The unconfigured statement is the default** — with no `knowledgebase:` key, the bundle carries
    `BACKEND.md` as written, and the summary line says so (§6).
14. **A configured backend replaces the slot and nothing else** — its document is emitted at
    `BACKEND.md`'s published path with its links rewritten, the build record names it, and the
    skill bodies are byte-identical to an unconfigured build (§6).
15. **A backend is attached and documented** — naming one while the adapter is unattached, or with
    no document under `backends/`, is an error, and the bundle keeps the unconfigured statement
    (§1).
