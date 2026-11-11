---
case: GAP-04-addition
fr: [FR-02]
at: [AT-03]
defect: material-addition
seed: R3
---

# Session lifetime

Origin: auth-requirements

## Decisions

D1. Sessions expire after 15 minutes of idle time.

## Requirements

R1. Expired tokens are rejected with 401.
R2. Refresh is allowed once per session.
R3. A session may be revoked from any device.

## Alternatives

ALT1. Sliding window versus fixed expiry. Both remain open. The product has not chosen.
