# Agent-friendly architecture survey additions

Original task-derived guidance, 2026-10-12. MIT; Copyright (c) 2026 Eduardo Picazo.
This note records additions to the existing donor-backed survey, not instructions attributed to
Matt Pocock. His module-depth vocabulary and survey process retain their existing MIT pin and rows.

## Proportional organization and discovery

Follow one behavior from its entrypoint through the owning module to callers and interface tests.
Read the named subsystem at a stated revision, starting with scoped path/symbol discovery and source
read-back. History and a fresh graph can supply leads; missing coverage and stale indexes are stated.
Do not dump generated, vendored or unrelated material merely to make a survey look comprehensive.

Feature ownership is justified by actual call/change/test relationships. A small cohesive codebase
can stay flat; a small real leaking interface can merit a candidate. A large cohesive module may
need no surgery. Nest only where domain responsibilities become easier to locate. Respect the
project's language/framework conventions, including required route/page/index names; do not infer
that symbol-naming lint enforces file organization. Keep genuinely shared contracts with their owner.

Candidate evidence includes revision, source locations, entrypoint, owner and caller/interface test,
observed friction, excluded areas and a verification recipe. Small size is not shallowness. Reduced
file counts or line breaks do not demonstrate fewer input tokens. Any efficiency claim needs the
same correctly answered task, a stated instrument and source revision, loaded bytes or actual input
counts, with cached/fresh counts separated when available. No such improvement is asserted here.

Complexity diagnostics name the existing tool/version/options/location. Cyclomatic branch count is
neither module depth nor cognitive difficulty. Thresholds are project choices, not catalog gates;
do not split a real domain switch or extract shallow helpers merely to lower a number. Preserve the
shared vocabulary/deepening/testing owners rather than adding another process.

A mirrored test calculates its expected result from its subject/helper or encodes the answer in a
double. Name a defect it could miss and an independently specified observable outcome or relevant
failure. Preserve valuable unit/integration coverage and distinct invariants. Lint and coverage do
not establish a meaningful oracle; replace obsolete shallow tests only after real replacement exists.

## Candidate-relevant optional tooling

Ask about setup only during discussion of the one human-selected candidate, for a verified missing
enforceable check addressing its demonstrated friction on its relevant supported target scope.
A missing rule elsewhere, a preferred linter, no selection, adequate enforcement, unsupported scope
or unknown compatibility is not a trigger. Keep architecture/manual-review advice useful instead.
Reuse a recorded preference. An existing yes covers only its named scope; a no is not asked again.

The question names the concern, check, scope and concrete dependency/config/script changes a
separate bounded implementation task would perform. A yes records only a downstream handoff and
its compatibility/verification; it installs nothing and starts no other user-invoked skill. Formatter
replacement, type-aware dependencies, migration, CI work and bulk cleanup need their own named scope.
The existing survey's no-write, KB and one-candidate gates are preserved.

Discover the target's actual versions, package manager, runtime and configs. Merge rather than
replace. For selected custom plugins establish actual loading and the intended diagnostic, preserve
exact source/license/provenance, and account for the alpha API. Type-aware dependencies and formatter
adoption are separate choices. Preserve the established formatter and exclusions; avoid competing
readability rules and prove convergence. No generic ratchet or vendored rule set is copied by default.
Specific lint patterns cannot prove semantic feature ownership, meaningful tests or token savings.

Version-bound primary-source context was checked for Oxlint/plugins 1.86.0, Oxfmt 0.71.0 and
oxlint-tsgolint 7.0.2003. The official Oxc release tags resolve to commit
[2ae2939bb2fd98796393658b21556b2a2467e047](https://github.com/oxc-project/oxc/tree/2ae2939bb2fd98796393658b21556b2a2467e047); its schemas support the config fields and its complexity
source defines default maximum 20, classic/modified variants and no autofix. These are tool defaults,
not architecture requirements. Official website sources at
[773a2dc9029a7e6657565b689b374f2145b2f57c](https://github.com/oxc-project/website/tree/773a2dc9029a7e6657565b689b374f2145b2f57c) document configuration, JS plugins, type-aware linting and
formatter setup. Re-check actual target versions; this catalog's pins do not establish all runtimes.

## Behavioral evidence boundary

Use reconstructible source fixtures and independently fixed oracles, withholding the expected
diagnosis from ordinary survey prompts. Before trials bind fixture revision/content, runtime/tool
configuration, actual selection/preference interaction, allowed effects and prohibited writes.
Capture full dialogue/tool/process effects plus before/after relevant consuming-project state,
including tracked, untracked and ignored source/config/dependency/CI files. Account separately for
permitted OS-temporary reports and declared KB effects; final git status or Edit counts are insufficient.
Observe external symlink targets and transient effects as well as final filesystem snapshots.

The discriminating matrix covers small cohesive/small defect/large scattered/large cohesive,
mirrored/valuable tests, unselected/selected, eligible/unrelated gaps, adequate/unsupported/unknown
tooling, current yes/no, prior decline/prior yes and an established formatter. The independent order
oracle is price 100 less discount 10 equals 90; omitting discount can pass a mirrored expectation but
must fail that outcome test. Preserve the distinct invalid-order invariant. Fixture-selected max 4
is an example configuration, never a universal threshold.

Source fixtures, native case bootstraps, YAML validation and prose-content graders are supporting
assets only. Selected/preference branches need the real independent interaction driver and a
KB-capable trial environment, with all effects observed. Missing facilities or a continuation leaves
behavioral acceptance unavailable. Source controls and author self-checks never substitute for an
independent survey trial or required reviewer seat.
