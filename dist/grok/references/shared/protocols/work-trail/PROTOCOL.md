# work-trail

A work trail is the implementer's account of the working decisions it makes on one ticket, one
stretch per implementer seat, audited after the commit by a seat that is not the implementer.

## When to use

`super-build` follows it for every ticket it builds, for each implementer it seats and for the
audit once the ticket is committed. A later fix run keeps new stretches and gets its own audit.

## Not for

- Not evidence. A trail and its audit lift no ceiling, close no finding, replace no receipt and are
  attached to no checkpoint card (ruling `work-trail-is-account-not-evidence`).
- Not a gate. No gate record is written; a missing trail is reported, and nothing is refused for it
  (ruling `work-trail-is-account-not-evidence`).
- Not a review and not verification. The audit compares the trail with what the run left behind. It
  does not judge the change, and it cannot replay the run.

## Invoked by

`super-build` alone, for each ticket it builds. No other skill, no phase operation and no role
invokes this protocol, and no human starts it. A protocol holds no authority of its own and never
widens the authority it was called with (ruling `entrypoint-phase-operation-split`).

## Inputs

- The ticket ([`schemas/ticket.schema.json`](../../schemas/ticket.schema.json)) and its hash, and the run's id; per stretch, its
  starting revision, seat and order.
- Scratch space from the runner, outside the checkout, and the knowledgebase adapter.
- For the audit: the committed revision, the ticket, the diff, the commits, the receipts
  ([`schemas/verification.schema.json`](../../schemas/verification.schema.json)) and the implementer's report. Never a transcript.
- The shapes [`schemas/trail.schema.json`](../../schemas/trail.schema.json) and [`schemas/trail-audit.schema.json`](../../schemas/trail-audit.schema.json), and
  [an example stretch](../../templates/trail.example.json).

An absent input fails closed: nothing is guessed, and nothing stops the build
(ruling `work-trail-is-account-not-evidence`). No ticket id or hash, or no scratch space: the
stretch is reported missing. No knowledgebase adapter: the build has already failed at its
receipts, and no trail step is reached. A publish that fails or cannot be read back: the record is
reported with its location, its hash and the error, and is not sent again. A missing audit input:
the audit is unavailable, and the report names what is missing.

## Workflow

Stretch record id: `<ticket-id>.<r>.<n>`, where r is the first 12 hex digits of the stretch's
`source_revision.revision` and n is its order among the ticket's stretches, counted from 1 across
the run and never reused. Audit record id: `<ticket-id>.<r>`, where r is the first 12 hex digits of
the audited revision. The kind is not in the id: the knowledgebase files a run artifact as
`run:<run_id>/<schema>/<id>`, so the two never collide. Both ids must fit
`common#/$defs/artifact_id` (at most 128 characters); a ticket id too long for that (over about 115
characters) maps to outcomes that already exist: the stretch is reported missing, and the audit is
unavailable because its packet cannot be handed over.

A stretch is known by its ticket, starting revision and order, an audit by its ticket and audited
revision, so a later fix run publishes beside the earlier records, never over them. An unchanged
republish does nothing; changed content under a published id is refused, reported and stops nothing.

The implementer, while it works (ruling `work-trail-is-account-not-evidence`):
1. On each working decision, a choice the ticket leaves open and the implementer settles (one
   approach over another, how a criterion is read, where the scope stops, an approach given up),
   write its entry when the decision is made, not at the end. The entry holds its id, when it was
   written, the decision, the alternatives considered, why, the pointers to its evidence and the
   result, and the id of any entry it supersedes.
2. Give evidence as a pointer, never as prose. A pointer names a file of the ticket's commit or a
   line of one, a commit of the ticket's branch, or a receipt of the run, and never anything else,
   a web address or a transcript included.
3. Keep every secret, credential, token and piece of personal data out of the stretch: where an
   entry needs one, write where the value lives, never the value.
4. Before returning the report, take such a value found in an entry of the stretch out of that
   entry in place, and write in it that a value was removed and where the value lives. This is the
   one case in which an entry is edited.
5. Otherwise correct a wrong entry with a new entry that supersedes it, never by editing or removing
   it. Keep entry ids unique within the stretch, and name as superseded only an entry that exists.
6. Write entries at decision points, not for every action, and in an empty stretch write why; an
   empty stretch that says why is valid. No count of entries is ever grounds for anything
   (ruling `numeric-heuristics-are-guidance`).
7. Still write and return the closing report, with a pointer to the stretch.

The build, for each ticket, in this order (ruling `work-trail-is-account-not-evidence`):
1. Before seating an implementer, form its stretch's id; one that does not fit is reported missing.
2. Prepare the stretch's record outside the checkout, in the runner's scratch space, never in the
   ticket's worktree or any tracked directory, and take the record's hash as prepared.
3. Hand the implementer this protocol and the record's location. Only the implementer it was
   prepared for writes to it afterwards. A replacing implementer is handed no earlier stretch.
4. Carry the stretch by reference: never open its entries and never rewrite its record. Handle it by
   its location, its hash, and the kind and the id its record names.
5. Wait for the ticket's commit, its receipts, its ticket result and its gate record when there is
   one; none of those waits on the trail steps that follow. A ticket that stops before its commit
   gets no audit and has no stretch published, and the report says so.
6. Tell each stretch's state. Missing: the record is gone, or its hash is still the prepared hash.
   Unpublished: the hash has changed and the knowledgebase holds no `trail` record of the run with
   that id and hash. Published: the knowledgebase holds one.
