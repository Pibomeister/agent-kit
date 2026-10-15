# tester-army/e2e: create-verification-skill donor note

This is a research-only pin, not an adoption. The donor generates a project-specific
verification skill and proves that its instructions can drive the application.
No agent-kit skill, role or policy changes in this task.

## Source and licence

- Repository: https://github.com/tester-army/e2e
- Pin: `292cd0597c57b4929ad53919f0e4fe40ad87e095`
- Commit date: `2026-10-13T16:41:49Z`
- Primary source: `skills/create-verification-skill/SKILL.md` at that pin.
- Supporting source: `docs/coding-agents.mdx` at that pin.
- Licence: Apache-2.0. The upstream `NOTICE` names Copyright 2026 TesterArmy, Inc.
  Both files are preserved unchanged under `provenance/licenses/tester-army_e2e.*`.

The licence permits reuse subject to its redistribution conditions. Any later
adaptation must retain applicable attribution and identify modified material.
Firstmate's task decision defers the donor snapshot until adoption: the current
snapshot contract covers files cited by adaptation rows, and its generator prunes
uncited files. Later adoption must add a real adaptation row and generate its
pristine `<donor>@<sha12>/<upstream-path>` snapshot together. This task adds neither.

## What the skill does

The skill inspects the repository for supported surfaces, launch commands,
readiness, authentication, evidence stores and isolation constraints. It then writes
a local `verify-<app>` skill, a feature index and feature-specific exploration
charters. It reuses existing test knowledge and links to the donor's e2e guidance.
Web and mobile surfaces have engines; an HTTP API can use the web target with
request tests. Unsupported surfaces stop before generation.

The generated instructions cover launch, a smoke-test doctor, live MCP driving,
scripted tests, evidence, bug bashing and cleanup. The generator must execute that
path before handover. It can add tests and repair failures. It does not commit for
the user. These are upstream behaviors we inspected, not instructions activated
in this task. No e2e installation or execution was performed.

## E2e as the evidence layer

Proof follows an actual user path and checks both visible state and side effects
in the relevant stores. Reports, traces, screenshots and optional video preserve
the attempt. The action and resulting state matter, not just the final screen.
Since another run can clear the default results directory, durable proof needs a
separate output location before the next run, including a doctor run.

A smoke test establishes that the app and engine can run. A mapped feature test
demonstrates one path. Exploration is separately checked through its report steps
and ending; an exit code alone does not establish that a charter ran. An explored
finding becomes a confirmed bug only after a regression test fails on the assertion
that expresses it. Cleanup must stop owned resources while preserving evidence.

## Comparison with agent-kit

Our human-started `skills/verify/SKILL.md` verifies named acceptance criteria against
a frozen revision, declared recipe and environment. It returns schema-valid receipts
and a criterion matrix. Required runtime evidence cannot be replaced by a green
suite. It does not authorize repairs or source edits. The donor instead creates and
proves a reusable project-local procedure, and permits test authoring and repairs.
Its reports and feature map do not by themselves satisfy our receipt bindings.

`provenance/adaptations.d/verification-seat.yaml` records our independent verifier
seat and shared evidence vocabulary. The seat receives a frozen packet without the
implementer's narrative. Runner attestation excludes the implementer, author, spec
approver, recipe author and reused seats; a fresh host context alone does not attest
independence. The donor's self-verification workflow provides useful runtime
observations, but does not establish those lineage exclusions or runner attestation.
An e2e run could supply observations to that seat; it cannot replace the seat or
lift an autonomy ceiling by itself.

The donor writes project-local instructions and evidence paths. Our verification
contract uses content-addressed recipes and KB publication, or returns unpublished
artifacts from runner scratch. Any adoption needs that placement boundary and our
human-start authority preserved rather than importing the generator as another
verification entrypoint.

## Adoption candidates for follow-up

- Evaluate smoke-test doctor checks and feature charters as declared recipe inputs.
- Map e2e reports and runtime artifacts to criterion-bound receipts with digests.
- Test proof preservation across subsequent runs and cleanup.
- Evaluate assertion-backed exploration findings within existing diagnosis rules.
- Research poteto's pstack `create-verification-skill` as a possible later donor.
  The pinned documentation attributes the generator to that upstream and links to
  https://github.com/cursor/plugins/tree/main/pstack/skills/create-verification-skill.
  The post's “based on @poteto skills” claim matches this attribution. That source
  is not pinned, fetched or adopted in this task.
