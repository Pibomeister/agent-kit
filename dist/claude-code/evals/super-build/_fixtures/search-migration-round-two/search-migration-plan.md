# Search migration — implementation plan

Origin: requirements/search-migration (validated, approved 2026-08-04)

## Scope

Move the product search index off the hosted vendor and onto a self-hosted cluster. Relevance
tuning moves with the index. The analytics readers keep reading from the vendor's export until a
later effort retires it.

## Rollout

R1. Stand up the cluster behind a feature flag, dual-write both indexes for two weeks.
R2. Cut reads over per tenant, largest tenants last.
R3. Stop the dual write once every tenant has been reading from the cluster for seven days.

## Constraints

C1. The vendor contract runs until 2027-01-31 and cannot be exited early, so the dual-write window
    is paid for either way.
C2. The analytics export is unchanged by this work.

## Acceptance

A1. Every tenant reads from the self-hosted cluster.
A2. Search latency at the 95th percentile is no worse than the vendor baseline recorded in R1.
