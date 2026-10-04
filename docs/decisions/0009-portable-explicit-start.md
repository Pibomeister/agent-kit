# ADR-0009 — Explicit starts are rendered by the host adapter

**Status:** Accepted.
**Date:** 2026-10-04.
**Authority:** the captain's request to close the host-compatibility gap, with portable explicit-start
authority implemented on Codex first and the five-host design fixed for the follow-up adapters.
**Prior art read:** ADR-0003, `src/validation/human-start.ts`, `src/packaging/plan.ts`,
`adapters/claude-code/CONTRACT.md` §5, `adapters/codex/CONTRACT.md` §§3.1 and 5, and the host
compatibility audit at `be03347`.

## Context

The invocation class is host-neutral, but the spelling that proves a human explicitly selected a
skill is not. Canonical U skills use `catalog.yaml`'s `package.namespace` and their catalog id, so
the source command for `super-align` is `/ak:super-align`. That is the native Claude Code plugin
command. The Codex bundle previously copied it unchanged even though Codex's documented explicit
skill mention is `$super-align`.

ADR-0003 requires every skill to remain model-loadable. The authority check in a U skill's
description and first workflow step, not a host suppression flag, is what prevents an ordinary prose
request from starting it. Changing the check to accept any request that selected or named a skill
would therefore weaken the invocation law.

Repeating all host spellings in every U skill would preserve the gate but make host knowledge part
of every canonical body. Each new host would require coordinated edits across the whole catalog,
and a missed occurrence could make the description and first workflow step disagree.

## Decision

The canonical explicit start is defined once as:

```text
catalog.package.namespace + catalog skill id
```

Canonical validation continues to require that exact value in every U skill's description and first
workflow step. The invocation graph also continues to parse the canonical namespace. Host packaging
then rewrites exact references to U commands in each emitted `SKILL.md`, including its generated
frontmatter, into that adapter's native explicit-start form. It does not add an authority check to M
skills and does not rewrite ordinary prose into a start.

The host forms are:

| Host | Packaged explicit start | Adapter requirement |
|---|---|---|
| Claude Code | `/ak:<id>` | Keep the canonical plugin command. |
| Codex | `$<id>` | A `/skills` selection counts only when the human turn delivered to the skill begins with the resulting `$<id>` mention. |
| Grok Build | `/<id>` | Render the discoverable plugin skill command and verify the delivered human turn retains it. |
| Kimi Code | `/skill:<id>` | Use the native skill command. A future `/ak:<id>` plugin-command bridge may replace it only after a model-free expansion probe proves the same leading authority marker reaches the skill. |
| Factory Droid | `/<id>` | Render the native skill command and verify the delivered human turn retains it. |

Only Claude Code and Codex are packaging targets in this change. The other rows are requirements for
their follow-up adapters, not dormant bundle implementations.

Matching is exact at the command boundary. `/ak:compound-refresh` is not an occurrence of
`/ak:compound`. The rewrite applies to references to catalog U ids wherever they occur in a packaged
skill so user-facing recommendations use the same spelling as the authority check. M ids are not in
the rewrite set.

The positive rule remains a prefix rule: the human message begins with the packaged explicit start.
A mention later in prose, a request that merely names the skill, host selection state without a
retained marker, and a model choosing the skill from its description are not explicit starts. With
no validated grant or other authority already declared for the entrypoint, the first workflow step
stops.

## Consequences

- ADR-0003 stays intact: every skill is model-loadable, and U still means human-started.
- Canonical skills remain host-neutral and `ak validate` keeps one strict command grammar.
- The Codex bundle now says `$<id>` in the description, Authority section, first workflow step and
  other U-command references. The Claude Code bundle keeps `/ak:<id>`.
- Bundle parity means the same skill set and equivalent canonical content, not byte-identical U
  bodies after host rendering. M bodies without U-command references remain byte-identical.
- Offline packaging tests prove the emitted positive marker, the retained prose refusal and the
  unchanged M path. They do not claim that a live session obeyed the prose.
- Each new host adapter must add its renderer, fixture coverage for U explicit/prose and M automatic
  behavior, and a model-free install/list probe before runtime acceptance is attempted.
- Reverting the Codex implementation removes its renderer and restores the former mismatch; it does
  not require editing canonical skill bodies.
