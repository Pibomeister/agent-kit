# adapters/droid — host contract

Factory Droid consumes one bundle across served families. This contract covers packaging and
model-free installation; it does not claim live workflow acceptance. Model and provider selection
belong to the runner or operator configuration, never the catalog or family-specific skill copies.

## 1. Bundle and installation

`bun run ak build --host droid` emits `dist/droid/` from the shared catalog and selected profile:

| Path | Purpose |
|---|---|
| `.factory-plugin/plugin.json` | Package identity; Droid discovers the root `skills/` directory |
| `.factory-plugin/marketplace.json` | Local marketplace with the package entry pointing at `./` |
| `.factory-plugin/ak.json` | Build record, selected profile, modes and unsupported restrictions |
| `skills/<id>/SKILL.md` | Generated frontmatter and native explicit-start instructions |
| `skills/<id>/references/`, `skills/<id>/assets/`, `references/shared/` | Shared dependencies with the same command rendering |
| `bin/`, `LICENSE`, `NOTICE`, `LICENSES/`, `provenance/licenses/` | Shared tools and attribution |

There is no host-native behavioral eval corpus in this target. Native plugin structure and the
Claude-layout translation are documented in [Factory plugins](https://docs.factory.com/harness/plugins).
The Claude bundle installs, but translation leaves its `/ak:<id>` authority text unchanged. The
native target is necessary for the `/<id>` contract in ADR-0011, not for a second content tree.

From an isolated process with the roots in §3, register the absolute `dist/droid` path with
`droid plugin marketplace add <absolute-path>`. Read the registered name with
`droid plugin marketplace list`, then run `droid plugin install ak@<registered-name> --scope user`
and `droid plugin list --scope user`. The local directory's name can determine the marketplace
name; do not assume it equals the manifest's name. Remote publication installation is unverified.
`ak doctor` and `ak update` do not manage this host; use Droid's plugin commands.

## 2. Authority and capability limits

[Factory skills](https://docs.factory.com/harness/skills) documents native `/<id>` invocation.
Packaging renders exact canonical U-command references throughout skill descriptions, bodies,
local assets and shared references into that form. The first workflow step still checks that the
human message begins with it; ordinary prose, later mentions, a loaded file and host selection
state alone are not authority. The existing validated-grant alternatives retain their own checks
(ADR-0011; ruling `entrypoint-phase-operation-split`). If client expansion removes the leading
human marker, stop: do not infer it from the skill body. End-to-end marker retention is unverified.

Every skill remains model-loadable. Neither `disable-model-invocation` nor `user-invocable` is
emitted. U skills retain manual mode and their stop-first gate (ADR-0003); ADR-0005 remains Proposed.
M descriptions and automatic invocation remain available. Every skill that declares a codex row
declares a Droid row with the same `unsupported` limits; M skills stay `mode: manual` there because
Droid's autonomy enforcement is unproven. Undeclared skills use the packager's manual default; this
metadata does not suppress loading or grant autonomy.

The shared capability ceiling is `adapters/claude-code/CONTRACT.md` §3. Droid uses that same
conservative packaging ceiling: tool-mediated reads, execution and storage do not attest isolation,
independence, grant validation or trusted evidence. No successful install promotes those claims.
Attached runner/evidence adapters must actually supply their declared capabilities or refuse
(ruling `fail-closed-adapter-lifts-ceiling`; ruling `missing-supervisor-never-implementer`).

```yaml
enforces: []
notes:
  - allowed-tools is descriptive metadata, not a sandbox.
  - No filesystem, network, process or independent-context restriction is claimed by this bundle.
```

Only `allowed-tools` is emitted as host-specific frontmatter. It declares intent, not enforcement.
Process permissions and tool availability remain operator-owned and belong in acceptance evidence.
The learning integration's Droid SessionStart hook runs `ak learn hook session-start --source droid`,
so the session roster names human-only commands in the native `/<id>` form. Existing Droid installs
pick up that command on their next `ak learn setup wire`. Session capture is unchanged.

## 3. Model-free probe and isolation

The audit at `be03347` identified Claude reuse as a candidate. Rechecked on source
`82af0a0ac171a4e1cff4819c9eaa164ea1c747be`: the installed CLI reports **0.233.0**, rather than the
audit's 0.229.0. The core Claude bundle registered and installed successfully; `plugin list`
reported it active. Inspection found all 23 packaged skill files in its private cache, still
containing `/ak:super-align`. This is installation and file evidence, not runtime skill discovery.
The native target subsequently installed and listed active in the same private root. All 63 files
matched the generated core bundle, including its 23 skills and `/super-align` authority text.
Those native-target observations measure the working-tree implementation, not the base revision.

Isolation was established before installation. The shipped CLI's path resolver uses
`FACTORY_HOME_OVERRIDE` as the parent of `.factory/`, including plugins, cache and logs. This is
an inspected CLI implementation detail, not a documented stable isolation API. Its help exposes
`--settings`, which merges runtime settings and does not itself relocate persistent storage.
The probe used these roots inside the worktree's ignored `.work/droid-host/`:

| Environment variable | Private root |
|---|---|
| `FACTORY_HOME_OVERRIDE` | `home` (Droid appends `.factory`) |
| `XDG_CONFIG_HOME` | `config` |
| `XDG_CACHE_HOME` | `cache` |
| `FACTORY_DROID_AUTO_UPDATE_ENABLED` | `false` |

The process inherited an empty environment except these values and a minimal executable search
path. On macOS, `sandbox-exec` denied network access and reads/writes below the real user
`.factory`, `.claude`, `.codex`, `.grok` and `.kimi-code` directories. Thus a relocation regression
fails the probe instead of accessing real configuration. Re-probe isolation when the CLI changes;
if roots cannot be isolated, do not install. No credentials, login or inference were used.

## 4. Acceptance bindings

Each served family is a separate acceptance binding, recording **host + CLI version + served
model/provider + bundle revision + tool profile**. Also retain the bundle digest, permission
settings, actual served identity, commands, exit statuses, stream/tool evidence and session IDs.
A requested identity alone is insufficient. Family labels do not prove independent review seats,
and a pass on Droid proves nothing about another host serving the same identity.

For each binding, acceptance must cover native U explicit start, U prose refusal (including a
non-leading marker), M automatic load, local/shared reference resolution, a refused ungranted
operation, and a bounded lifecycle case. Client expansion must preserve the human's leading
marker independently of the loaded instructions. Missing identity or invalid transport is an
unavailable trial, not a pass. Different tool inventories require separately recorded outcomes.

`tests/packaging.test.ts` checks emitted identity and membership, exact U rendering and command
boundaries, retained refusal text, unchanged M descriptions, model loadability and empty enforcement
claims. These offline assertions do not prove live obedience. Per-family trials and their budget
estimate belong in the change's PR description; they require separately authorized execution.
