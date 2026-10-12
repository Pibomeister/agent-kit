# ADR-0010 — A file-backed knowledgebase backend lives in this package

**Status:** Accepted.
**Date:** 2026-10-05.
**Authority:** the owner's choice of "Build file-backed KB (Recommended)" for the question of who
fixes the knowledgebase adapter, and of a private local git repository with no remote as the
knowledgebase's location, both relayed by Firstmate on 2026-10-06 (UTC). Diverges from one sentence
of ADR-0001 §1; the divergence is stated under Decision. Leaves ADR-0005 as it stands. Numbered
0010 because 0009 is taken by the portable explicit start on its own branch,
`fm/agent-kit-portable-authority`.
**Prior art read:** ADR-0001 (the nine kinds, the two artifact classes, the seven operations),
`adapters/knowledgebase/CONTRACT.md` before this change, `adapters/tracker/CONTRACT.md` §5 and
`src/tracker/binding.ts` (the binding this one is modelled on),
`adapters/runner-contract/CONTRACT.md` §5 (idempotency and read-back),
`research/sources/engineering-skills-repo-plan.md` §1.2 and §8, `src/packaging/install.ts`.

## Context

A lifecycle run in a task copy reported that the knowledgebase adapter was unavailable, for both
`kb-read` and `kb-write`, and that the copy had no `ak.install.yaml`. It could not publish the
direction it had just agreed.

The reproduction showed that nothing was broken in the task copy. The adapter had never been built:
`adapters/knowledgebase/CONTRACT.md` was a contract with no implementation, neither host supplied
`kb-read` or `kb-write`, and no file or command defined what "a knowledgebase is configured" meant.
Every checkout on every machine got the same answer. `ak.install.yaml` was unrelated: it states
which adapters an install attaches, which only sets packaged mode ceilings, and its absence is the
default install with every adapter attached.

The tracker adapter had already solved the same shape of problem, with a binding file in the
project folder, a backend document and a check command. The knowledgebase had no counterpart, and
two things stood in the way of simply copying it.

First, a tracker binding is gitignored because it points at a secret. A task copy is a git work
tree and inherits nothing untracked, so a gitignored knowledgebase binding would reproduce the
reported failure exactly.

Second, ADR-0001 §1 says the central equivalents "already exist in the `kb` CLI and are not
reinvented here." That CLI is a private package inside another project's repository, enrolled to
that repository and not installable on its own. Binding it first means extracting it from a
repository this package does not own.

## Decision

**This package carries a first knowledgebase backend of its own.** That is a divergence from the
quoted sentence of ADR-0001 §1, approved by the owner. Everything else in ADR-0001 stands and the
backend is built to it: the nine kinds, the two artifact classes, placement by scope, an ADR stored
`proposed` and accepted only by a human, and central ownership.

1. **The binding is a committed locator.** `ak.kb.yaml` at the project root names a backend, the
   project id and a knowledgebase id. It holds no machine path and no secret, so it is committed,
   and every checkout of the project, a task copy included, binds the same knowledgebase with no
   setup of its own. This is the "small KB locator" plan §1.2 allows a working repository.
2. **The machine's path is registered outside every checkout**, once per machine, with
   `ak kb register`. A project that is bound on a machine that has not registered the knowledgebase
   is unconfigured, not failed.
3. **The first backend, `local-git`, is a git repository of files.** A read returns committed
   pages only. A publish is one commit, made under a lock and read back before it is reported, and
   it is never pushed.
4. **Two operations are carried: `readContext` and `publishArtifact`.** `recordDecision`,
   `linkCodeEvidence`, `requestImpactAnalysis`, `linkPullRequests` and `proposeLesson` refuse and
   write nothing.
5. **The knowledgebase is never the application repository.** A registration or binding that
   resolves to the project's checkout, another work tree of it, or a directory inside or around
   its tree is refused.
6. **Unavailable says why.** The report names the missing setup step, a binding file or a
   registration, and says that `ak.install.yaml` is not it.

The rule is ruling `kb-binding-is-a-locator`; the contract is
`adapters/knowledgebase/CONTRACT.md` §7 and `adapters/knowledgebase/backends/local-git.md`.

## Consequences

- **There are now two knowledgebase implementations in the world this package describes**, the
  `kb` CLI and `local-git`. They share the vocabulary and not the storage. A `kb` CLI backend can
  still be added as a second binding without changing the contract: a binding is a document, a
  schema and the code for its operations.
- **`local-git` has no review workflow, no approvers list and no glossary command.** ADR-0001's
  rule that an ADR is accepted in review is held only as far as storing it `proposed` and offering
  no operation that changes the status. Who may commit to the knowledgebase repository is the
  filesystem's answer.
- **Setup is an operator step and stays one.** A knowledgebase has to exist and be registered on
  each machine. No skill creates one, and a run on a machine without one still reports
  unavailable, now with the step that fixes it.
- **A knowledgebase with no remote lives on one machine.** That is the owner's choice for the
  first one. A run on another machine cannot read it until its operator clones and registers it.
- **Skills did not change what they do when no knowledgebase is configured.** The interview still
  continues past an unavailable read and publication still stops with `needs-input`. What changed
  is that a configured knowledgebase is now possible, and that the stop names its cause.
- **ADR-0005 is untouched.** Nothing here changes who may start a phase.
