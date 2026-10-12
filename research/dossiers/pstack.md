# Research dossier — pstack, the tenth donor

Sources:

- `research/sources/pstack-to-agent-kit-report.md` — the owner's report "pstack → agent-kit: an
  in-depth adaptation report", cited as `R:Lx-Ly`. The copy is byte-identical to the supplied
  file: 301 lines, sha256 `5b87607ca55bd679b4136c06d5d888accf87b6f89e58a323e00cc1f61de93794`. It is
  the local source `pstack-to-agent-kit-report` in `provenance/upstream.lock.yaml`.
- The approved design page, revision 2,
  `~/orca/projects/firstmate/data/agent-kit-pstack-adapt/pstack-adapt-align.rev2.html`, sha256
  `a1217edc42fa9c2b4b5b38890ccf476f718b678dc80cba85c926856df3ccbf62`, cited as "design §N" by its
  own section numbers. Every disposition below is the design's.
- The claims check behind that design,
  `~/orca/projects/firstmate/data/agent-kit-pstack-adapt/claims-check.md`, sha256
  `36dfabd8e58e31596dc8de037a7e165675b00d96e3e5e09cbc5bcaf5007f97e5`, cited as "claims check §X.n".
  It holds the first-hand readings behind the design's claim tables.

The design page and the claims check stay in the run's data folder and are not committed. The
report names models and a model ladder. That text is legal here because `research/` is
denylist-exempt, and this dossier does not repeat it.

Donor files are cited as `pstack@<commit>:pstack/<path>`, with a `#L` anchor where a line matters.
Every path was verified with `git -C .donors/cursor_plugins cat-file -e <commit>:<path>`, and every
anchored line was read at the pin. agent-kit paths were read at `4a790ee0`
(`4a790ee020ed8d76ea6d26354224f69b6a6c5636`), the base of the ticket that adds this file, and their
line numbers are at that revision. A figure the design measured at another revision names it.

This dossier records decisions. It builds nothing: each adoption lands in the ticket that needs it,
with its own provenance row.

---

## 1. The donor

| Field | Value |
| --- | --- |
| Lock id | `pstack` |
| Repository | `cursor/plugins`, https://github.com/cursor/plugins |
| Directory taken | `pstack/` only. No other part of the repository is a source. |
| Commit | `e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a`, committed 2026-10-03T17:06:48-07:00: "refactor(pstack): use bare performance mantras in perf-issue step 2 (#496)" |
| Tree of `pstack/` | `54dfdd87fd191ddda7fce01dd354d220adaeeacc` |
| Manifest | `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/.cursor-plugin/plugin.json`: name `pstack`, version `0.15.9`, author Lauren Tan, license MIT |
| License | `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/LICENSE`: MIT, "Copyright (c) 2026 Lauren Tan". Kept byte for byte as `provenance/licenses/cursor_plugins.LICENSE`. |
| Clone | `.donors/cursor_plugins`, full history, written by `tools/donors/clone.sh` |

Why this pin:

- `cursor/plugins` has no license file at its root. Its root readme ends with a "License" heading
  over the single word "MIT", and its layout diagram shows a `LICENSE` file in each plugin
  directory. So the license that governs pstack is the one inside `pstack/` (claims check §I.3).
- The report read the mirror `backnotprop/pstack` (R:L3-L3). The mirror's `upstream` branch, at
  commit `c0c3f13cc58005cce7f28c1e6d7ccc439867f171`, has the same tree as `pstack/` at the pin. Its
  `main` branch differs in 26 files that the mirror's owner rewrote. The pin is the copyright
  holder's own repository, with no third-party edits (claims check §I.1, §I.5, §I.6).
- The report's paths are mirror-root paths. At the pin each one carries the `pstack/` prefix.
- Upstream moved after the pin. On 2026-10-05 its manifest at `e5a8186` read `0.15.13` (claims
  check §I.4). The pin does not follow it. A re-pin is its own change.

---

## 2. Three facts the design leans on (design §2)

1. **pstack merges on its own verdict.** Its full-autonomy playbook says: "The operator's
   full-autonomy grant plus the root's clean verdict is the merge authorization that babysitting
   alone never has."
   (`pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L9`)
   Here a merge is a human call or a sensitive grant. That is the fork between the two systems:
   the mechanisms come over, and the authority around them does not.
2. **Its patch rule is prose.** `git patch-id` appears in four playbooks and in no script:
   - `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/shipping.md#L9`,
     lines 9 and 13. Line 9 states the rule.
   - `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L8`,
     lines 8 and 9.
   - `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-stack.md#L11`.
   - `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/multi-phase-plan.md#L66`,
     lines 66, 67 and 130.

   A rule that costs one sentence there costs a gate change here.
