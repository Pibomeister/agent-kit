# pstack → agent-kit: an in-depth adaptation report

**Sources analyzed:** `github.com/backnotprop/pstack` (mirror of `cursor/plugins/pstack`, plugin version 0.15.9, author Lauren Tan / poteto) and `github.com/Pibomeister/agent-kit` (catalog version 0.1.11, pre-release, 140 of 141 catalog entries at status `authored`). Both read in full from fresh clones: every pstack SKILL.md, all 23 playbooks, the principle library, scripts, agents, automations and guide; and agent-kit's AGENTS.md, catalog.yaml, all seven super skills, autopilot (SKILL.md + skill.yaml + checkpoints.md), all 8 protocols, and the nearest analog skills (bakeoff, pov, ultraqa, babysit-pr, compound, wayfind).

---

## 1. Executive summary

pstack and agent-kit are answers to the same question — *how do you trust agent-written code?* — built from opposite ends.

- **agent-kit answers with authority.** Its spine is containment: an invocation law, immutable hash-checked charters, runner-validated grants, two independent supervisor seats, a deterministic authority check, frozen decision cards, and a six-field escalation. Nothing moves without provenance. The system's center of gravity is *who may decide*.
- **pstack answers with evidence.** Its spine is operational rigor: playbook-driven execution, per-role multi-model fan-out, swarm verification keyed to commit SHAs, append-only decision trails audited against transcripts, hourly self-audit ticks, and a 24-name principle library the agent must cite when it decides. The system's center of gravity is *how you prove it worked*.

The two systems barely overlap in their strongest material. That is the opportunity. agent-kit's autopilot is a rigorous **decision machine with no engine**: it governs checkpoints beautifully but says almost nothing about the operational mechanics of actually driving a queue of PRs — owner lifecycles, stuck-lane detection, merge frontier discipline, verdict validity under rebases, decision trails, stand-down semantics. pstack's autopilot-full/autopilot-stack playbooks are exactly that engine, but their authority model is prose ("the operator's full-autonomy grant") where agent-kit has real machinery.

The recommendation in one sentence: **keep agent-kit's authority envelope exactly as it is, and port pstack's operational layer into it as new protocols, references, and playbooks — starting with the six autopilot mechanisms in §6.**

Section 6 is the concrete plan for `ak:autopilot`. Section 7 is the full skill gap map. Section 8 is what *not* to import (pstack's model-slug routing directly violates agent-kit's enforced no-model-routing doctrine, and there is a better substitute).

---

## 2. pstack's architecture: why it works

pstack is one sticky "mode" skill (`poteto-mode`, 159 lines) plus ~45 leaf skills. Its design has five load-bearing ideas.

### 2.1 The mode is a router, not a procedure

`poteto-mode/SKILL.md` does not contain a workflow. It contains a **trigger table**: two dozen "when X → skill Y" rules ("Contested design → the interrogate skill before shipping"; "Any prose surface → the unslop skill. Your reply is a prose surface."; "Any PR-status request → the Babysit playbook"). Below the triggers sits an inline **principles index** — 24 named principles, each one line naming *when it applies*, each a pointer to a leaf `principle-*/SKILL.md` of 20–35 lines.

Two details make this work in practice:

1. **Citation duty.** "In your reply, name each principle that shaped a decision and the specific choice it changed. Cite only principles whose leaf SKILL.md you read this session." Principles are not vibes; they are addressable, and the agent must account for which ones it used. The guide (docs/guide/08-principles.md) teaches users to steer agents mid-task *by principle name*.
2. **Playbook steps are copied verbatim into the todo list**, and "a step you choose not to do stays in the list with a one-line `skip: <reason>`." The checklist is the contract; deviation is visible.

### 2.2 Multi-model diversity is the verification signal

Nearly every pstack judgment skill fans out across **model families** (defaults: `claude-opus-5-5-max`, `gpt-5.6-sol-max`, `grok-4.7-xhigh-fast`):

- **interrogate** — one reviewer per model, identical prompt and rubric; "the adversarial signal comes from model diversity, not assigned personas." Consensus (2+ models) is the highest signal; a lead-judgment step buckets findings into act on / consider / noted / dismissed, with an agreement map.
- **arena** — N candidates attempt the same task; a rubric is derived *before* candidates run; a cross-judge from a different family ranks blind; the winner becomes the **base** and the best parts of the losers are **grafted** in, then the synthesis is verified. Not "pick a winner" — pick a base and graft.
- **architect** — parallel design sketches from multiple models, synthesized before implementation.
- **swarm** — general fan-out primitive: coverage partitions, races, gauntlets; each worker gets its own writable output; measurement briefs name exact SHAs and method.
- **show-me-your-work** — ends every run with a **cross-model review of the decision trail itself**: "spawn a subagent on a different model family from the one that did the work. Self-review is not a substitute."

