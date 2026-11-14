# EGM gap status (GS-006e reference oracles)

These three gaps have deterministic bun fixtures. They are not closed. Product
behavior is unverified. The modules are not on a product path.

| Gap | FR / AT | Status |
|---|---|---|
| GAP-01 | FR-01 / AT-20 | partial: deterministic reference only, product behavior unverified |
| GAP-04 | FR-02 / AT-03 | partial: deterministic reference only, product behavior unverified |
| GAP-05 | FR-05 / AT-06 / AT-07 | partial: deterministic reference only, product behavior unverified |

Commands:

- `GIT_CONFIG_GLOBAL=/dev/null bun test tests/doc-review-classify.test.ts`
- `GIT_CONFIG_GLOBAL=/dev/null bun test tests/doc-review-reconcile.test.ts`
- `GIT_CONFIG_GLOBAL=/dev/null bun test tests/simplify.test.ts`