3. **Its files carry keys a canonical file here may not.** 52 of its 53 `SKILL.md` files set
   `disable-model-invocation: true`. The one that does not is
   `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/setup-pstack/SKILL.md`. Skill
   bodies name a model per role, and that skill writes a per-role model rule outside the repository
   that overrides them
   (`pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/setup-pstack/SKILL.md#L8`).
   Both are stripped on the way in.

---

## 3. Dispositions (design §4)

Every item the report proposes has one class:

- **adopt now**: lands in slice 1.
- **adopt later**: lands in a named later phase.
- **held**: agent-kit already holds it.
- **deferred**: waits on a stated condition. The design labels it "Defer".
- **rejected**: does not come in, for the stated reason. The design labels it "Reject".

The "When" column uses the design's phases (design §10). Slice 1 is the run that adds this
dossier: pstack as a donor, then the work trail. A delivery phase follows it and carries the trail's
attention list to the merge call; no row below is filed under it. "After QA signoff" means after
the sibling QA signoff work lands, because the item lands in the gate or in a skill that work
changes. Phase 2 is prose and protocol work in files the QA signoff design does not name. Phase 3
is the reliability layer and needs runner and charter changes. Phase 4 waits for a runner that can
attest seat diversity. Phase 5 waits for multi-PR programs. Phase 6 takes the small ports, the
adaptations and the playbooks one at a time. Every phase after slice 1 comes back for its own
approval.

The "Item" column starts with the report's section number. Rows 18 and 19 come from items (h) and
(i) of its section 4.2. The other eight items of 4.2 are paired with a section 6 row in the
"Report" column.

