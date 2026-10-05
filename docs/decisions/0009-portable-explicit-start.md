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
command. The Codex bundle previously copied it unchanged even though Codex mentions a skill with a
leading `$` and lists this plugin's skill as `ak:super-align`, so its explicit mention is
`$ak:super-align`.

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
frontmatter, in each skill-local `references/` and `assets/` file, and in each shared file published
under `references/shared/`, into that adapter's native explicit-start form. It does not add an
authority check to M skills and does not rewrite ordinary prose into a start.

The host forms are:

| Host | Packaged explicit start | Adapter requirement |
|---|---|---|
| Claude Code | `/ak:<id>` | Keep the canonical plugin command. |
| Codex | `$ak:<id>` | A `/skills` selection counts only when the human turn delivered to the skill begins with the resulting `$ak:<id>` mention. |
| Grok Build | `/<id>` | Render the discoverable plugin skill command and verify the delivered human turn retains it. |
| Kimi Code | `/skill:<id>` | Use the native skill command. A future `/ak:<id>` plugin-command bridge may replace it only after a model-free expansion probe proves the same leading authority marker reaches the skill. |
| Factory Droid | `/<id>` | Render the native skill command and verify the delivered human turn retains it. |

Only Claude Code and Codex are packaging targets in this change. The other rows are requirements for
their follow-up adapters, not dormant bundle implementations.

The Codex form is the plugin-qualified name, not the bare id. A model-free probe on `codex-cli
0.159.2` installed the built bundle into a scratch `CODEX_HOME` and ran `codex debug prompt-input`:
the model-visible skill list names each skill `ak:<id>`, and a typed `$ak:super-align …` turn reaches
the model verbatim. The probe does not show the host resolving a mention, so whether Codex also
resolves a bare `$<id>` to a plugin skill is not established; the gate names only the listed name
and does not accept the bare form.

Matching is exact and case-sensitive at the command boundary. `/ak:compound-refresh` is not an
occurrence of `/ak:compound`, and `/AK:Compound` is prose. The rewrite applies to references to catalog U ids wherever they occur in a packaged
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
- The Codex bundle now says `$ak:<id>` in the description, Authority section, first workflow step and
  other U-command references, in `SKILL.md`, skill-local files and `references/shared/` alike. The
  Claude Code bundle keeps `/ak:<id>`.
- Bundle parity means the same skill set and equivalent canonical content, not byte-identical U
  bodies after host rendering. M bodies without U-command references remain byte-identical.
- The eval harness types and grades in the form of the bundle each host installs: a typed case is
  sent to a Codex cell as `$ak:<id>`, and a reply is read back through the same mapping before the
  canonical graders run, so a Codex reply that recommends `/ak:<id>` does not pass. Prompt files are
  transformed when loaded and are not edited.
- The Codex eval cell is a known limit, accepted as such. It launches the host with plugins
  disabled and installs the bundle's skills standalone, so the host lists each skill under its bare
  id and a typed `$ak:<id>` is never a host-resolved plugin mention there. Its typed-case results
  observe the packaged prose gate matching the typed prefix, not the plugin mention; the plugin
  form is verified separately by the model-free live-host probe in `adapters/codex/CONTRACT.md` §3.1.
- Codex sessions recorded before this change ran against a bundle gated on `/ak:<id>`. The reply
  mapping reads every stored Codex reply in the new spelling, so those sessions are not rescorable.
- Offline packaging tests prove the emitted positive marker, the retained prose refusal and the
  unchanged M path. They do not claim that a live session obeyed the prose.
- Each new host adapter must add its renderer, fixture coverage for U explicit/prose and M automatic
  behavior, and a model-free install/list probe before runtime acceptance is attempted.
- Reverting the Codex implementation removes its renderer and restores the former mismatch; it does
  not require editing canonical skill bodies.
