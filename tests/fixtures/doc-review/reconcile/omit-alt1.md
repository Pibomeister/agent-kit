---
case: GAP-04-omit-alt1
fr: [FR-02]
at: [AT-03]
defect: omission
seed: ALT1
---

# Session lifetime

Origin: auth-requirements

## Decisions

D1. Sessions expire after 15 minutes of idle time.

## Requirements

R1. Expired tokens are rejected with 401.
R2. Refresh is allowed once per session.

## Alternatives