Model choice is externalized into a **settings file** (`~/.agents/pstack-models.md`) written by a `setup-pstack` skill that detects available models, offers a budget ladder (unlimited/large/medium/small → max/xhigh/high/medium effort), validates every slug, and rewrites the file idempotently. Skills read role lines (`interrogate reviewers`, `swarm workers`, `hardest tasks`) and fall back gracefully.

### 2.3 Evidence discipline is operationalized, not exhorted

- **blast-radius** defines an explicit evidence ladder: *you said so < file:line < walked the failure < ran a script against the real code < reproduced it in the running app*. Each safety claim must say which rung it reached. "A blast-radius writeup that sounds right is worthless. Don't hand back the writeup. Find the one or two facts the whole thing depends on and prove them by running code."
- **benchmark-checklist** vets any measured number through seven questions: name the limiter, was every side tuned like production, does the arithmetic break physical limits, did errors get counted, does it reproduce (≥5 interleaved runs, median and range), does it matter end-to-end, and *did the work even happen* (lazy code produces numbers for work never done). A claim without a named limiter is reported **inconclusive**.
- **tdd** is deliberately pragmatic: failing test first only when a cheap, real test path exists; "prefer no new test over a bad test"; if no failing-before evidence could be shown, the final response must say why.
- Every poteto-mode reply must carry "every claim with its evidence or its label in the same sentence. Measured, inferred, or guess. Never hand the human a check you could run."

### 2.4 Autonomy runs on trails, ticks, and side-effect accounting

This is the material most relevant to `ak:autopilot` — detailed in §6. The short version: every autonomous worker keeps an append-only `decisions.tsv` (show-me-your-work) and a `children.tsv` (its subagents with expected runtimes); a root supervisor runs an **audit tick every hour** armed via `/loop`, re-reads the playbook *from trunk* at each tick (`git show origin/main:...`) to catch its own drift, and **counts only side effects as progress** — commits, pushes, PR/check deltas. A lane that passes its expected runtime with no side effect is declared stuck, stood down, and replaced *at once*, without waiting for a polite return.

### 2.5 The harness-portability layer

Every skill that spawns subagents carries a "Other harnesses" stanza mapping Cursor's `Task` to Claude Code's `Agent`, OpenCode's `task`, Codex's `spawn_agent`, with explicit rules for degraded environments ("If your harness has no subagent tool, run each role yourself, one after another"). Transcript locations, skill folders, structured-question tools, and missing companion skills (`deslop`, `control-cli`, `/loop`) each get a named fallback. This is why the mirror works across five agents — the portability is *in the prose*, systematically, not in code.

---

## 3. The philosophical fork (and why it doesn't block adoption)

| | pstack | agent-kit |
|---|---|---|
| Trust basis | Verification depth + model diversity + audit trail | Authority containment + provenance + fail-closed adapters |
| Independence means | Different model families, same prompt | Runner-attested separate dispatches; diversity deliberately *not* model-based |
| Autonomy granted by | Prose: "the operator's full-autonomy grant" | Hash-bound charter + standing grant + sensitive_grants entries |
| Verification unit | Swarm verdict at a head SHA, patch-id rule for reuse | Receipts: command + exit status + digest + revision |
| Failure posture | Detect stuck lanes by side-effect silence; replace fast | Block the checkpoint; escalate exactly once; never backfill a seat |
| Prose discipline | unslop (33 numbered rules), bro, technical-writing | references/prose-quality (a reference, not an enforced surface) |
| Learning loop | reflect (transcript → skill edits), correct (mistake-class elimination) | compound + evidence-gate (lesson admission control) |

The one true conflict is **model routing**. agent-kit stripped all model selection and enforces the stripping with `ak validate` (AGENTS.md: "No model selection, pricing, provider config, effort ladder, escalation tier or routing dependency appears anywhere in this catalog"). pstack's superpower — adversarial signal from model diversity — is built on exactly that.

The resolution is not to import slugs. It is to import **the diversity requirement as a seat attribute**: agent-kit already declares supervisor seats "independent" and lets the runner bind who fills them. Add "diverse" as an attestation the runner can make (e.g., seats bound to different providers/families where the host supports it), and write the *consumers* (review panels, verdict swarms, trail reviews) to require a diversity attestation rather than naming models. Where the host cannot attest diversity, the protocol degrades to a stated-confidence result — fail-closed, the agent-kit way. §6.5 and §8 develop this.

---

