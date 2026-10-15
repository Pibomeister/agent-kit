# Optional linting for the selected candidate

Loaded only during discussion of a human-selected candidate. This is a setup **proposal**, not an
installer: `improve-architecture` has no workspace-write authority and starts no other U skill.

## Establish the gap

Read the target scope's package manager, manifests/lockfile, scripts, lint/format configurations and
runtime requirements. Use version/effective-config checks and representative samples where they
can run without project writes. Bind official guidance to the target version/runtime, not this
catalog's dependencies. Existing ESLint, Biome, Prettier or other working tools are not a defect.

Offer setup only when all of these are established:

- The human selected this candidate and its source demonstrates a concern a lint/format check can
  meaningfully enforce. Feature ownership and good test oracles often need review, not a rule.
- That specific check is missing and would run on the candidate's relevant supported JS/TS scope.
  A missing rule elsewhere in a monorepo or a merely preferred linter is not a trigger.
- The intended tool/runtime path is supported. For custom plugins, verify actual plugin loading and
  the intended diagnostic on a representative sample before claiming support. Unknown compatibility
  is a limitation, not permission to install something to find out.

No selection, adequate enforcement, an unrelated gap, or an unsupported/unknown target means no
setup offer. Keep the architecture advice, and name manual review or existing language tooling
where no supported check can enforce the concern.

## Ask once, with concrete scope

Reuse a recorded preference for this scope. A previous yes includes only its named checks; it does
not authorize formatter replacement, type-aware dependencies or later expansion. A previous no is
not asked again during the run.

Where the gap qualifies, ask through the same human channel as the candidate discussion:

> This candidate's [observed concern] lacks [specific check] on [target scope]. Include a bounded
> tooling setup task in the implementation handoff? It would [named dependency/config/script
> changes]. Or keep the architecture advice only?

An explicit yes records the agreed checks, allowed changes, compatibility limits and verification
in the proposed decision/handoff; it installs nothing here. A no leaves the architectural proposal
useful, writes no tooling changes and ends that preference question. Silence is not setup consent.

## What an accepted downstream task would cover

- Preserve the target package manager and merge its existing scripts/configs/plugins/ignores. Create
  a config only if none exists. Linter/formatter migration, bulk cleanup and CI changes are separate
  named scope; setup alone does not authorize fixing every existing diagnostic.
- For an Oxlint path, use compatible pinned `oxlint` and `@oxlint/plugins` versions if custom rules
  require the latter. JS plugins remain alpha; a manifest entry alone does not prove compatibility.
  Register a local plugin relative to its config, preserve its complete license/provenance and
  verify its diagnostic. Do not transplant this catalog's ratchet or vendored rules automatically.
- Type-aware linting is a separate choice requiring compatible `oxlint-tsgolint` and usable target
  type information. Preserve the existing typecheck command unless its replacement was agreed.
- Oxlint's `eslint/complexity` reports cyclomatic paths, has no autofix and is not enabled by default.
  Its default maximum 20 and classic/modified variants are tool options, not architecture gates.
  Record the project's chosen options; prefer diagnosis over refactoring to game the number.
- Add Oxfmt only when formatter setup was included; otherwise retain the existing formatter. Use
  its config and check command, preserve generated/vendor/fixture exclusions, and separate requested
  bulk formatting from semantic edits. Avoid competing readability-spacing rules and demonstrate
  lint/fix/format convergence before claiming the combination works.
- Vendored anti-slop rules can catch specific assertion, naming, mocking and collection patterns;
  they cannot prove semantic feature seams, meaningful tests or token savings. Select supported
  relevant checks, retain exact source revision and all nested notices, and leave stack-specific
  plugins off unless the target actually uses that stack or the user requests them.
- Verify the target's real lint/typecheck/format commands and intended diagnostics, report existing
  findings and retain unsatisfied checks. Do not weaken rules, add unsafe casts or suppressions,
  or spend a permissive baseline simply to make setup green.

Official starting points (re-check them for the target's actual version):

- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config.html),
  [JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html),
  [type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html).
- [Oxfmt quickstart](https://oxc.rs/docs/guide/usage/formatter/quickstart.html) and
  [configuration](https://oxc.rs/docs/guide/usage/formatter/config.html).

The handoff is a separate human-started work source. No skill invocation, package installation,
configuration edit, local ADR or consuming-project write is performed by this survey.
