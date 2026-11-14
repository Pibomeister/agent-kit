---
case: GAP-04-omission
fr: [FR-02]
at: [AT-03]
defect: omission
seed: R2
---

# Session lifetime

Origin: auth-requirements

## Decisions

D1. Sessions expire after 15 minutes of idle time.

## Requirements

R1. Expired tokens are rejected with 401.

## Alternatives

ALT1. Sliding window versus fixed expiry. Both remain open. The product has not chosen.