## 4. Head-to-head: poteto-mode autopilot vs `ak:autopilot`

This is the section you asked for. First the honest strengths on each side, then the gap list.

### 4.1 What `ak:autopilot` has that pstack doesn't

- **Real authorization.** Charter with recomputed hash; phase operations reached only under runner-validated grants (`policies/invocation.yaml`); sensitive actions only via human-approved `sensitive_grants` entries; merge and deploy *never* on a grant by default. pstack's "operator's full-autonomy grant" is prose an agent interprets; agent-kit's is a verifiable artifact.
- **The frozen decision card + dual independent seats + deterministic authority check.** "Agreement between the two seats is necessary and never sufficient." pstack has nothing comparable; its root swarm verdict is the closest thing and it is one layer, not three.
- **The escalation shape.** Six fields (NEED / OPTIONS / TRIED / DEFAULT / CHARTER / BLOCKED), exactly one escalation per block, no re-dispatch "in the hope of agreement," named cause (seat failure ≠ disagreement). pstack escalations are unstructured.
- **A curated always-escalate list** (product forks, public contracts, auth/tenancy/payments, irreversible data, third fix cycle on one finding…). pstack's "Always-pause list" exists but is thinner.
- **Fix-cycle accounting.** "The third cycle on one finding is not authorized." pstack caps babysit loops but not per-finding.
- **Resume semantics.** Restart record + charter re-hash; every prior ruling treated as done. pstack's session-pickup is a transcript-mining playbook — useful, but not a proof.

### 4.2 What pstack's autopilot playbooks have that `ak:autopilot` lacks

Read autopilot-full, autopilot-stack, orchestrate, babysit, and shipping as one system. The mechanisms, in order of value to agent-kit:

**(a) Owner-per-PR lifecycle with a defined ownership envelope.**
Each PR gets one owner agent that carries the *whole* loop: build, first push within ~15 minutes, PR opened **ready, never draft, before self-proof** (so URL, decisions, and checks form a durable trail from the start), self-proof on the real artifact, skeptical bot-comment triage, deslop/no-comments passes, rebase policy, babysit to green, and the merge itself. The owner reports a **code-ready head SHA**, and again a **merge-ready head SHA** when parallel lanes finish. `ak:autopilot` drives phases but has no concept of a per-PR owner with an early-trail obligation; work appears at checkpoints rather than flowing through an owned lifecycle.

**(b) Verdicts keyed to SHAs, with a patch-id reuse rule.**
"A round starts at the owner's code-ready head SHA and at each later push that changes the PR's patch." A verdict is only valid for the patch it verified; a rebase that preserves patch-id keeps the verdict, any other new head voids it. This is the single most portable idea in the whole playbook. agent-kit already binds receipts and verdicts to revisions — but has **no rule for when a rebase preserves or voids a verdict**, which is the everyday case in stacked-PR work. The patch-id rule is a cheap deterministic check (`git patch-id`) that slots directly into evidence-gate thinking.

**(c) Swarm verification lanes as the merge gate.**
Before any merge: parallel independent verifiers aggregate to one verdict, with named lanes — re-run the gates at that SHA; **prove the load-bearing behavior live on the real surface**; audit the diff (distrusting the PR body) as 2+ review lanes each with one focus; and a **regression lane against trunk** that runs the same scenario on current trunk. "The live lane is the floor, and a verdict without it is not clean." Findings go back to the owner in **one fix-forward batch**, each behavior finding demanding a red test covering *every site with the same defect*, and each defect is added to the next round's review brief. agent-kit's super-review + super-verify cover the gates and the panel, but there is no *live behavioral lane* obligation inside autopilot and no trunk-regression lane; ultraqa is adversarial QA but is a separate human-started command, not wired into the autonomous verdict.

**(d) The audit tick.**
The root arms `/loop 1h` ("never leave the cadence to memory or lossy completion notifications"), and each tick: re-reads its own playbook **from trunk** and fixes its own drift; probes every owner with a generic liveness check; collects decision trails; and runs the stuck test. agent-kit's runner holds budgets and a ledger, but there is no defined supervisor heartbeat, no self re-read of governing instructions (charter immutability protects the *charter*; nothing protects the *procedure* from drift), and no stuck definition.

**(e) Side-effect-only progress accounting + fast replacement.**
"Count only side effects as progress: commits, pushes, PR or check deltas, and store reports. Treat a lane that errors, or that passes its expected runtime without a side effect, as stuck. Stand it down and dispatch a replacement at once. Do not wait for a polite return." Plus `children.tsv`: every subagent registered with ID, expected runtime ("at least the longest past run of that kind"), and state, so the stuck test extends to grandchildren. agent-kit has caps and ledgers but no liveness semantics — a stalled worker is indistinguishable from a slow one.