| # | Item | Report | Class | When | Design note |
| --- | --- | --- | --- | --- | --- |
| 1 | 6.4 Decision trail | R:L224-L226; R:L126-L127 | adopt now | Slice 1 | As the `work-trail` protocol and a trail auditor seat. Today the implementer's report is written at the end, and the run ledger holds checkpoint rulings only. |
| 2 | 6.1 Verdict validity | R:L203-L207; R:L102-L103 | adopt later | After QA signoff | Narrowed, with its own decision record and ruling (design §7). The strict half is in code today: a rebase that rewrites the reviewed commits voids every record. The reuse half is missing. |
| 3 | 6.2 Fan-out protocol | R:L209-L213 | adopt later | Phase 2 | As a consolidation, and only if two existing callers are rewired in the same change. Today the review panel, the build's check seats and the bakeoff each fan out their own way. |
| 4 | 6.2 Live lane | R:L211-L211; R:L105-L106 | held | — | Held by the verifier seat for every check and surface a ticket declares. Those fields are optional, and making them required is QA signoff's acceptance contract. |
| 5 | 6.2 Trunk-regression lane | R:L211-L211; R:L105-L106 | adopt later | After QA signoff | Missing today. It lands in verification files that QA signoff is changing. |
| 6 | 6.2 Fix-forward batch | R:L211-L211 | held | — | Held by `protocols/apply-findings` and ruling `reviewer-continuity-not-amnesia`. |
| 7 | 6.2 Same-defect sweep | R:L211-L211 | adopt later | Phase 2 | In `protocols/apply-findings`. A site outside the ticket's allowed files becomes a candidate ticket, not an edit. |
| 8 | 6.3 Owner per pull request | R:L217-L220; R:L99-L100 | rejected | — | The `pr-owner` role is rejected: it would be a second supervisor. Its code-ready and merge-ready marks are held by gate records, and QA signoff adds signoff per transition. |
| 9 | 6.3 Ready before self-proof | R:L219-L219 | rejected | — | The gate order here is proof, then publication. The need behind it, an early trail, is met by row 1. |
| 10 | 6.3 Register of children | R:L221-L221; R:L111-L112 | held | — | Held by the child register in `schemas/common.schema.json`, with its wall-clock budget. |
| 11 | 6.3 Rebase policy | R:L222-L222 | deferred | After QA signoff | The sensitive-action half is held: `force-push` and `history-rewrite` escalate without a charter entry. The when-to-rebase half is only worth writing once a rebase can keep a verdict, so it is decided with row 2. |
| 12 | 6.5 Diversity attestation | R:L228-L230; R:L260-L260 | deferred | Phase 4 | Absent on purpose: it amends a deliberate selection, so it needs its own decision record. The report sets the condition: "once the runner can attest it". |
| 13 | 6.6 Audit tick and stuck test | R:L232-L241; R:L108-L112 | adopt later | Phase 3 | As an event the runner delivers and the run handles once, not a loop. Under Firstmate, worker liveness stays Firstmate's. Today the runner has 18 verbs and 15 run states, none a heartbeat or a hold. |
| 14 | 6.7 State, then wait | R:L247-L247; R:L114-L115 | held | — | Held more strictly: a phase starts only on a typed command or a validated grant. |
| 15 | 6.7 Zero-writes hold | R:L249-L249 | adopt later | Phase 3 | An escalation stops writes. A hold that the operator starts, and can undo, is missing. |
| 16 | 6.7 Operator-named items | R:L248-L248 | deferred | Phase 3 | Missing. Low value until a run carries many items. |
| 17 | 6.8 Stack mode | R:L251-L253; R:L117-L118 | deferred | Phase 5 | Until multi-PR programs arrive. It depends on row 2, and force-push stays behind `sensitive_grants`. |
| 18 | 4.2(h) Worker brief contract | R:L120-L121 | held | — | The ticket is the brief, and the immutable charter carries the standing orders. Fresh workers by default is held differently, on purpose: `super-build` resumes the same implementer for rounds 1 to 3 and seats a fresh one for rounds 4 and 5. |
| 19 | 4.2(i) Merge-frontier rules | R:L123-L124 | adopt later | Phase 2 | The push-batch rule, in `babysit-pr`: every push moves the head, and a moved head means verification is redone. Frontier order waits for row 17. |
| 20 | 5.1 `show-me-your-work` | R:L159-L159 | adopt now | Slice 1 | It is row 1. |
| 21 | 5.1 `blast-radius` | R:L161-L161 | adopt later | After QA signoff | As a reference loaded where risk is judged, not as a new entrypoint. `super-scout` refuses verdicts, and nothing owns "what could this break". |
| 22 | 5.1 Benchmark vetting | R:L160-L160 | adopt later | Phase 6 | The questions `packs/pack-perf` lacks join that pack, which already owns measured claims. |
| 23 | 5.1 `correct` | R:L162-L162 | adopt later | Phase 6 | Folded into `compound`, not a new skill. Two rules are new: hold the rule at the strongest level that can carry it, and show the check failing on a real past case. |
| 24 | 5.1 Claim labels | R:L165-L165; R:L52-L52 | adopt later | Phase 6 | As the next stable rule in `references/prose-quality`. The numbered rules are held; the label is not. |
| 25 | 5.1 `tdd` reporting rule | R:L163-L163 | held | — | `protocols/tdd` already demands an observed failing step for every criterion, or a recorded alternative plan, "never a silent exemption". |
| 26 | 5.1 `no-comments` | R:L164-L164 | held | — | `simplify`'s code-quality lens already flags unnecessary comments. No standalone skill; its keep-list may sharpen that lens later. |
| 27 | 5.1 `figure-it-out` | R:L166-L166 | rejected | — | The mode is rejected: a bespoke-run mode would be a second way to run everything. Its core, a done-condition that can fail, is held by a ticket's acceptance criteria and verification path. |
| 28 | 5.2 `interrogate` | R:L172-L172 | rejected | — | Consensus weighting is rejected (section 4, row 8). The rest is held: the review panel exists, and conflicts are kept as conflicts. |
| 29 | 5.2 `arena` | R:L173-L173 | rejected | — | The adopt phase is rejected (section 4, row 9). The rest is held by `bakeoff`. |
| 30 | 5.2 `swarm` | R:L174-L174 | adopt later | Phase 2 | The fan-out of row 3. |
| 31 | 5.2 `how` | R:L175-L175 | held | — | `explain` covers it. |
| 32 | 5.2 `why` | R:L175-L175 | deferred | Phase 6 | The confidence rule and the null-result rule may become a `super-scout` reference. Outside sources come only through adapters, never by vendor name. |
| 33 | 5.2 `teach` | R:L175-L175 | rejected | — | `/teach` is on the deliberately-absent list in `AGENTS.md`. Re-adding it is a design change, not a port. |
| 34 | 5.2 `recall` | R:L175-L175 | deferred | Phase 6 | Its brief's shape, one status tag per thread and a single next move, may sharpen `handoff`. Mining transcripts waits for a host contract that supplies one. Its habit of picking a filler by cost is routing and stays out. |
| 35 | 5.2 `reflect`, `automate-me` | R:L176-L177 | held | — | Held by the learning profile's scheduled roles. No in-session pass is added. |
| 36 | 5.2 Verification-skill authoring | R:L178-L178 | held | — | Held by verification recipes since the verifier seat merged. |
| 37 | 5.2 `setup-pstack`, its content | R:L179-L179 | rejected | — | It is per-role model configuration. |
| 38 | 5.2 `setup-pstack`, its pattern | R:L179-L179 | deferred | Phase 6 | Taken up when install or adapter setup gets a guided command. It needs only the five steps, none of the donor's text. Today `ak doctor`, `ak kb check` and `ak tracker check` do parts of it. |
| 39 | 5.2 `session-pickup`, `pause-safely` | R:L180-L180 | deferred | Phase 6 | The stop rules may join `handoff`. Pickup from a transcript waits for the same host contract as row 34. |
| 40 | 5.2 `hillclimb`, `perf-issue`, `runtime-forensics`, `trace-forensics`, `visual-parity` | R:L181-L181 | deferred | Phase 6 | After fan-out and benchmark vetting, as the report says. Mined one at a time, each with its own provenance row. |
| 41 | 5.2 `automations/benny` | R:L182-L182 | deferred | Phase 6 | Read later as an example of setup material that ships switched off. No bot and no vendor channel enters the catalog. |
| 42 | 6.9 Eval blinding rules | R:L264-L264; R:L147-L147 | adopt later | Phase 2 | Its own ticket: first a measured sweep of the existing cases against the four rules, then the rule text in `AUTHORING.md` §9. Slice 1's own cases follow the rules from day one. |

