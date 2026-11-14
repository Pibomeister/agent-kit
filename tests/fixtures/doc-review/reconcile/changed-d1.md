---
case: GAP-04-changed
fr: [FR-02]
at: [AT-03]
defect: changed
seed: D1
---

# Session lifetime

Origin: auth-requirements

## Decisions

D1. Sessions expire after 30 minutes of idle time.

## Requirements

R1. Expired tokens are rejected with 401.
R2. Refresh is allowed once per session.

## Alternatives

ALT1. Sliding window versus fixed expiry. Both remain open. The product has not chosen.
