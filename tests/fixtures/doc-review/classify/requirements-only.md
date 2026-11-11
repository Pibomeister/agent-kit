---
case: GAP-01-requirements
fr: [FR-01]
at: [AT-20]
expected: requirements
---

# Search migration

## Product contract

The product search index must move off the hosted vendor and onto a self-hosted
cluster. Relevance tuning moves with the index. Analytics readers keep reading
from the vendor export until a later effort retires it.

## Constraints

C1. The vendor contract runs until 2027-01-31 and cannot be exited early.

## Acceptance

A1. Every tenant reads from the self-hosted cluster.
A2. Search latency at the 95th percentile is no worse than the vendor baseline.