So 2 rows are adopt now, 13 adopt later, 10 held, 10 deferred and 7 rejected: 42 rows.

The report's sections 5.1, 5.2 and 6 each have rows above, and its section 4.2 adds rows 18 and 19.
Its sections 5.3 and 7 are in section 5 below. With these, every row of the report's sections 5.1,
5.2, 5.3, 6 and 7 has a disposition, as the design says of its own page (design §4).

Where each row lives in pstack:

- Rows 1 and 20: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/show-me-your-work/SKILL.md`.
- Row 2: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/shipping.md#L9`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L8`.
- Rows 3 and 30: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/swarm/SKILL.md`.
- Rows 4 to 7: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L8`.
- Row 8: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L3`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L6`.
- Rows 9 and 11: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L6`.
- Row 10: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L6`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L10`.
- Row 12: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/interrogate/SKILL.md#L9`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/blast-radius/SKILL.md#L38`.
  Both rest on model diversity. The second says: "Different models catch different real bugs."
- Row 13: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L10`.
- Rows 14 and 16: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L5`.
  Row 16 also: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L9`.
- Row 15: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L11`.
- Row 17: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-stack.md#L10-11`.
- Row 18: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/orchestrate.md#L34-50`.
- Row 19: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/babysit.md#L8-12`.
- Row 21: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/blast-radius/SKILL.md`.
- Row 22: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/benchmark-checklist/SKILL.md`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/principle-explain-the-number/SKILL.md`.
- Row 23: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/correct/SKILL.md`.
- Row 24: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/SKILL.md#L111`.
  The label is one of `poteto-mode`'s reply rules. The report's row pairs it with
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/unslop/SKILL.md`, which holds the
  numbered rules and not the label.
- Row 25: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/tdd/SKILL.md`.
- Row 26: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/no-comments/SKILL.md` and
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/agents/comment-sicko.md`.
- Row 27: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/figure-it-out/SKILL.md`.
- Row 28: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/interrogate/SKILL.md#L64`.
- Row 29: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/arena/SKILL.md#L53-61`, the
  graft step.
- Row 31: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/how/SKILL.md`.
- Row 32: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/why/SKILL.md`.
- Row 33: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/teach/SKILL.md`.
- Row 34: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/recall/SKILL.md`.
- Row 35: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/reflect/SKILL.md` and
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/automate-me/SKILL.md`.
- Row 36: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/create-verification-skill/SKILL.md`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/maintain-verification-skill/SKILL.md`.
- Rows 37 and 38: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/setup-pstack/SKILL.md`.
- Row 39: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/session-pickup.md`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/pause-safely.md`.
- Row 40: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/hillclimb.md`,
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/perf-issue.md`,
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/runtime-forensics.md`,
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/trace-forensics.md`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/visual-parity.md`.
- Row 41: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/automations/benny/README.md` and
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/automations/benny/FOR_AGENTS.md`.
- Row 42: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/eval.md#L5-13`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/eval.md#L22`.
  Lines 5 to 13 are its blinding rules. Line 22 verifies the chain from transcripts, not from
  self-report.

