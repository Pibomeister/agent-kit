# adapters/kimi — host contract

Kimi is a native packaging target over the canonical skill and reference tree. This contract
applies to Kimi Code CLI 2.1.1. Installation and discovery evidence is recorded in
`research/host-facts/2026-10-08/kimi-packaging.md`; model behavior is not established by discovery.

## Bundle and installation

`bun run ak build --host kimi` emits `dist/kimi/`. The bundle contains
`.kimi-plugin/plugin.json`, `.kimi-plugin/ak.json` (the package's build record), `skills/`, shared
references, the lifecycle scripts and license files. The native manifest names `ak` and registers
`"skills": "./skills/"`. Its identity comes from the same catalog as the other hosts. It carries
no Claude marketplace, eval registration, hooks, session-start injection or command bridge.

Install the directory through Kimi's `/plugins install <absolute-path-to-dist/kimi>` command.
For a single session, `kimi --skills-dir <absolute-path-to-dist/kimi/skills>` replaces automatic
user/project skill discovery. This loads standalone skills; it is not a managed plugin install.
Use a temporary home for probes. No login or existing user configuration is needed to inspect a
bundle through the local server's plugin and workspace-skill endpoints.

The manifest and skill layout follow the official
[plugin documentation](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)
and [skill documentation](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html).
These describe host capabilities; the local receipt names what was actually observed.

## Explicit starts

ADR-0011 fixes Kimi's U explicit start as `/skill:<id>`. Packaging rewrites exact canonical U
command references in descriptions, bodies, local references/assets and shared dependencies. A
longer command id is not a match. M ids remain unchanged and keep their automatic invocation path.

A human turn must begin with `/skill:<id>`. Merely naming a skill in prose, a later mention,
selection state without the marker, or model loading does not start a U skill. Its description,
Authority section and first workflow step retain the stop rule. Existing runner-validated grant
forms remain exactly those the canonical skill declares (ruling `entrypoint-phase-operation-split`).

Every skill remains model-loadable (ADR-0003). No suppression flag, manual-only flow type or
host-specific frontmatter is emitted. `metadata.ak.mode: manual` records the U policy; it is not
a host enforcement switch. A future `/ak:<id>` bridge requires the model-free expansion evidence
specified in ADR-0011. This bundle does not claim that bridge or broaden the gate to accept prose.

## Capabilities and limits

Every capability has the status in `adapters/claude-code/CONTRACT.md` §3, as on Codex. This is the
package's conservative capability ceiling, not evidence of live lifecycle parity. In particular,
`runner-grants`, `trusted-evidence` and `independent-context` are not supplied by the host. Attached
adapters must supply and validate their own evidence; permissions and successful installation do
not lift that ceiling (ruling `fail-closed-adapter-lifts-ceiling`). Missing independent seats block
checkpoints rather than being backfilled (ruling `missing-supervisor-never-implementer`).

```yaml
enforces: []
notes:
  - No per-skill confinement is claimed; operator permissions are not runner evidence.
  - All skills are model-loadable; U starts are guarded by the description and first workflow step.
```

Each skill declares its Kimi mode and unsupported semantics in `skill.yaml`. Existing mode-ceiling
and U-manual checks apply. Generated frontmatter uses only Agent Skills fields and package metadata.
The Kimi host exposes no verified shell plugin-validator command. `kimi doctor` checks configuration
files, not a plugin manifest. Packaging is checked offline and installed into isolated local state.

The existing text-only reviewer transport in `tests/learn/evals/subjects/kimi.ts` is unchanged.
Reviewer support does not imply an eval subject, installation, trigger or lifecycle acceptance.
This target adds no subject or optional learning-hook integration; ADR-0005 remains Proposed.

## Acceptance

Offline tests hold manifest identity, skill-set and mode parity, closed references, native U
markers, prose refusal, unchanged M content, absence of suppression keys and conservative
restrictions. The isolated local probe holds actual bundle installation and listing.

Live acceptance remains unrun: each U command must retain its leading marker and enter its first
step; ordinary prose and a later marker must refuse; an M request must load without an explicit
start; missing grants and independent evidence must still stop. Discovery alone proves none of
those behaviors. The receipt supplies exact cases for a separately authorized model session.
