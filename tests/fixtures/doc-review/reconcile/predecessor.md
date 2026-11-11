---
case: GAP-04-predecessor
fr: [FR-02]
at: [AT-03]
artifact: auth-requirements
---

# Session lifetime

Origin: none

## Decisions

D1. Sessions expire after 15 minutes of idle time.

## Requirements

R1. Expired tokens are rejected with 401.
R2. Refresh is allowed once per session.

## Alternatives

ALT1. Sliding window versus fixed expiry. Both remain open. The product has not chosen.
