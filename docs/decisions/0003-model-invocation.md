# ADR-0003 — Every skill is loadable by the model

**Status:** Accepted.
**Date:** 2026-09-24.
**Authority:** the maintainer's decision, 2026-09-24 ("enable all skills", taking the option that drops
the host flag and keeps the U class). Amends how `AGENTS.md` "The invocation law" is held, not the law.
**Prior art read:** `adapters/codex/CONTRACT.md` §3.1, `src/packaging/plan.ts` (`packaging.u-skill-not-manual`),
`src/packaging/hosts.ts`, ADR-0002's eval results.

## Context

The claude-code bundle carried `disable-model-invocation: true` on every U skill: super-align,
super-bound, super-review, super-ship, receiving-review and wayfind in `core`, babysit-pr and ultraqa in
`autonomy`. Claude Code honors the key, so the model could not load those skills through the Skill tool
at all. Two things followed.

1. **Their evals measured the bare model.** No case prompt starts with a slash command, so a positive or
   adversarial case for a U skill ran without the skill. The Firstmate evals in ADR-0002 finished in one
   or two turns and scored the same with and without the plugin.
2. **A Firstmate worker could not load super-review or super-ship.** Its brief is the task prompt, not a
   typed slash command, so the lifecycle's review and ship phases were reachable only by reading the
   files by path.

codex never had the key. There the law is held by the skill itself (§3.1): a non-trigger clause in the
description, an authority check as the first workflow step, `mode: manual`, and the non-trigger eval
case as a required gate.

## Decision

No host emits `disable-model-invocation`. Claude Code takes the codex path for this one key:

- `HOST_FRONTMATTER_KEYS["claude-code"]` drops the key, and the claude-code default capabilities no
  longer claim `no-model-invocation`.
- The existing rule `packaging.u-skill-not-manual` therefore applies on claude-code: every U skill's
  claude-code row is `mode: manual` and names the unrequested suppression in `unsupported`. Five rows
  changed from `guided` (super-review, super-ship, receiving-review, babysit-pr, ultraqa).
- The check `invocation.missing-disable-model-invocation` is retired.
- `invocation: U` and the `packaging.generated_frontmatter.disable-model-invocation: true` declaration
  stay, as the record of the class. U still means a human starts it; what changed is which mechanism
  holds that.

## Consequences

- The model can load any skill. A U skill loaded without an explicit request or a validated grant stops
  at its authority step and says so. That is the same behavior the skills already specify for a host
  that cannot validate a grant.
- `manual` on claude-code is stricter than the `guided` it replaces for five skills. That is §3.1's price
  for a skill the model can start, and it is recorded rather than absorbed.
- Each U skill's non-trigger eval case is now the only observation of the law on claude-code too, so it
  becomes a required gate there, as it already is for codex.
- The Firstmate worker can load super-review and super-ship. Whether they then *run* still turns on
  authority: the binding is not a runner-validated grant (`research/briefs/carried-forward.md`,
  "runner-validated grants"), so a faithful worker reaches their authority step and stops unless the
  supervisor invokes the phase explicitly. *Amended by ADR 0004:* `ak firstmate grant` validates
  the binding as the delegated grant. The autonomous form of `ship.prepare` stops without trusted
  evidence, as ADR-0004's amendment of 2026-09-30 states.
- **Reverting** is two lines in `src/packaging/hosts.ts` (the key back on claude-code's list, and
  `no-model-invocation` back in its defaults), the five rows back to `guided`, and this ADR superseded.
