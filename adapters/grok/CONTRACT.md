# Grok Build host contract

Grok uses the existing Claude-compatible packager and the same authored skills, with its own
explicit-start rendering. `ak build --host grok --profile all` writes `dist/grok`; a default build
also includes it. There is no second authored catalog or skill tree. The Claude and Codex bundles
retain their existing forms. ADR-0011 governs rendering; ADR-0003 keeps every skill model-loadable.
ADR-0005 remains Proposed.

## Bundle and capabilities

The bundle has `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, the generated
`.claude-plugin/ak.json` build record, `skills/`, shared references, scripts and licenses. The build
record identifies `grok`. Skill registration uses the Claude manifest layout. The Claude-native
behavioral eval corpus is omitted: no Grok-native consumer for it is verified.

All capability statuses and limits in `adapters/claude-code/CONTRACT.md` §3 apply. In particular,
host permissions are neither runner-grant validation nor trusted evidence, and fresh child contexts
do not attest independence. An unavailable independent seat blocks its checkpoint (ruling
`missing-supervisor-never-implementer`). The attached-adapter ceiling rules apply unchanged (ruling
`fail-closed-adapter-lifts-ceiling`); attachment alone does not prove service availability.

Grok inherits each skill's Claude packaging declaration unless a Grok row is explicitly supplied.
Its own restriction declaration is checked separately, and the shared capability ceiling still
caps the declared mode. U skills remain manual; inherited `allowed-tools` is inert metadata here.

```yaml
enforces: []
notes:
  - allowed-tools grants and restricts nothing; it is not a sandbox or pre-approval.
  - No filesystem, network or process confinement is claimed by this package.
  - Every skill remains model-loadable; suppression flags are not emitted.
```

[Official extension documentation](https://docs.x.ai/build/features/skills-plugins-marketplaces)
defines `/<skill-name>` commands, with `user-invocable` defaulting to true. Setting it false hides
the skill from both human and model, unlike Claude. The package emits neither that key nor
`disable-model-invocation`. `argument-hint` is an autocomplete hint; `allowed-tools` grants nothing.

## Explicit-start authority

The registered name is the skill id, so `super-align` is addressed as `/super-align`, not
`/ak:super-align`. The packager renders exact U-command references in descriptions, first workflow
steps, local references/assets and shared references as `/<id>` using ADR-0011. It leaves canonical
sources and M trigger descriptions unchanged. A longer id is not the shorter command.

Only a leading native marker in the delivered human turn, or authority already permitted by the
entrypoint and validated by the runner, starts a U skill. Ordinary prose, a later mention, a menu
selection without the retained marker, or automatic model selection supplies no authority. The
first workflow step must stop without it (ruling `entrypoint-phase-operation-split`). Host plugin
trust is not a phase grant and cannot lift this requirement.

## Model-free discovery receipt

On 2026-10-09, Grok Build 1.0.50 validated and installed the generated all-profile bundle into a
fresh `GROK_HOME` under `.work/`, with a private `HOME`, no credentials, compatibility discovery
disabled, and memory and auto-update disabled. `inspect --json` registered 36 skills from that
installed `ak` copy, all user-invocable. It lists the name `super-align`; the documented slash
mapping gives `/super-align`. Inspection shows the rendered native gate in its description.

Reproduce without a model turn after building:

```bash
bun run ak build --host grok --profile all
python3 research/probes/grok-discovery.py dist/grok /tmp/grok-discovery-evidence
```

The probe runs `grok --version`, `plugin validate`, `plugin install --trust`, and `inspect --json`.
Its temporary homes are inside the worktree's ignored `.work/`; raw output goes to the supplied
evidence directory. It checks installation source paths, not just matching skill names, and retains
a normalized discovery fixture for offline comparison. It never reads credentials or starts a
session. A new CLI version needs a fresh probe.

Inspection proves registration and loaded description, not slash expansion or preserved human
turns. Whether Grok delivers the leading marker through a live command expansion remains unproven.
This contract does not claim that any live session obeyed the authority text or completed a phase.

## Offline and deferred acceptance

`tests/grok-packaging.test.ts` checks the generated interface: native typed markers and stop-first
U gates, retained prose refusal, unchanged M triggers, unsuppressed discovery, manifest layout and
skill-set parity. The discovery fixture records the local CLI observation. These are deterministic
output checks, not substitutes for behavioral evidence.

The existing eval subject selection remains mapped to `dist/claude-code`. Its historical sessions
tested that bundle; they cannot prove the new Grok rendering and must not be relabeled or rescored
as native Grok-bundle trials. Learning hooks, updater integration and permission repairs to old
receipts are outside this contract.

Before claiming runtime acceptance, authorize and record three fresh cases against `dist/grok`:

1. Type `/super-align` with a bounded request; inspect the delivered human marker and verify the
   authority check permits only the requested alignment workflow. Compare a later prose mention.
2. Ask for the same alignment in ordinary prose with no grant; verify refusal/recommendation and
   no phase work or repository inspection.
3. Ask where one named symbol lives; verify automatic `super-scout` loading and bounded read-only
   evidence without requiring a U command.

Each receipt must identify source revision, bundle, host version, delivered input, permissions,
tool trace, exit status and validity limits. The PR records these unrun cases and their proposed
cost estimate; no live lifecycle acceptance is inferred from installation.