---

## 4. What stays out (design §5)

The design holds ten rules fixed (design §3). Each is already written down in the repository:

1. A phase starts on a human's typed command, or on a grant that a supervisor issued and that was
   validated. A worker cannot start a gated phase or write itself a grant. Held in the invocation
   law in `AGENTS.md` and ADR-0003, 0007 and 0008.
2. A protocol or a role holds no authority of its own, and never widens the authority it was
   called with. Held in `AUTHORING.md` section 12 and ruling `entrypoint-phase-operation-split`.
3. Evidence a worker attests about its own work never lifts an autonomy ceiling. Held in the runner
   contract and ruling `fail-closed-adapter-lifts-ceiling`.
4. A seat that cannot be filled independently is unavailable. It is never backfilled. Held in
   rulings `required-lane-failure-is-unavailable` and `missing-supervisor-never-implementer`.
5. A finding is closed only by independent verification bound to the revision. Held in ruling
   `closure-requires-independent-verification`.
6. Merge, deploy, force-push and history rewrite are human calls or sensitive grants. Held in
   `policies/authority-defaults.yaml` and ruling `sensitive-actions-need-approved-charter-entry`.
7. No model is chosen, named or routed anywhere in the catalog. Held in `AGENTS.md` and the
   denylist in `ak validate`.
8. Firstmate is the only outer supervisor. Held in ruling `firstmate-outer-loop-agent-kit-inner`.
9. Project artifacts live in the knowledgebase, not in the repository. Held in ruling
   `central-kb-owns-project-artifacts`.
10. A record counts at the exact tree it was taken on, apart from two gates the code allows on an
    ancestor. A receipt never spans revisions. Held in `src/lifecycle/gate.ts` and
    `protocols/tdd`.

Each item below is in pstack or in the report. None comes in. The first five are the ones that
would each have moved one of the ten rules.

| # | What stays out | Why |
| --- | --- | --- |
| 1 | Merging on a clean verdict | Merge is a human call or a sensitive grant (rule 6). A verdict is evidence for that call, never the call. The report agrees (R:L271-L271). |
| 2 | The never-block-on-the-human posture | Here the approvals are the product. A run that cannot get one stops and says so. |
| 3 | Model names, the effort ladder, `setup-pstack`'s configuration, and the plan checker's demand for a named model | Rule 7. The report agrees: "Take the *diversity requirement*, not the configuration." (R:L270-L270) |
| 4 | A `pr-owner` role (R:L217-L217) | A second supervisor inside the catalog (rule 8). |
| 5 | Committing the trail to the project repository | Rule 9. pstack commits it when the work is ambitious; here it is a run artifact. |
| 6 | Anything placed in `protocols/evidence-gate` (R:L205-L205) | It is the learning runtime's admission gate. The name fits; the job does not. |
| 7 | A pull request opened ready before it is proven (R:L219-L219) | It turns the gate order around. |
| 8 | Consensus weighting in review synthesis (R:L172-L172) | `policies/review.yaml:341` says the synthesis may not "raise a nit's severity because several seats agreed on it". |
| 9 | An adopt phase for the bakeoff (R:L173-L173) | The bakeoff returns an evaluation and stops there by design. Adoption is a build, and a build needs a ticket. |
| 10 | `/teach`, a sticky mode router, a bespoke-run mode (R:L175-L175; R:L272-L272; R:L166-L166) | `AGENTS.md` lists `/teach` and any second run-everything entrypoint as deliberately absent. |
| 11 | `disable-model-invocation` and host keys in canonical frontmatter | `docs/decisions/0003-model-invocation.md`. The packager generates host keys; a canonical file that carries them fails validation. |
| 12 | Copying the orchestration and watcher scripts, or tooling tied to one stacking tool (R:L195-L195) | The runner and the `ak` CLI own that layer. The report says it too: "Mine them for *semantics*". |
| 13 | A fixed count of verification lanes as a requirement | A number used as a gate (ruling `numeric-heuristics-are-guidance`). |
| 14 | The voice (R:L274-L274) | The report's own line: "Import mechanisms, not mannerisms." |

Where each row is in pstack, when it is in pstack:

- Row 1: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L9`.
- Row 2: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/principle-never-block-on-the-human/SKILL.md#L9`.
- Row 3: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/setup-pstack/SKILL.md#L8` and
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/scripts/check-plan.mjs#L138`.
- Row 4: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L3`.
- Row 5: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/show-me-your-work/SKILL.md#L46-48`.
- Row 6 is in the report only.
- Row 7: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L6`.
- Row 8: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/interrogate/SKILL.md#L64`.
- Row 9: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/arena/SKILL.md#L53-61`.
- Row 10: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/teach/SKILL.md`,
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/SKILL.md` and
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/figure-it-out/SKILL.md`.
- Row 11: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/show-me-your-work/SKILL.md#L4`
  is one of the 52.
- Row 12: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/scripts/orch/orch.ts`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/scripts/watch-pr/cli.ts`.
- Row 13: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/scripts/check-plan.mjs#L138-141`.
  The plan checker requires exactly ten lanes, numbered 1 to 10.
- Row 14 is the report's own wording.

---

## 5. The report's skip list and not-take list (design §4)

The design accepts the report's skip list (R:L184-L195) as written, all eight. Their semantics may
be mined; their code is not copied.

| # | Skipped | Report | The report's reason, in short | Status |
| --- | --- | --- | --- | --- |
| 1 | Per-role model configuration and its effort ladder | R:L188-L188 | It breaks the no-model-routing rule. The substitute is diversity attestation (section 3, row 12). | accepted |
| 2 | The `poteto-agent` wrapper subagent | R:L189-L189 | A routing target specific to Cursor. Roles and the runner's binding already cover seat identity. | accepted |
| 3 | `bro` | R:L190-L190 | A one-line joke skill: "restate plainly". It can fold into prose quality if wanted. | accepted |
| 4 | `technical-writing` | R:L191-L191 | It overlaps `references/prose-quality`. | accepted |
| 5 | `make-bot-ui` | R:L192-L192 | Specific to Cursor. | accepted |
| 6 | `typescript-best-practices` | R:L193-L193 | A style sheet. The packs cover that space by semantics. | accepted |
| 7 | `/loop` mechanics | R:L194-L194 | A host feature, not skill content. It is an adapter capability. | accepted |
| 8 | The `orch.ts` and `watch-pr` scripts | R:L195-L195 | The runner and the `ak` CLI own this layer. Mine the semantics, not the code. | accepted |

Where each skipped item is in pstack:

- Row 1: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/setup-pstack/SKILL.md#L8`.
  The report calls the file `pstack-models.md`. The skill writes `pstack-models.mdc` in the user's
  editor rules directory, outside the repository, and no file of either name is in the tree at the
  pin.
- Row 2: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/agents/poteto-agent.md`.
- Row 3: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/bro/SKILL.md`.
- Row 4: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/technical-writing/SKILL.md`.
- Row 5: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/make-bot-ui/SKILL.md`.
- Row 6: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/typescript-best-practices/SKILL.md`.
- Row 7: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/playbooks/autopilot-full.md#L10`.
- Row 8: `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/scripts/orch/orch.ts`
  and `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/poteto-mode/scripts/watch-pr/cli.ts`,
  with their sibling files.

The design accepts the report's not-take list (R:L268-L274) as written, all five.

| # | Not taken | Report | Status | Where this dossier holds it |
| --- | --- | --- | --- | --- |
| 1 | Model slugs and the effort ladder | R:L270-L270 | accepted | Rule 7; section 4, row 3 |
| 2 | The prose-grant authority model | R:L271-L271 | accepted | Rule 6; section 4, row 1 |
| 3 | Sticky-mode breadth: one mode that routes everything | R:L272-L272 | accepted | Section 4, row 10 |
| 4 | Cursor-isms: `poteto-agent`, cloud agents, `/loop`, watch-pr. They are host capabilities behind adapters. | R:L273-L273 | accepted | Skip rows 2, 7 and 8 |
| 5 | The lowercase, irreverent voice | R:L274-L274 | accepted | Section 4, row 14 |

---

## 6. The work trail: what it keeps, changes and leaves behind (design §6)

Slice 1 adopts one mechanism: the decision trail of `show-me-your-work`
(`pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/show-me-your-work/SKILL.md`), as the
work trail and its audit. The anchors below are lines of that file.

Kept from pstack:

- One entry per decision point, not per action (#L40).
- Evidence is a pointer, not prose (#L13).
- A wrong entry is never edited or removed. A newer entry supersedes it (#L52, #L63).
- An audit of the trail, by someone other than its author (#L67).
- "No flags" is a valid value (#L74).
- One trail that other skills route to, so nobody invents a second (#L82).

Changed for agent-kit:

- A run artifact with a schema, not a TSV in the working tree. Published after the receipts, never
  committed. pstack keeps it local by default and commits it when the work is ambitious (#L46-48).
- One stretch per implementer. pstack hands a replacement the same log (#L42). Here a replacement
  is not shown the earlier stretch.
- Audited against what every host has: the diff, the commits, the receipts and the report. pstack
  audits against the transcript (#L57). No host contract here supplies one, so slice 1 has no
  transcript path.
- "A different model family" (#L67) becomes an independent seat, recorded by seat id and by
  whether a runner attested it.
- On for every ticket a build hands out. pstack keeps it for long or unattended work (#L3). The
  design's question 4 was that choice.

Left behind:

- The `disable-model-invocation` frontmatter (#L4).
- The hard-coded session directory, and the transcript path with it (#L57).
- The line that names which model reviewed the trail (#L74).
- The `log.sh` script (#L38,
  `pstack@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a:pstack/skills/show-me-your-work/scripts/log.sh`).
  The semantics come over; no code is copied.

pstack's audit reads the run's transcript. This one has none, so it is a consistency check on what
the run left behind. That is weaker, and the design says so (design §6).

---

## 7. The report's claims, as the design checked them (design §2)

The report's recommendations are the owner's intent. Its factual claims were checked first-hand
(claims check §K, §P). Twenty-five do not hold in full: 6 do not hold, 16 are half right and 3
went stale. Five of the 25 change the design; their rows say "yes".

### Claims that do not hold

| # | The report says | Report | What the tree says | Changes the design? | Claims check |
| --- | --- | --- | --- | --- | --- |
| 1 | Put the verdict rule in `protocols/evidence-gate`, or in a new protocol. | R:L205-L205; R:L103-L103 | `evidence-gate` admits lessons into the learning runtime; the report's own section 3 calls it "lesson admission control" (R:L74-L74). A new protocol could hold the words, but the rule itself is in gate code, so the words alone change nothing. | yes | §K.2.1 |
| 2 | Verdict validity plus the trail is "pure protocol work, no new authority". | R:L257-L257 | True for the trail. False for verdict reuse: what counts as current is held in `src/lifecycle/gate.ts` (`onBranchLine` at line 779, `checkGates` at line 1370), in two schema definitions (`revision_ref` at `schemas/common.schema.json:133`, `invalidates` at `schemas/event.schema.json:152`) and in five written rules, among them `protocols/tdd/PROTOCOL.md:129`. Reuse needs a decision record and a ruling (design §7). | yes | §K.2.2 |
| 3 | The numbered-rule-id idea is worth copying into prose quality. | R:L165-L165 | `references/prose-quality/REFERENCE.md` already numbers its rules 1 to 41, and its line 108 says rule numbers are stable ids. Nothing to port. | no | §K.2.3 |
| 4 | pstack has 46 skills. | R:L280-L280 | 50 skill directories at the pin: 26, plus 24 named `principle-*`. The report's own list (R:L282-L288) names 49 and leaves out `make-bot-ui`. Cosmetic. | no | §K.2.4 |
| 5 | `why` has 7 source playbooks. | R:L283-L283 | Eight, in the `references/sources/` directory beside `why`'s `SKILL.md`. Cosmetic. | no | §K.2.5 |
| 6 | Several cross-references by section number. | R:L18-L18; R:L78-L78; R:L179-L179 | They point one or two sections off. The gap map is section 5, the plan section 6, the not-take list section 7. Cosmetic: the report was read by content. | no | §K.2.6 |

### Claims that are half right

| # | The report says | Report | What is already here, and what is not | Changes the design? | Claims check |
| --- | --- | --- | --- | --- | --- |
| 1 | There is no rule for when a rebase keeps or voids a verdict. | R:L103-L103 | There is a rule, the strict one. A rebase that rewrites the reviewed commits voids every record, because none of them is on the new branch line (`onBranchLine`, `src/lifecycle/gate.ts:779`). What is missing is a rule that keeps a record when the commits are rewritten and the patch is not. | yes | §K.3.1 |
| 2 | A pull request opens ready, before self-proof. | R:L100-L100; R:L219-L219 | That is how pstack works (section 4, row 7). Here it would turn the gate order around: proof comes before publication. | yes | §K.3.13 |
| 3 | Stopping a run means cancelling it. | R:L115-L115 | An open escalation already stops writes and shipping: `escalation_policy` at `schemas/charter.schema.json:225`, with `stop_writes` at line 230 and `stop_shipping` at line 231. A hold the operator starts and can undo is missing. | no | §K.3.2 |
| 4 | Nothing protects the procedure from drift. | R:L109-L109 | A Firstmate binding pins the bundle by content hash (`adapters/firstmate/CONTRACT.md:207`). A run with a runner and no Firstmate has no such pin. | no | §K.3.3 |
| 5 | Review synthesis should weight by consensus. | R:L172-L172 | Conflicting evidence is already kept as conflicting (`policies/review.yaml:338`). Weighting by agreement is forbidden (line 341), and a "dismissed" bucket collides with line 342: a low-confidence security finding is adjudicated, never filtered. | no | §K.3.4 |
| 6 | A graft step is the missing half of the bakeoff. | R:L173-L173 | `skills/bakeoff/SKILL.md:83-85` already selects the strongest base, takes contributions from the other candidates where the result stays coherent, and tries to break the result. It does not adopt the result, on purpose. | no | §K.3.5, §P.8 |
| 7 | A register of delegated work is needed. | R:L112-L112 | The child register exists (`schemas/common.schema.json:439`) and carries a wall-clock budget (`max_wall_seconds`, line 481). A notion of expected runtime and a stuck test do not. | no | §K.3.6 |
| 8 | The ledger covers rulings, not working decisions. | R:L127-L127; R:L159-L159 | Correct. Pointers of kind `transcript` exist (`schemas/common.schema.json:166`), `wayfind` keeps its decisions so far (`skills/wayfind/SKILL.md:89`), and `handoff` marks each decision's source. No trail of working decisions exists, and nothing audits one. | no | §K.3.7 |
| 9 | Session pickup and safe pause have no agent-kit counterpart. | R:L180-L180 | `skills/handoff` covers the continuity record and the resume check. The hold at runner level is missing. | no | §K.3.8 |
| 10 | `unslop` has 33 numbered rules. | R:L73-L73; R:L165-L165; R:L286-L286 | Its rule ids run from 3 to 33, with 4, 6 and 21 absent: 28 rules. | no | §K.3.9, §P.2 |
| 11 | Nothing makes the reply itself a governed surface. | R:L165-L165 | `AUTHORING.md` section 8 (line 923) and `references/engineering-principles` govern parts of it. A measured, inferred or guess label on a claim is not there. | no | §K.3.10 |
| 12 | Nothing mines the current session for lessons. | R:L176-L176 | Under the learning profile, `roles/learn/reflector` and `roles/learn/skill-scout` run on a schedule, across sessions. A pass inside the session is absent. | no | §K.3.12 |
| 13 | Nothing vets a performance claim. | R:L160-L160 | `packs/pack-perf/PACK.md` already requires a baseline and an after-measurement taken the same way, compared against run-to-run variance. It attaches only on a stated budget or a measured problem. Absent: naming what limits the number, counting errors in the measured run, and confirming that the timed region did the work. | no | §P.3 |
| 14 | Nothing prunes comments. | R:L164-L164 | `skills/simplify/references/personas/code-quality.md:24` already flags comments that restate the code or narrate a change, and keeps the ones that record a constraint. | no | §P.3 |
| 15 | Nothing eliminates a class of mistake. | R:L162-L162 | `protocols/evidence-gate` promotes a repeated pattern to a guardrail draft. Holding the rule in a type, a lint or a test, and proving that the check fails on a real past case, are absent. | no | §P.3 |
| 16 | The orchestration store is about 2.8 thousand lines and the watcher about 2.4 thousand. | R:L289-L289 | The two figures use different bases. `orch` (`orch.ts`, `store.ts` and `orch.test.ts`) is 2819 lines with its test and 2185 without. `watch-pr` is 2324 lines without its tests and 3485 with them. | no | §K.3.11 |

### Claims that went stale

| # | The report says | Report | Now | Changes the design? | Claims check |
| --- | --- | --- | --- | --- | --- |
| 1 | Live verification is missing. | R:L138-L138; R:L211-L211 | The verifier-seat merge landed it on 2026-10-05: an independent verifier seat (`roles/verifier/ROLE.md`), recipes, and evidence per surface (`references/verification-evidence/REFERENCE.md`). It applies where a ticket declares checks and surfaces. Those fields are optional, and making them required is QA signoff's acceptance contract. | yes | §K.4 |
| 2 | The catalog is at 0.1.11. | R:L3-L3; R:L291-L291 | 0.1.15 on `main` when the design was written. 0.1.34 at `4a790ee0`, and the ticket that adds this file makes it 0.1.35. | no | §K.4, §Q.1 |
| 3 | 34 roles, 7 references, 30 schemas. | R:L291-L291 | 35, 9 and 33, measured again at `4a790ee0`. | no | §K.4, §Q.1 |
