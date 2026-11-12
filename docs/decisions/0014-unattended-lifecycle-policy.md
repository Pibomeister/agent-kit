# ADR-0014 — An opt-in unattended policy runs the lifecycle; merge is the human gate

**Status:** Accepted.
**Date:** 2026-10-29.
**Authority:** the project owner's decision that runners with no human present run the whole lifecycle
without human gates, that the only human gate is merging the pull request, and that the mode serves any
runner. The specification and implementation were approved under delegated authority by the
supervising orchestrator, not by a human reading the generated artifacts.
**Prior art read:** ADR-0003, ADR-0007, ADR-0008, ADR-0013, `policies/invocation.yaml`,
`src/lifecycle/gate.ts`, `adapters/runner-contract/CONTRACT.md`.

## Context

A human-started phase starts by a typed command, a delegated grant, the standing autopilot grant of
ADR-0007 or a supervisor's bypass grant. A CI job, a scheduled job, a chat bot, a coding-agent
platform or a supervised worker with nobody watching holds none of them honestly. Autonomous ship also
refuses a host-unattested verifier once a seat or grant is recorded, and the runner-attested path that
would lift that refusal does not exist. Such a runner therefore cannot finish the lifecycle at all.

## Decision

A named policy, `unattended`, selected only by explicit opt-in: `AK_LIFECYCLE_POLICY=unattended` in the
runner's environment, or `ak.lifecycle.json` naming it on the repository's default branch. Absent both,
every record, decision and exit status is unchanged. The policy is runner-neutral. Its behaviour is
`references/unattended-lifecycle/REFERENCE.md`; the decisions it rests on are:

- **Start.** align, bound and ship start through the gate tool's `unattended check`; scout, build, verify and
  review were already model-started. A typed command still starts a phase. A bypass grant is refused, so
  a record never carries both authorities.
- **Advance.** A wait for a human answer or approval proceeds with the skill's own recommendation,
  recorded as an unattended advance and never as an approval. A ticket whose class makes a human the
  author is implemented by the agent with its true class, floor and author kind recorded. Every other
  stop, every sensitive action included, still stops.
- **Evidence.** Every gate records the policy and the commands the gate tool ran, with exit status,
  output digest, revision and times. Align, bound and scout gain gates under this policy, recorded
  before the run opens and imported into it with their original times. The pre-ship check requires all
  six earlier phases current and passing. The evidence is worker-attested and labelled so.
- **Trust moves to the merge** (amended 2026-11-11, see below). A host-unattested verifier is a recorded note instead of a refusal; an
  implementer still cannot verify its own work. In exchange, ship-preflight reads the target repository
  live and read-only and refuses unless its default branch requires code-owner review by operator-
  designated human reviewers with stale approvals dismissed and last-push approval, required CI pinned to
  an app, and the independent review check pinned to an app that is not GitHub Actions, with no bypass;
  and unless the runner is a non-admin, non-designated user account. Final ship success needs the posted
  review valid at the pull request's exact head, the head descended from the shipped revision, and the
  disclosure in the pull request text.
- **Independence** (amended 2026-11-11, see below). The independent review is a required check posted from outside the task by a pinned
  app, from the head-bound diff only. The reviewer's canonical `provider/model` identity is stamped from
  operator configuration and the provider's call metadata, never from the review's own text, and must
  differ from every configured author model; the same provider is allowed. This is a deterministic check
  against operator-declared evidence. The catalog names no model, provider or route.

For this policy only, this amends: the invocation law's start rule for align, bound and ship, with the
ordinary-workers clause of ruling `entrypoint-phase-operation-split` and the start-path statements of
`protocols/invocation-authority.md` and the runner contract; the maintainer guide's statement that
worker-attested evidence never lifts an autonomy ceiling; the host-unattested verifier refusal in
super-ship, super-verify, super-review and the verification-evidence reference, an exception to ruling
`closure-requires-independent-verification`; the delegation reference's rule that a human-author class
makes a human the author, an exception to ruling `delegation-class-is-authority-not-finding`; and the
rule that seat independence is never a model identity (`AUTHORING.md` section 7,
`adapters/runner-contract/CONTRACT.md` section 3), for the forge-side review check alone (amended 2026-11-11: the exception now covers the final-ship identity comparison alone, see below). Each rule's
text carries its scoped exception beside it; runner-filled seats and every run outside the policy are
unchanged. Merge and deploy stay outside every policy.

