---
case: GAP-01-plan
fr: [FR-01]
at: [AT-20]
expected: plan
---

# Search migration

## Product contract

The product search index must move off the hosted vendor and onto a self-hosted
cluster. Relevance tuning moves with the index.

## Constraints

C1. The vendor contract runs until 2027-01-31 and cannot be exited early.

## Acceptance

A1. Every tenant reads from the self-hosted cluster.

## Rollout

R1. Stand up the cluster behind a feature flag and dual-write both indexes for two weeks.
R2. Cut reads over per tenant, largest tenants last.
R3. Stop the dual write once every tenant has been reading from the cluster for seven days.

## Approach

Keep the analytics export unchanged. Dual-write is paid for either way while the
vendor contract runs.