**(f) Operator interaction protocol.**
Three small rules with big effect: **state-then-wait** ("when the operator asks for the plan to be stated, deliver the statement and stop; execution starts only on the explicit go"); **operator-named items stay with the operator** (marked items stop at merge-ready for a human click even under full autonomy); and **zero-writes stand-down** (a stop reaches every owner immediately as a no-writes order, briefs held until release). `ak:autopilot` has cancellation ("always available") but no graduated hold semantics and no per-item human reservation.

**(g) Stack topology discipline (autopilot-stack).**
One linear base-branch stack as the deliverable when the operator withholds merge authority: the **root is the only topology writer** (owners push only their own branches and report tip/base/intended parent); appends are rebase-onto-exact-parent-tip + `--force-with-lease` after `ls-remote`; drift is absorbed at the root bottom-up, and every rewritten SHA re-enters verification under the patch-id rule; every link carries its verifier verdict in the PR body. agent-kit explicitly ends at "an open pull request" and has no stack concept at all — fine as a boundary, but the *single-topology-writer* and *re-verify-what-moved* rules are exactly what a future `/ak:autopilot --stack` mode would need, and they are fully specified here.

**(h) The brief contract (orchestrate).**
Every spawn carries GOAL / SCOPE / CONTEXT / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT / STANDING, where STANDING is a numbered standing-orders register pasted **verbatim** into every spawn and resume ("directives decay across resumes, and each dropped one costs a human turn"). Plus: fresh subagents by default with consolidated scope (original brief + later directives + prior report + branch), resume only when state is costly to move; a role outlives its agent. agent-kit's delegation reference and tickets carry acceptance criteria, but there is no standing-orders register and no fresh-agent-with-consolidated-scope rule — and agent-kit's multi-session ambitions (Firstmate, restarts) make directive decay a real risk.