## Consequences

- (Amended 2026-11-11, see below.) A repository without the enforced merge gate cannot finish an unattended ship; the refusal names
  every missing item.
- The forge cannot show that a designated account is operated by a person, that a review used the model
  it reports, or that a fine-grained read credential is read-only. A runner sharing the operator's account
  or credentials does not meet the policy's assumptions.
- A pull request head rewritten after ship-preflight needs a new run; old phase evidence never covers it.
- The signed-issuer and runtime-attested paths are unchanged and not required by this policy.

## Amendment of 2026-11-11 — the trust boundary is a declared run supervisor

**Authority:** the captain's words, relayed by Firstmate as decision 002: "Unattended mode should not
have github requirements at all, that's up to the human." and "unattended mode needs a supervisor". The
specification of ticket `bound-unattended-supervisor-contract` records the ruling that follows from
them: agent-kit holds no forge client and reads no forge.

**What changes.** The decisions "Trust moves to the merge" and "Independence" above, and the
operator setup and consequences that followed from them, are replaced. agent-kit no longer reads the
target repository, its branch protection, its code owners, its review check or its accounts. It no longer
holds a read credential and no longer ships a review workflow template. The command
`unattended review-status` and the `--pr` flag of `record` are removed. The forge-era configuration keys
and identity aliases, the GitHub-only repository resolution and the forge cross-check of the local
default-branch ref are removed too. The identity comparison keeps one scoped exception to seat
independence: the attested reviewer identity must differ, as a string, from every attested author
identity. It is a consistency guard, not proof of model independence.

**What replaces them.**

- **Run supervisor.** The boundary is a named run supervisor: the system that launched the run and watches
  it. It is named by `AK_LIFECYCLE_SUPERVISOR` and declares itself in a JSON file outside the repository,
  named by `AK_LIFECYCLE_SUPERVISOR_DECLARATION`. The declaration states how the supervisor meets six
  obligations. `adapters/supervisor/CONTRACT.md` is the contract, and `schemas/supervisor-declaration.schema.json`
  and `schemas/supervisor-attestation.schema.json` give the shapes.
- **Start.** A human-started phase starts only with a valid declaration. A declaration that is missing,
  relative, inside the repository, unreadable, not JSON or malformed is refused, and the refusal names
  the item.
- **Binding.** `open --ticket` stamps the run with the declaration's name, path and digest. `ship-preflight`
  refuses when the declaration in force differs from the stamp, and every such refusal ends with one
  recovery: open a new run and record the gates again.
- **Final ship.** The supervisor supplies an attestation of its validation gate and independent review at
  one head. agent-kit runs the final-ship checks that `adapters/supervisor/CONTRACT.md` lists. It cannot
  authenticate the attestation.
- **Disclosure.** The sentence names the supervisor and states that agent-kit does not merge.

**Kept.** The start rule for align, bound and ship, advances, worker-attested evidence, the recorded note for
a host-unattested verifier, the refusal of self-verification, the head-bound evidence and the closed run
are unchanged. The run supervisor of this policy is not the checkpoint `supervisor` seat of autopilot,
and no checkpoint rule changes. Merge and deploy stay outside every policy.

**Transition.** A run opened under the policy without a declaration cannot pass ship-preflight. Open a
new run under a declaration and record the gates again. No grace path exists. Firstmate must write its
declaration and attestation files before its runs use the policy.

**Same-user limit.** Containment keeps the files outside the repository. A party that runs as the same
OS user can still write both files, as the bypass grant of ADR-0008 accepts for its own ledger. The
contract states the limit.

**Merge authority.** "Whoever the human authorized merges" means that agent-kit never merges. The merge
is the human gate, and the human may delegate it to a named party.

**Consequences.** A project needs no forge setup to finish an unattended ship, and the policy names no
vendor. The trust that the forge's protections once carried now sits with the supervisor and with whoever
merges. A party that can write outside the repository can forge either file. The contract states that limit.
