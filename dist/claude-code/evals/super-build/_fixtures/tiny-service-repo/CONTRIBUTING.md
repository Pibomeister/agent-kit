# Contributing

## Checks

    npm run check     # the test suite (node's built-in runner)
    npm run lint      # static checks in scripts/lint.js

There is no `npm test`; CI runs exactly the two commands above, in that
order, and both are required checks on every pull request.

To run a subset, pass a name pattern through to the runner:

    npm run check -- --test-name-pattern="<pattern>"

## Releasing

A release is cut from `main` only after `npm run check` and `npm run lint`
pass on the exact commit being released. There are no third-party
dependencies to audit; keep it that way.

## Layout

    src/<area>/        one directory per area of the service
    test/<area>/       tests mirror src/
    config/            per-environment overrides of src/config/defaults.js
    tickets/           ticket exports, when a branch is working one