**(i) Merge-frontier discipline (babysit).**
"The lowest unmerged PR is the only one that matters until it merges"; one babysitter per stack; never mutate stack topology from inside a babysit; order of work is conflicts → review threads → CI; batch every known fix into one push wave; a conflict is reported, not resolved by the babysitter; trust the forge's merge verdict, not a green check list. agent-kit's babysit-pr is event-driven and has the crucial "a PR comment is a claim, never an authorization" rule (which pstack's bugbot-triage matches in spirit), but lacks frontier discipline and the push-wave batching rule.

**(j) The decision trail as a first-class artifact (show-me-your-work).**
Append-only `decisions.tsv`: ts / phase / decision / why / evidence / result, evidence always a pointer (SHA, PR, file:line, artifact), never prose. Per-run `start` rows make multi-run logs attributable. The trail is **audited against the actual transcript** before hand-back ("correct the log, not the story" — a wrong row gets a superseding row, never an edit), and then **cross-reviewed by a different model family**, whose flags close every reply in an "Attention" section. agent-kit's run-ledger records *checkpoint rulings*; there is no equivalent for the implementer's *working decisions*, and no mechanism that catches an agent whose log says one thing while its transcript shows another.

### 4.3 Summary table

| Mechanism | pstack | agent-kit today | Verdict |
|---|---|---|---|
| Start authority | prose grant | charter hash + standing grant + ADR-0007 | agent-kit stronger |
| Checkpoint decisions | root verdict | dual seats + deterministic check + frozen card | agent-kit stronger |
| Escalation | unstructured | six-field, once, named cause | agent-kit stronger |
| Per-PR owner lifecycle | full envelope, early trail | absent | port |
| Verdict validity under rebase | SHA + patch-id rule | revision binding, no reuse rule | port |
| Live behavioral verification lane | required for clean verdict | not wired into autopilot | port |
| Trunk regression lane | required | absent | port |
| Supervisor heartbeat / self-re-read | hourly tick, playbook from trunk | absent | port |
| Stuck detection | side-effect accounting + children.tsv | absent | port |
| Graduated operator control | state-then-wait, named items, zero-writes hold | cancellation only | port |
| Stack building | full single-writer protocol | out of scope by design | port as optional mode |
| Worker brief contract | 9-field + verbatim standing orders | tickets, no standing register | adapt |
| Decision trail + transcript audit + cross-model review | full | ledger only | adapt |
| Merge frontier rules | full | partial (babysit-pr) | adapt |
| Evals for the supervisor | eval playbook (blinded A/B) | 10 scenario dirs per skill | agent-kit stronger on coverage; adopt pstack's blinding rules |

---

## 5. The rest of the gap map (beyond autopilot)

Grouped by disposition. Effort estimates assume agent-kit conventions (SKILL.md + skill.yaml + catalog entry + evals).

### 5.1 Port nearly as-is (high value, low doctrine conflict)

| pstack skill | What it is | agent-kit gap | Notes |
|---|---|---|---|
| `show-me-your-work` | append-only decision trail + transcript audit + cross-model review | Ledger covers rulings, not working decisions | Becomes a **protocol** (`decision-trail`) invoked by super-build, autopilot, wayfind. The transcript-audit step is novel and cheap. |
| `benchmark-checklist` + `principle-explain-the-number` | 7-question vetting of any measured number | Nothing vets perf claims | Becomes a reference loaded by super-verify when a receipt carries a number; "no limiter → inconclusive" is a schema-ready rule. |
| `blast-radius` | evidence ladder + prove-the-one-fact for risky diffs | super-scout explicitly refuses verdicts; nothing owns "what could this break" | New model-invoked skill or a super-review lane. The 5-rung evidence ladder generalizes beautifully into evidence classification. |
| `correct` | eliminate recurring agent-mistake classes at the highest structural level (architecture > types > lint > test > docs), prove each check fails on a real past mistake, keep a rule↔enforcement table | compound captures lessons; nothing *structurally eliminates* mistake classes | Complements compound: compound captures, correct enforces. The "happened twice = a class" and "prove it fails on a real past mistake" rules are the portable core. |
| `tdd` (pragmatic version) | red-first only when a cheap real test path exists; "prefer no test over a bad test"; final response must name failing-before evidence or say why not | protocols/tdd is stricter and more absolute | Adopt pstack's *reporting* rule into agent-kit's protocol (it already has recorded-alternative-verification). Small edit, real honesty gain. |
| `no-comments` / Comment Sicko | adversarial comment-deletion subagent with a keep-list and MUST KILL reshape flags | Nothing | Optional standalone skill; the keep-list exceptions are well-specified. Low priority but cheap. |
| `unslop` + reply discipline | 33 numbered AI-tell rules; every claim labeled measured/inferred/guess | references/prose-quality exists but nothing makes *the reply itself* a governed surface | Adopt the claim-labeling rule into AUTHORING.md §8 and the skills' reply contracts. The numbered-rule-id trick (stable ids other skills cite) is worth copying for prose-quality. |
| `figure-it-out` | designs a bespoke rigor-scaled playbook when none fits: falsifiable done-predicate, rigor level biased high, hypothesis loop per unit, trail woven through | wayfind maps long work into tickets but doesn't design *verification-first bespoke workflows* | Merge into wayfind as a "bespoke run" mode, or standalone. The rigor-level framing ("rigor is gates and artifacts, not try harder") fits agent-kit's vocabulary perfectly. |

### 5.2 Adapt (high value, needs translation into agent-kit's model)

| pstack skill | Translation |
|---|---|
| `interrogate` (multi-model adversarial review) | super-review already has a panel of specialist seats. Add pstack's **synthesis discipline**: consensus weighting (2+ independent seats = highest signal), lone-seat findings weighted lower, explicit disagreement map, and the act-on/consider/noted/dismissed bucketing with one-line rationale per finding. Keep seats role-based; add runner-attested diversity as an optional strengthening. |
| `arena` (bakeoff + graft) | agent-kit's bakeoff returns an evaluation artifact and explicitly does *not* adopt the winner. pstack's graft step (winner = base, best parts of losers grafted in, synthesis re-verified) is the missing second half. Add as an optional `adopt` phase under a build-go grant, never automatic — preserves the doctrine. |
| `swarm` (fan-out primitive: coverage/race/gauntlet + aggregation) | No agent-kit equivalent. This is the primitive autopilot's verification lanes need. Write it as a **protocol** (`fan-out`) naming shapes, per-worker writable outputs, SHA-pinned measurement briefs, and aggregation-to-one-verdict. |
| `how` / `why` / `teach` / `recall` (understanding stack) | super-scout answers one bounded question with a dossier; explain explains. Missing: historical-rationale investigation across external sources (why's MCP-source investigators: issue tracker, chat, observability, error tracking — with an epistemics/confidence framework and null-results-are-findings), and session-context reconstruction (recall's status-tagged brief). `why`'s confidence framework and `recall`'s output contract are the portable parts; the MCP discovery loop fits agent-kit's adapter pattern. |
| `reflect` (mine transcript → route learnings into skill edits) | agent-kit has learn roles + evidence-gate for lesson admission, but nothing that mines the *current session's transcript* with parallel lens reviewers (judgment / tooling / divergent) and synthesizes into concrete skill edits. Add as a `compound-refresh` input lane. |
| `automate-me` | distill a user's working style into a personal `-mode` skill from transcripts. Optional; fun and aligned with "make it yours." Low priority. |
| `create-verification-skill` / `maintain-verification-skill` | generate a project-local skill that drives the real app (launch/doctor/drive/evidence sections, repo-interviewed not user-interviewed). This is the missing bootstrap for the *live lane* in §4.2(c): without a scripted way to drive the app, "prove the load-bearing behavior live" degrades to unit tests. High priority **if** you adopt the live lane. |
| `setup-pstack` (detect env, write config idempotently, validate) | The *pattern* — a setup skill that detects capabilities, confirms with the human, writes one config file, validates, and is safe to re-run — is worth having for agent-kit's runner/adapter configuration. The model-routing content is not portable (see §8). |
| playbooks: `session-pickup`, `pause-safely` | pause-safely (suspend cleanly so work can resume) has no agent-kit counterpart — the restart record covers *crashes*, not *deliberate suspension*. Cheap, useful. session-pickup's transcript-mining complements the restart record for cross-agent handoff (handoff skill exists; this strengthens it). |
| playbooks: `hillclimb`, `perf-issue`, `runtime-forensics`, `trace-forensics`, `visual-parity` | domain playbooks on top of the swarm/benchmark primitives. Worth adding only after the primitives land. |
| `automations/benny` (Slack/issue triage + reproduce bots) | agent-kit has triage + diagnose skills but no packaged automation templates. Nice-to-have reference for how pstack ships "dormant" setup material (FOR_AGENTS.md + templates + example configs). |

### 5.3 Skip (conflicts or already covered)

| pstack item | Why skip |
|---|---|
| Per-role model slug config (`pstack-models.md` content, effort ladder) | Violates agent-kit's enforced no-model-routing doctrine. Substitute: diversity *attestation* (§6.5). |
| `poteto-agent` wrapper subagent | Cursor-specific routing target; agent-kit's roles + runner binding already cover seat identity. |
| `bro` | one-liner joke skill ("restate plainly"). Fold into prose-quality if wanted. |
| `technical-writing` | overlaps references/prose-quality; adopt unslop's numbered rules there instead. |
| `make-bot-ui` | Cursor-specific. |
| `typescript-best-practices` | a style sheet; agent-kit's packs cover this space by semantics. |
| `/loop`-specific mechanics | host feature, not skill content; reference it as an adapter capability the way autopilot already treats event-delivery. |
| `orch.ts` / `watch-pr` scripts (6.5k lines TS) | agent-kit's runner + ak CLI already own this layer. Mine them for *semantics* (stuck policy, forge verdict vs green checks), not code. |

---

## 6. Concrete plan: bringing `ak:autopilot` up to par

Ordered by dependency and leverage. Each item names the agent-kit artifact it touches, per your conventions (protocol / reference / skill section / schema / eval).

### 6.1 Verdict validity: the patch-id rule *(start here — smallest, most load-bearing)*

Add to `protocols/evidence-gate` (or a new `protocols/verdict-validity`): a verdict or receipt binds to a head SHA; a later head **reuses** the verdict iff `git patch-id` of the change is unchanged (rebase onto moved trunk keeps it; any patch change voids it); a voided verdict re-enters verification before the run may advance. Specify exactly when merge-prep rebases are allowed relative to lanes (pstack: "merge prep never comes before a round's lanes start, and ends with a rebase onto current trunk right before the merge" + `git merge-tree` cleanliness check + CI-config-path drift check).

**Evals to add:** rebase-with-identical-patch reuses verdict; rebase-with-changed-patch voids; trunk drift in CI-config paths forces re-check.

### 6.2 The verification round: swarm lanes inside autopilot

New protocol `fan-out` (the portable core of pstack's swarm): shapes (coverage / race / gauntlet), one writable output per worker, SHA-pinned briefs, aggregation to one verdict, no verdict without the **live lane** (behavior proven on the real surface the change touches) and the **trunk-regression lane** (same scenario on current trunk; if trunk lacks the feature, gate the added behavior and the awaited end state instead of pretending parity). Wire it into autopilot's readiness checkpoint as the evidence source, and add the **fix-forward batching rule**: all proven findings return to the implementer in one batch, each behavior finding demands a red test covering every site with the same defect, and each defect joins the next round's review brief.

Note this *uses* agent-kit's existing strengths: lanes produce receipts (super-verify format), the panel reads the diff (super-review), the round's verdict is a decision card. You're adding lanes and validity rules, not a second pipeline.

### 6.3 The owner lifecycle and the early trail

Extend autopilot's workflow (or add a `pr-owner` role) with pstack's ownership envelope, translated:

- PR opened **ready, before self-proof** — the durable-trail rule (URL + decisions + checks exist from minute ~15).
- Owner reports `code-ready <sha>` and later `merge-ready <sha>`; every push that changes the patch starts a new round (6.1 decides what carries over).
- Owner keeps a `decisions.tsv` per the new `decision-trail` protocol (6.4) and a `children.tsv` registering each dispatched subagent with expected runtime (basis for 6.6's stuck test).
- Rebase policy: first rebase before the code-ready report; then only at merge prep, on a `merge-tree` conflict, or on CI failure caused by trunk drift. Publish with `--force-with-lease` after `ls-remote`, own branch only — and force-push stays a sensitive action, so the charter needs a `sensitive_grants` entry for it or it escalates. This is a clean example of pstack mechanics slotting *under* agent-kit authority.

### 6.4 The decision trail protocol

New protocol `decision-trail` (from show-me-your-work): append-only TSV, evidence-is-a-pointer, per-run `start` rows for multi-run attribution, end-of-run **audit against the transcript** (correct the log, never the story; wrong rows get superseding rows), and a **second-seat review of the trail** whose flags appear in the run report's "Attention" section. In agent-kit terms: the trail is worker-attested evidence, so per your doctrine it never lifts an autonomy ceiling — it's for auditability, and the transcript audit is what makes it trustworthy. Invoked by super-build (per ticket), wayfind (per run), and autopilot (per owner).

### 6.5 Diversity as attestation (the model-routing substitute)

Where pstack says "different model family," agent-kit should say: the runner may attest two seats **diverse** (separately dispatched *and* bound to different backends/families where the host exposes that). Consumers: review panels (interrogate-style synthesis), fan-out verdicts, trail reviews. Without a diversity attestation, the checkpoint still works — two independent seats per your existing rule — but the run report marks the verdict `single-family` where the charter requires diversity. This preserves AGENTS.md's stripping (no slugs anywhere in the catalog) while recovering pstack's empirical signal that *different models catch different real bugs* (stated explicitly in blast-radius step 6 and interrogate step 4).

### 6.6 The audit tick and stuck semantics

Add to autopilot (and the runner contract): a supervisor heartbeat on a cadence the charter sets, armed through the host's loop/event mechanism (fail-closed: no loop adapter → guided mode names it). Each tick:

1. Re-read the governing procedure (this skill + checkpoints.md) and reconcile — the procedural analog of your charter re-hash. pstack re-reads *from trunk*; agent-kit should re-read *from the bundle at the recorded version*.
2. Probe each owner; **count only side effects as progress** (commits, pushes, PR/check deltas, store reports).
3. Run the stuck test over the owner list and every `children.tsv`: expected-runtime exceeded with zero side effects ⇒ stand down and replace at once; a stall never proves or drops the work.
4. End the tick only when no delegated work remains.

**Evals:** silent-worker replacement, stalled-replacement replacement, tick ends only when drained, heartbeat absent → guided mode.

### 6.7 Operator control: state-then-wait, named items, graduated hold

Three small additions to autopilot's SKILL.md and the charter schema:

- **state-then-wait:** a request to state the plan or protocol is never a go; execution starts on the explicit go. (Cheap; prevents a whole class of false starts.)
- **operator-named items:** the charter may mark items `operator-review`; those stop at merge-ready regardless of other grants. (You have per-action sensitive_grants; this is the per-*item* analog.)
- **zero-writes hold:** a stop order reaches all owners as an immediate no-writes hold, distinct from cancellation; release resumes. Cancellation stays always-available and terminal; the hold is the reversible middle state you currently lack.

### 6.8 Stack mode (optional, later)

If stacked delivery matters: port autopilot-stack as a charter option. The portable rules: root is the sole topology writer; append = rebase onto exact parent tip + force-with-lease + retarget base; drift absorbed bottom-up at the root with per-link re-verification under 6.1; every link carries its verdict in the PR body; owners never merge. Your "merge and deploy are never granted by default" doctrine already implies this mode is the natural fit for agent-kit — autopilot-stack is the *more conservative* of pstack's two autopilots.

### 6.9 Suggested sequencing

1. **6.1 + 6.4** — verdict validity + decision trail. Pure protocol work, no new authority, immediate auditability payoff.
2. **6.2 + 6.3** — verification rounds + owner lifecycle. The engine.
3. **6.6 + 6.7** — heartbeat, stuck semantics, operator controls. The reliability layer.
4. **6.5** — diversity attestation, once the runner can attest it.
5. **6.8** — stack mode, when multi-PR programs arrive.
6. Then the §5.1 ports (blast-radius, benchmark vetting, correct) as standalone skills feeding the lifecycle.

Each step ships with evals in your existing per-skill scenario format, and pstack's **eval blinding rules** (no eval vocabulary anywhere the candidate can see, organic prompts, judge blind to provenance, grade chain-following from transcripts not self-report) are worth adopting into AUTHORING.md §9 wholesale — your eval coverage is broader than pstack's, but their blinding discipline is stricter.

---

## 7. What to consciously *not* take

1. **Model slugs and the effort ladder.** Enforced-stripped in agent-kit for good reasons (hosts differ; slugs rot). Take the *diversity requirement*, not the configuration.
2. **The prose-grant authority model.** pstack's "operator's full-autonomy grant plus the root's clean verdict is the merge authorization" is exactly the failure mode agent-kit's charter machinery exists to prevent. Never relax sensitive_grants to match pstack's convenience.
3. **Sticky-mode breadth.** poteto-mode routes *everything* (prose, PRs, benchmarks, bot comments). agent-kit's deliberate lifecycle-of-seven with hard boundaries is cleaner; add pstack's triggers selectively to the skills that own them rather than building a super-router.
4. **Cursor-isms.** `poteto-agent`, cloud agents, `/loop`, watch-pr — treat as host capabilities behind adapters, as agent-kit already does with Firstmate.
5. **The lowercase-irreverent voice.** pstack's persona is part of its charm and its brand; agent-kit's neutral, contract-precise register is part of *its* trust model. Import mechanisms, not mannerisms.

---

## 8. Appendix: inventories

### pstack (v0.15.9) — 46 skills + 2 agents + 1 automation pack

- **Mode:** poteto-mode (23 playbooks: investigation, bug-fix, perf-issue, hillclimb, runtime-forensics, trace-forensics, feature, refactoring, prototype, visual-parity, authoring-a-skill, eval, babysit, shipping, autonomous-run, orchestrate, autopilot-full, autopilot-stack, session-pickup, pause-safely, multi-phase-plan, worktree-cleanup, opening-a-pr)
- **Understanding:** how, why (7 source playbooks + epistemics), teach, recall, blast-radius
- **Design/build:** architect, arena, swarm, tdd, typescript-best-practices, figure-it-out
- **Review/verification:** interrogate, show-me-your-work, benchmark-checklist, create-verification-skill, maintain-verification-skill, no-comments
- **Prose:** unslop (33 numbered rules), technical-writing, bro
- **Meta/learning:** reflect, correct, automate-me, setup-pstack
- **Principles (24):** laziness-protocol, foundational-thinking, redesign-from-first-principles, attack-the-premise, subtract-before-you-add, minimize-reader-load, outcome-oriented-execution, experience-first, exhaust-the-design-space, build-the-lever, model-the-domain, boundary-discipline, type-system-discipline, make-operations-idempotent, migrate-callers-then-delete-legacy-apis, separate-before-serializing-shared-state, prove-it-works, fix-root-causes, sequence-verifiable-units, test-behavior-not-implementation, explain-the-number, guard-the-context-window, never-block-on-the-human, encode-lessons-in-structure
- **Agents:** poteto-agent, comment-sicko. **Automation:** benny (Slack issue triage + reproduce-and-fix). **Scripts:** orch.ts store CLI (~2.8k lines, tested), watch-pr (~2.4k lines, tested), check-plan.mjs.

### agent-kit (v0.1.11) — 36 skills, 8 packs, 8 protocols, 34 roles, 7 references, 30 schemas

- **Lifecycle:** super-align, super-bound, super-scout, super-build, super-verify, super-review, super-ship; **supervisor:** autopilot
- **Standalone (22):** codebase-design, verify, visual-edit, compound, compound-refresh, ideate, pov, bakeoff, doc-review, receiving-review, diagnose, improve-architecture, doubt-driven, simplify, research, source-driven, deprecate, explain, triage, strategy, product-pulse, writing-skills
- **Primitives:** prototype, handoff, wait-what, wayfind; **Operational:** babysit-pr, ultraqa
- **Protocols:** phase-operations, consensus-plan-gate, tdd, apply-findings, review-delta, worktree-ownership, attach-pack, evidence-gate
- **Evals:** 36 skill scenario dirs (autopilot alone has 10: charter checkpoints, disagreement→one escalation, green-CI≠merge, seat never backfilled, third-fix-cycle stops, guided mode, resume re-hash, …)

---

*Report compiled from full reads of both repositories at the versions noted above. File paths cited inline (`skills/poteto-mode/playbooks/autopilot-full.md`, `skills/autopilot/references/checkpoints.md`, etc.) are stable entry points for verifying any claim here.*
