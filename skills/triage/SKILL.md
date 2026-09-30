---
name: triage
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:triage`. On any
  other request do not load or follow it; tell the human to type that command. Moves tracker issues
  and external pull requests through the project's configured triage policy: classify, check for
  duplicates and prior rejections, verify the claim, recommend, and apply the outcome the maintainer
  chooses. Use when a human runs /ak:triage over their tracker. Not for a project with no triage
  policy, and not for reprioritizing or reassigning work.
license: MIT
metadata:
  ak_catalog_id: triage
---

Apply a configured issue-state and classification policy. Useful only with a real tracker policy;
cannot silently reprioritize beyond delegated scope.

## When to use

- A maintainer wants to see what in the tracker needs their attention.
- A maintainer wants one issue or external pull request evaluated and moved to its next state.
- A maintainer names a state change directly and wants it applied.

## Not for

- A project whose record carries no triage policy. There is nothing to apply, and roles are never
  invented.
- Reprioritizing, re-scheduling or reassigning work. Priority and ownership are not triage roles.
- Implementing the fix. A `ready-for-agent` outcome produces a ticket for someone else to build.
- A collaborator's in-flight pull request surfaced by discovery. Only external ones are triage work,
  unless the maintainer names one.

## Authority

Authority: `explicit`. A human starts this skill with `/ak:triage`. It may start model-invoked
skills only. Every state change and every close follows the maintainer's direction in this session;
this skill recommends and waits, and never disposes of an item on its own judgment.

## Inputs

- The triage policy the project record's `tracker_policy.policy` names: the category and state
  roles and what each maps to in the system of record. Absent: `needs-input`, asking for one to be
  configured. A role the policy maps onto nothing the tracker operations can write is also
  `needs-input`, naming the role; the tracker contract has no label or comment operation
  (`adapters/tracker/CONTRACT.md` §4), and this skill writes nothing outside it.
- The system of record, decided by configuration and never by reachability
  (`adapters/tracker/CONTRACT.md` §2; ruling `tracker-of-record-falls-back-to-kb`): the bound
  tracker where the project folder binds one and the project record agrees; the knowledgebase where
  there is no binding and the record names it or there is none; `needs-input` otherwise. The chain
  is in the [tracker-of-record reference pack](../../references/tracker-of-record/REFERENCE.md).
- The maintainer's request, in their own words: show what needs attention, look at one item, or
  move one item to a named state.
- The item itself. `readTickets` returns only ref, status, claimant and blocking edges
  (`adapters/tracker/CONTRACT.md` §4), so the body, discussion, author and dates come from the
  maintainer, and a pull request's diff from the repository. This skill reads nothing outside them.
- The repository, for the redundancy check and for verifying the claim.

## Workflow

1. **Check authority.** Continue only if a human started this run with `/ak:triage`. Otherwise stop,
   say that a human starts this skill, and name the command.
2. **Load the policy** and the roles it maps, per [the roles guide](references/roles.md). No
   policy, or a role mapped onto nothing writable: stop with `needs-input`.
3. **Show what needs attention**, when asked: read the system of record with `readTickets` and list
   three buckets, oldest first — never triaged, awaiting evaluation, and awaiting information where
   the reporter has replied since the last notes. Counts and one line per item; let the maintainer
   pick. `readTickets` carries no reporter activity: take it from the maintainer, and where no one
   can supply it, stop with `needs-input` naming what is missing.
4. **Gather context** on the chosen item from the maintainer and the repository (see Inputs); for
   a pull request, fetch its ref. Read earlier triage notes so no answered question is asked again.
   Run two checks: redundancy — is the behavior already implemented, searched by domain concept and
   not by the request's wording, with where you looked; and prior rejection — does it match a
   rejection already recorded, per [the rejections guide](references/rejections.md).
5. **Recommend and wait.** State the category and state you recommend, with reasoning and what the
   codebase shows. Wait for the maintainer's direction.
6. **Verify the claim** in a scratch worktree, leaving the repository as it was. Reproduce a bug
   from the reporter's steps; for a pull request, run its tests or commands on the fetched ref. Report confirmed, with the code path; failed; or insufficient
   detail, which points to `needs-info`. No disposition rests on an unverified claim.
7. **Grill only if needed**, inline and one question at a time, using the host's blocking-question
   tool where one is listed and numbered options in chat otherwise.
8. **Apply the outcome** the maintainer chose, through the policy's mapping. Every text this skill
   writes to the tracker opens with the line `> *This was generated by AI during triage.*`
   - `ready-for-agent`: create an implementation `ticket` from [the brief](assets/agent-brief.md)
     with `createTicket`, and link it from the item with `linkRecord`.
   - `ready-for-human`: the same brief, stating why it cannot be delegated.
   - `needs-info`: [the triage notes](assets/triage-notes.md), with specific questions.
   - `wontfix`: already implemented — point to where it lives and record no rejection; rejected bug
     — explain and close; rejected enhancement — record the rejection per the rejections guide and
     close.
9. **Quick override.** When the maintainer names a state directly, trust it: say in one line what
   will change, then apply it, skipping grilling. Moving to `ready-for-agent` this way, ask whether
   they want a brief written.

## Hard gates

Gate: no policy, no triage. Roles come from the configured policy; a label, state or role the
policy does not map is never invented.

Gate: one item at a time, each recommended and verified before its outcome is applied. A batch close
applies nothing.

Gate: priority, schedule and ownership stay as they are. Reprioritizing or reassigning is refused
and named as outside the triage roles.

Gate: every text written to the tracker opens with the disclaimer line.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "There's no mapping, but `bug` and `enhancement` are obvious — I'll use those." | Invented roles fork the project's vocabulary in its own system of record. | Stop with `needs-input` and ask for the policy. |
| "These thirty stale issues are clearly dead — close them all as wontfix." | A close with no verification and no maintainer direction per item is a disposition this skill cannot make. | Show them as a bucket and take them one at a time. |
| "The reporter's steps look right; I'll mark it ready-for-agent." | An unverified claim makes a brief an agent will build on. | Reproduce it first and report the result. |
| "It's already built, so I'll record it as rejected too." | Recording a built feature as a rejection poisons every later duplicate check. | Point to where it lives; record nothing. |
| "This one matters more; I'll bump its priority while I'm here." | Priority is not a triage role, and a silent reprioritization is out of scope. | Mention it to the maintainer; change nothing. |

## Outputs

- State changes on tracker items, through `updateStatus` as the policy maps each role, carrying the
  triage notes or the closing explanation as the resolution text.
- Implementation `ticket`s (`schemas/ticket.schema.json`) for `ready-for-agent` and
  `ready-for-human`, created in the system of record and linked from the item.
- Rejection records on closed enhancement items, found again by the prior-rejection check.
- This skill publishes no knowledgebase document. In the knowledgebase fallback, its tickets are
  the knowledgebase's `ticket` records and nothing else (ruling `central-kb-owns-project-artifacts`).

## Side effects

`external-fetch`, `process-exec`, `scratch-write`, `tracker-write`, `artifact-write`. The fetch
is a pull request's ref, through the optional `vcs-remote`; without it that item is not verified
and stops with `needs-input`. No `workspace-write`: verification runs in a scratch worktree.

`tracker-write` is a remote side effect. The idempotency key for each write derives from the run,
the operation, the item's stable remote identity and the artifact's hash; the read-back is the
record the write returns, read before the write and confirmed after it
(`adapters/runner-contract/CONTRACT.md`, "Idempotency"). A write whose read-back cannot be performed
is `failed`, never complete.

## Stop conditions

- `complete` — the maintainer's request is answered: the buckets shown, or the chosen item moved to
  its state and read back.
- `needs-input` — not started with `/ak:triage`, no policy, a role mapped onto nothing writable, no
  system of record, reporter activity no one can supply, a pull request whose ref cannot be fetched,
  or the maintainer's direction is awaited.
- `failed` — the system of record is unreachable, or a write's read-back cannot be performed.
- `cancelled` — the maintainer withdrew; nothing further is written.

## Limits

- Items dispositioned per decision: one (gate).
- Roles: the policy's category and state roles only; priority and ownership are out (gate).
- Discovery: external pull requests only, unless the maintainer names one (guidance).
