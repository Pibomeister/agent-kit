# ADR-0015 — The council: a blind veto seat on an approving pair

**Status:** Accepted.
**Date:** 2026-10-30.
**Authority:** the captain's council design of 2026-10-20 and seat map of 2026-10-24, the owner's
selection of D4 A and D5 A on 2026-10-27, and the rule-1 council that settled D4 and D5 on
2026-10-30. The decision log with the requested and answering model for each peer is kept outside
this repository, with the operator's records.
**Prior art read:** ADR-0007, ADR-0013, ADR-0014, `schemas/charter.schema.json` `supervisors`,
`schemas/decision.schema.json`, `adapters/runner-contract/CONTRACT.md` §3.

## Context

Two independent supervisor seats judge each runner checkpoint. When they agree, the runner accepts
the agreement in the same call. Two seats can share a blind spot, and the owner asked for a council:
the charter's two seats plus a third seat that sees the same packet blind and can stop an approval.
All three must agree. There is no majority, no reconcile round and no tie-breaker.

The charter schema says there is no third seat, and the decision schema says there is no third
judgment. Both rules exist so that a tie goes to a human and never to a tie-breaker. A council must
not weaken them.

Two questions were open. D4: which seats are the primary pair. D5: whether the council adds a route
for ticket approval.

## Decision

**D4 A.** The council's two primary seats are the charter's own two supervisor seats, judged through
the existing path. The operator's private council configuration names only the blind veto seat and
its ordered substitute chain.

**D5 A.** The council adds no route for ticket approval. Ticket approval stays where the charter and
`policy:invocation/bound.run` put it.

**The veto is a refusal-only side record.** It is not a third supervisor seat and not a third
judgment:

- It is opt-in. A charter turns it on with `council.blind_veto: required`. Without that block,
  nothing changes.
- It runs only when the pair agrees on the approving option, and before the runner accepts that
  approval.
- It judges the same frozen packet as the pair, with no judgment in its input.
- It is stored on the card apart from the two judgments. The decision record keeps exactly two.
- A missing, unavailable, non-independent or non-approving veto turns the approval into one
  escalation, with `charter_rule` `runner:council-veto`. The veto never breaks a tie and never
  approves alone.
- A substitute in the chain is tried only when a launcher fails to start, exits non-zero or returns
  no valid answer. A valid answer is never replaced.
- The veto seat must be independent of both primary seats and of every excluded actor, by the same
  lineage rule as CONTRACT.md §3.

**Outbound data.** A council seat may run on another host. The council sends only what the caller
supplied: the runner's frozen packet, or the card and the named context files for `ak council run`.
There is no automatic screening. The gate refuses the whole payload, and never redacts, when a
context path matches the deny-list, the payload exceeds its size cap, or a credential pattern matches.
A context path is checked as given and as it resolves, and the cap counts the exact bytes a seat
receives. `ak council run` passes a launcher only a small base set of environment names and the
names its roster entry lists.

**`ak council run`** asks one question outside a runner. It reads an owner-only roster, asks the
pair, asks the veto when the pair approves, and writes a record of each seat's choice, its requested
and served model labels, and the outcome. The record grants no authority. It approves no
checkpoint, ticket, merge or deploy.

## Not built

The v3 supplemental delegation, its signature verifier, its charter-hash binding, council merge,
per-category veto seats and a runner acceptance transaction. They need runner and host work that
does not exist, and they widen authority.

## Consequences

- `schemas/charter.schema.json` gains the optional `council` block. `supervisors` keeps exactly two
  seats and `tie_breaker_allowed: false`.
- `ak runner serve` gains `--council-config`. The runner gains `veto` and `vetoDue`, and `decide`
  refuses an approving pair that the veto did not clear.
- `ak council run` is a new command. It is not a lifecycle entrypoint and starts no phase.
- ADR-0014 composes without conflict: a veto escalation is a human wait like any other refusal, and
  the unattended policy never turns a wait into an approval.
- The invocation law and ADR-0005 are unchanged.
