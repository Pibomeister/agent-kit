# ADR-0007 — Firstmate may start autopilot under a standing grant

**Status:** Accepted.
**Date:** 2026-10-01.
**Authority:** the captain's explicit decision to run crewmate engineering work through autopilot,
relayed by Firstmate after the ENG-4133 trial. This amends the source invocation law's human-only
start rule for autopilot alone.

## Context

The original law makes every user-invoked skill human-started. A captain can approve a charter for
recurring crewmate work, but Firstmate still cannot start autopilot for the crewmate. Requiring a
new typed `/ak:autopilot` command per task defeats the standing delegation. A worker brief or a
plain-language claim of approval cannot replace that command: the worker could write either one.

The stock Firstmate home already supplies ordinary task briefs, separate crewmate dispatches,
status lines and steering inboxes. The runner supplies the missing durable authority and evidence
boundary. No Firstmate patch or special delivery mode is part of this decision.

## Decision

Autopilot remains a user-invoked skill. Its public `run` entrypoint has authority
`explicit-or-standing`: a human slash command starts it, or Firstmate starts it after the runner
validates a standing grant. No other U skill gains this authority.

A charter may contain one `standing_grants` entry with `covers: autopilot.start` and
`controller: firstmate`. The charter is active, immutable, outside worker write scope, and bears an
explicit human approval bound to its content hash. The standing-grant reference also names that
hash and the run id. The runner checks both, persists `start_authority` in its private restart
record, and only then lets the crewmate enter the autopilot workflow. A phase grant, a task brief,
or a model assertion cannot manufacture a standing start.

After the start, every phase still needs its own runner-validated grant and fresh evidence. The
runner dispatches two supervisor seats separately and excludes the implementer, author and spec
approver from decisions where the contract requires it. Firstmate remains the outer supervisor;
ordinary worker children never fill those seats. Sensitive grants, merge, deploy and out-of-charter
work remain human decisions.

## Consequences

- The ENG-4133 trial charter did not approve a standing start or runner capabilities. It cannot be
  silently upgraded; a new captain-approved charter is required.
- Stock Firstmate may pass the runner socket and worker token through an ordinary brief. The first
  autopilot step reads the runner's `start_authority` before doing phase work.
- A runnerless host keeps the existing explicit slash-command path and guided checkpoint stops.
- The runner's state and gate evidence stay outside every worker worktree and Git common directory.
  Host write isolation still has to be enforced; a shared unrestricted account is not provenance.

Related: ADR-0003, ADR-0004, `policies/invocation.yaml`, `schemas/common.schema.json`,
`schemas/charter.schema.json`, `adapters/runner-contract/CONTRACT.md`.
