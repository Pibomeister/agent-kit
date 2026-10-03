# Verification evidence

This reference supplies the shared vocabulary for observable runtime success. Projects declare the
facilities they actually have; tickets select from those declarations; verifier receipts report what
ran. No skill assumes a browser, service, trace collector or command from a framework convention.

## Recipes

A verification recipe is host-neutral and content-addressed. It names its scope, environment,
surfaces, available evidence kinds and permitted steps in this order:

1. `setup` prepares declared dependencies without changing product source.
2. `build` produces the runnable artifact.
3. `launch` starts the application or service.
4. `readiness` proves that the launched subject is ready to be driven.
5. `drive` exercises the named user path or request.
6. `cleanup` ends the launched processes and removes scratch state.

A project declaration may contain several recipes with different scopes. A missing step or facility
is a visible gap. Discovery may form a candidate from project files, but the candidate becomes a
published recipe only after the complete path succeeds. The artifact is published through the
central knowledgebase; it is never written to a host-specific path in the application tree (ruling
`central-kb-owns-project-artifacts`).

## Criterion binding

`ticket.acceptance_criteria[].surface` is `frontend`, `backend` or `none`. Each named verification
check binds its supported criteria to one recipe id and hash plus one or more `evidence_required`
kinds. The recipe declaration must advertise every selected kind. An undeclared facility does not
become available because a check can approximate it.

The recipe hash is evidence input. A changed recipe or project declaration requires a new ticket
binding and new receipts; an older receipt does not inherit the new path.

## Evidence kinds

| Surface | Evidence kind | Receipt representation |
|---|---|---|
| frontend | `rendered-screenshot` | `artifacts[].kind: screenshot` and its digest |
| frontend | `user-path-trial` | Command or probe outcome plus the driven path in probe parameters |
| frontend/backend | `trace` | `artifacts[].kind: trace` and its digest |
| frontend/backend | `log` | `artifacts[].kind: log` and its digest |
| backend | `api-response` | Numeric response status, complete body digest and a `response` artifact |
| backend | `dry-run` | Command or probe with complete output digest |
| backend | `smoke-test` | Command or probe with complete output digest against the running service |

The table is a vocabulary, not a universal checklist. A project chooses the kinds each check needs.
Tests, type checks and builds may support a runtime receipt but never substitute for a required kind.

## Receipt and seat lineage

A surface receipt binds the source revision and diff hash, environment, ticket check, recipe id and
hash, evidence kind, every artifact digest, and the verifier seat. `api-response` also binds status
and body digest. Narrative is not evidence (ruling `closure-requires-independent-verification`).

The verifier seat record names its id, the implementer seat, and one isolation state:

- `runner-attested`: the runner recorded distinct context and excluded lineage outside the worker's
  writable scope. This is eligible for autonomous closure.
- `host-unattested`: the host created a fresh context but cannot attest what it saw or its lineage.
  This remains useful guided evidence and never claims autonomous independence.

The verifier is never the implementer, change author, spec approver, recipe author for the change or
a seat already used on the same decision. An ineligible or unfillable seat is `unavailable`; it is
not backfilled (ruling `missing-supervisor-never-implementer`).

## Completion predicate

A criterion is covered only when current passed receipts carry every kind its ticket check requires,
all corresponding artifacts are present and digest-valid, the recipe binding matches, and the
verifier seat is eligible for the requested mode. One generic passing test cannot cover a missing
screenshot, trace, API response or running-service trial. Non-pass receipts remain durable evidence
of what ran; they never become coverage by omission.