7. Publish each unpublished stretch as written, when its record names kind `trail` and its id,
   through `publishArtifact` as a run artifact of the run, and keep the ref it returns. A record
   that names another kind or id is reported and not sent.
8. Form the audit id from the committed revision, and seat the trail auditor once.
9. Hand the auditor the audit id, every stretch of the ticket by reference with its state and hash,
   and the ticket, the diff, the commits, the receipts and the implementer's report. No transcript.
10. Before sending the audit, confirm that the returned record names kind `trail-audit` and that
    id. A record that does not is reported and not sent.
11. Publish the audit as returned, through `publishArtifact` as a run artifact of the run, and keep
    the ref it returns.
12. Report what Outputs lists.

## Hard gates

Gate: the wall (ruling `work-trail-is-account-not-evidence`). No seat whose output is a finding, a
receipt, a verdict or a signoff input is shown the trail, the trail audit or the attention list.
That covers the check seats, the verifier, the review panel, the challenger that QA signoff plans,
and any seat added later. A context that has seen a trail, a trail audit or an attention list sits
in no such seat for the same change. The context that seats them holds the wall, is not one of them,
and carries nothing it saw of a trail, a trail audit or an attention list into a ruling it writes, a
synthesis or verdict it sets, or a packet it hands a seat the wall covers, for the same change.

Gate: the trail auditor is never the implementer nor anyone in its lineage; if the seat cannot be
filled independently, the audit is unavailable, reported so, never backfilled, and blocks nothing
(ruling `work-trail-is-account-not-evidence`).

Gate: a trail is never a file in the project's tree (ruling `work-trail-is-account-not-evidence`).

Gate: a refused record is reported, and neither repaired nor sent again.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The trail says the suite passed, so the receipt can wait." | A trail is the implementer's account. A description of a green run is not a receipt, and the trail replaces none. | Run the check, record its receipt, and point the entry at the receipt. |
| "I will write the entries at the end, once I know how it came out." | An entry written after the result is a story fitted to it, and the alternatives that were live at the time are lost. | Write each entry when the decision is made. If the call changes, a later entry supersedes it. |
| "That entry is wrong; I will correct it in place." | An edited entry hides the call that was made. Taking out a secret is the one edit allowed. | Write a new entry that supersedes it. |
| "The reviewer would find the attention list useful." | A seat that has read the trail, the audit or the list judges the implementer's story along with the change. | Show none of them to a seat the wall covers. |
| "No independent seat is free, so the implementer can audit its own trail." | An implementer that checks its own account finds what it expects to find. | Report the audit unavailable. It blocks nothing. |
| "The audit flagged nothing, so the change is sound." | An empty attention list is evidence of nothing. The audit compares the trail with what the run left behind and never judges the change. | Rely on the receipts and the review, and report the audit's result as it stands. |
| "The knowledgebase refused the stretch; a small fix and a resend will get it in." | A refusal means changed content under an id already published, and a repaired record is the build's version, not the implementer's account. | Report the refusal and send nothing again. |

## Outputs

One `trail` record ([`schemas/trail.schema.json`](../../schemas/trail.schema.json), id `<ticket-id>.<r>.<n>`) per stretch and one
`trail-audit` record ([`schemas/trail-audit.schema.json`](../../schemas/trail-audit.schema.json), id `<ticket-id>.<r>`) per audited
revision, each published through the knowledgebase adapter's `publishArtifact` as a run artifact of
the run and carried by the ref it returns, with its hash: an account and its audit, never evidence
and never a file in the project's tree (ruling `work-trail-is-account-not-evidence`).

The build's report names each stretch's id and state, with the reason for an unpublished one; the
audit's ref, the revision it audited, its result and its items, or why it is unavailable; and each
refused record. A notice in the audit that something it read holds a secret, a credential, a token
or personal data is repeated as the audit gives it: where the value is, never the value. A secret
noticed in a stretch or an audit already published is reported as exposed, for rotation by whoever
owns it, because the record cannot be corrected.

Whoever reports onward carries the audit's reference unchanged, with the revision it was audited at,
and says so when the head has moved since. The attention list adds reasons to look and never removes
one, and an empty list is evidence of nothing (ruling `work-trail-is-account-not-evidence`).

## Side effects

`scratch-write` for the records the build prepares, and `kb-publish` for the stretches and the
audit. Each publish's idempotency key is derived from the run id, the operation id, the record's
knowledgebase identity and its content hash, and the record is read back before and after the
publish (the Idempotency section of [`adapters/runner-contract/CONTRACT.md`](../../adapters/runner-contract/CONTRACT.md)). No `workspace-write`,
`local-commit` or `remote-push`.

## Stop conditions

No outcome here stops the build (ruling `work-trail-is-account-not-evidence`).

- `complete`: every stretch has a state, and the audit is published or reported unavailable.
- `cap-reached`: the invoking operation's cap was reached. What stands is reported as it stands.
- `failed`: the scratch space could not hold a stretch's record, and that stretch is reported
  missing; or a publish failed or could not be read back, and that record is reported with its
  location, its hash and the error.
- `cancelled`: the runner cancelled the run. Each stretch is reported in the state it was left in.

## Limits

- Stretches per implementer seat, writers per stretch, audits per audited revision: 1 each (gate).
- Record ids: at most 128 characters, `common#/$defs/artifact_id` (gate).
- Entries per stretch: no minimum, no maximum (guidance).
