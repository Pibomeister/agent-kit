# Contract defects

Where a writer reports that following `AUTHORING.md` produced a wrong result.

**`AUTHORING.md` §10 governs this file** — what counts as a defect, the three things an entry
records, and the rule that an open entry blocks its batch commit until the contract owner rules.
Read it there. It is deliberately not restated here: a restatement that drops a clause reads as
complete, and this file is the one place a writer arrives already believing they know the rule.

The file lives at the repository root for one reason. An entry appears in the diff of the very
commit that would otherwise bury it, so readership does not depend on anyone remembering a path.
A contract defect filed inside a commissioned artifact is the failure mode §10 names, and batch 1
produced a worked example of it: a correct diagnosis about §5's `target:`/`path:` key was filed in
a provenance fragment header, §5 was fixed at `abeb94e`, and nothing was obliged to read the report
so nothing retired it. It sat there asserting something untrue about the contract until a reviewer
found it.

An entry is retired by deleting it in the commit that resolves it, with the ruling in the commit
message. Entries are not marked resolved and left in place — a resolved entry that stays is the
same artifact as a stale one. There is no resolved section here, for that reason.

Deleting an entry does not lose it. `git log -- CONTRACT-DEFECTS.md` is the index of every defect
this contract has ever had, and each resolving commit carries the entry it retired along with the
ruling. Read it there before concluding from an empty list that nothing has been found.

---

## Open

### Conversation-map locators cannot cite a captain decision

**The instruction followed.** §5:

> Inventing an `origin:` or `locator:` key on an adaptations row does not substitute: nothing
> reads it. [...] The locator has three forms and the transcript is only one of them. [...]
> `ak validate` admits `G:L<start>[-<end>]` ranges into `research/sources/grok-transcript.md`,
> `plan §<section>` and `arch §<section>` document references, and
> `amalgam <destination> + <destination>` seat pairs [...] Name where the capability was actually
> specified.

**What following it produced.** The GS-004k unavailable-read raise is a captain Q1 decision. It is
not a transcript range, a plan section, an arch section, or an amalgam pair. A locator in any of
the three admitted forms would fabricate a source. Parking the sentence on a donor-sourced
adaptations rationale credits the egm pin. The existing `delegation` conversation-map row can carry
the fact in `note`, and none of the locator forms can name the decision.

**What the correct behavior appears to be.** Admit a locator form for a captain decision, or record
that a `note` on an existing conversation-origin row is the route until that form exists. Until then
a writer cannot cite a captain decision without fabricating a locator or parking the sentence on a
donor rationale.
