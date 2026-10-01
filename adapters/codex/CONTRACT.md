# adapters/codex — host contract

Contract only. No implementation lives here.

The parallel host bundle. This file states what the Codex host provides, what the package requires,
which `schemas/common.schema.json#/$defs/capability` values it can satisfy, precisely which of them
**differ from `adapters/claude-code/CONTRACT.md`**, what degrades as a result, and how the bundle is
tested.

Observations marked **verified (donor)** were read from the pinned clone at
`compound-engineering@05c42da94fd318fa081f29d17bf947762aa477b1`. Observations marked
**verified (CLI)** were taken from `codex-cli 0.154.0` on this machine, except where §4 names a
later version for the install pair. Everything else is a requirement on the packager.

---

## 1. The multi-host manifest pattern

The donor pattern this package copies is **parallel per-host manifest directories at the repository
root, over one shared content tree**. Verified (donor) at the pin:

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Identity only: `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`. **No `skills` key** — the host discovers `skills/` |
| `.claude-plugin/marketplace.json` | `name`, `owner`, `metadata`, and one `plugins[]` entry with `source: "./"` |
| `.codex-plugin/plugin.json` | The same identity fields, **plus** `"skills": "./skills/"` and an `interface` block (display name, descriptions, category, capabilities, icon, brand color, default prompts) |
| `.cursor-plugin/plugin.json` | Identity fields plus `displayName`; different `keywords` |
| `plugin.json` (root), `.kimi-plugin/`, `.grok-plugin/`, `.devin-plugin/` | Further per-host copies of the same identity |

Two properties of the pattern matter more than the file list:

1. **The skill content tree is shared, not duplicated.** All manifests point at the same `skills/`.
2. **Identity parity is machine-enforced.** The donor's release validator reads each manifest and
   fails when a version disagrees with `package.json`
   (`compound-engineering@05c42da:src/release/components.ts`, the `does not match` checks around
   lines 197–213). The donor treats manifest drift as a release-blocking error, not a lint.

A third property is a deliberate divergence rather than a copy. The donor's Codex manifest registers
skills by **directory pointer** (`"skills": "./skills/"`) and its Claude manifest by **discovery**.
This package enumerates explicitly for claude-code (`adapters/claude-code/CONTRACT.md` §1) because
its install set is profile-dependent. For codex the packager emits whichever form the target CLI
accepts, and `ak build --check` asserts that the set of skills the codex bundle exposes is identical
to the set the claude-code bundle exposes for the same profile. Divergence between the two bundles is
a build failure, not a host difference.

What this package does **not** copy: the `interface` display block (marketing metadata, out of scope
for a catalog of engineering instructions), and the further host manifests the donor ships for hosts
this package does not target.

**Unverified — do not assert.** The donor's converter comments describe Codex's native plugin flow as
`codex plugin install` reading `.codex-plugin/plugin.json`
(`compound-engineering@05c42da:src/converters/claude-to-codex.ts`, the comment above
`includeSkills`). The CLI installed here exposes **`codex plugin add`**, not `install`
(verified (CLI), §4). The package does not claim to know which is correct for a given Codex version;
the packager pins the command the target CLI actually exposes and the smoke test in §5 is what
confirms it.

---

## 2. Bundle shape

```text
dist/codex/
├── .claude-plugin/marketplace.json # local marketplace registration for Codex CLI
├── .codex-plugin/plugin.json   # identity, skill registration, no interface block
├── skills/<id>/SKILL.md        # same bodies as dist/claude-code, different generated keys
├── skills/<id>/references/
└── NOTICE, LICENSE
```

Same canonical bodies, different generated frontmatter. The canonical tree is host-neutral; that is
the whole reason host keys are generated rather than written (`AUTHORING.md` §4).

---

## 3. Capabilities: what differs from claude-code

**Every `common#/$defs/capability` value carries the status
`adapters/claude-code/CONTRACT.md` §3 gives it, with no per-capability difference on this host.**
That table is the single statement for both hosts and is not restated here — a copy would be a
second thing to keep in step, and the copy that decided would be whichever one the code read. It
was restated here once, as prose naming thirteen of the sixteen capabilities, and the three it
omitted (`isolated-worktree`, `isolated-review-context`, `independent-context`) had no stated
status on this host at all until a parse of the table went looking for them.

What differs on this host is not which capabilities are supplied but which **restrictions** the
host can enforce. None of the rows below is a `capability` value:

| Restriction | claude-code | codex | Consequence |
|---|---|---|---|
| Per-skill suppression of model invocation | `disable-model-invocation: true`, documented host behavior | **No equivalent key verified** on `codex-cli 0.154.0` | The structural half of the invocation law is unavailable. See §3.1 |
| Tool restriction | `allowed-tools`, pre-approval only, denies nothing | Not emitted. The host has an OS-level sandbox instead, configured by the operator (`sandbox_permissions`, verified (CLI) in `codex plugin --help`) | Codex's confinement is real but **operator-owned and process-wide**, not per-skill. The package still declares side effects and still relies on neither |
| Bundled behavioral eval runner | `claude plugin eval`, `<eval dir>/**/case.yaml` | **None verified** | The eval corpus is not executable against this bundle by a host-native runner. See §5 |
| Manifest validator | `claude plugin validate --strict` | **None verified** | Bundle validation is `ak validate` plus an install smoke test |

### 3.1 The degradation that matters: U skills on a host with no manual-invocation flag

Plan §1.3: "Do not assume that a host's manual-invocation flag is portable." On this host it is not
portable, and the package does not pretend otherwise.

For every U skill in the codex bundle:

1. The `description`, copied verbatim from the canonical `SKILL.md`, opens by naming the skill's
   typed command and its class — `Human-started command: it runs only when the human's message
   begins with /ak:<id>`, followed where the skill has phase operations by the other authority that
   may start it — and says what to do on any other request: do not load or follow it, tell the human
   to type that command. On a host that cannot suppress model invocation, the description
   is the only thing between a U skill and an unrequested start, so it is written to be read that
   way. `ak validate`'s `human-start` check fails a U skill whose description omits the command
   (`invocation.description-omits-command`) or the class (`invocation.description-omits-class`).
2. The skill's own `## Authority` section names the command and states that a prose request is
   not a start, and its first workflow step is the stop: it names `/ak:<id>`, and started without
   the human's message beginning with it — or, where the skill has phase operations, without a
   runner-validated grant covering the phase — the skill stops, names the command and does nothing
   else. `human-start` fails a U skill whose first workflow step does not name the command or does
   not say to stop (`invocation.first-step-not-stop`).
3. The non-trigger eval case for that skill is a **required** gate for this bundle rather than an
   advisory one, because it is the only observation of the property in a live session: the checks
   above hold the text, not the behavior.

Every U skill's `packaging.hosts[]` entry for `adapter: codex` records this explicitly:
`mode: manual`, with the unsuppressible model invocation named in `unsupported`
(`schemas/skill.schema.json`). A U skill declaring anything but `manual` on this host is an
`ak build` error, `packaging.u-skill-not-manual`, and is packaged `manual` regardless; `ak validate`
does not report it, because the packager's plan is where it is decided — the declaration is the
record that the weakening was noticed rather than absorbed.

And the general rule, unchanged from `adapters/claude-code/CONTRACT.md` §4: a host that cannot
enforce a restriction an autonomous run requires exposes the skill in guided/manual mode and rejects
autonomous mode. The same section's amendment applies here unchanged: a capability this host does
not provide, but that an attached adapter supplies and fails closed on, is not silently absent and
does not cap the mode; `ak.install.yaml` decides attachment, and with no such file every fail-closed
adapter is attached (ruling `fail-closed-adapter-lifts-ceiling`). A supplier whose §1 names a
fallback lifts only where what it falls back on is available here too: `tracker-access`, with no
tracker backend configured, is lifted only while `kb-write` is (`adapters/tracker/CONTRACT.md` §1;
ruling `tracker-of-record-falls-back-to-kb`). That amendment reaches
capabilities only. It does not reach the manual-invocation restriction above, which is not a
capability and which no adapter supplies, so every U skill stays `mode: manual` on this host
whatever is attached; and it grants no delegated authority. `profiles/autonomy` does not install
against this host on its own, for the same missing `runner-grants` and `event-delivery`
capabilities.

---

## 4. Install

Verified (CLI), `codex-cli 0.154.0`:

```bash
codex plugin marketplace add <source>   # local path, owner/repo[@ref], HTTPS or SSH Git URL
codex plugin add <plugin>               # install from a configured or remote marketplace
codex plugin list
codex plugin remove <plugin>
```

Verified (CLI), `codex-cli 0.159.2`, for this bundle as a local marketplace. The first command
reads `.claude-plugin/marketplace.json` at the marketplace root and fails without one:

```bash
codex plugin marketplace add <dist/codex>
codex plugin add ak@agent-kit
```

`codex plugin marketplace add` accepts `--ref` for Git sources. The packager records the exact
command pair for the pinned target CLI version in the release notes; see the unverified-command note
in §1.

---

## 5. Testing

Tests this adapter owns, in `tests/adapters/`:

1. **Bundle parity** — the skill id set in `dist/codex` equals the skill id set in
   `dist/claude-code` for the same profile, and the `SKILL.md` bodies are byte-identical below the
   frontmatter.
2. **Manifest parity** — `version` and `license` agree across `package.json`,
   `dist/claude-code/.claude-plugin/plugin.json` and `dist/codex/.codex-plugin/plugin.json`.
   `name` and `description` agree between the two manifests and with `catalog.yaml`'s
   `package.id` and `package.description`, and **`package.json` is not a party to either**:
   `package.json` names and describes the npm package, a manifest names and describes what the
   host addresses. They are two names for two objects, so a check that forces them to agree can
   only be satisfied by renaming one of them to suit the check.

   The donor supports the `version` clause and no other. At
   `compound-engineering@05c42da:src/release/metadata.ts` the token `compoundPackage.` occurs
   exactly once — `:283`, comparing `package.json`'s version. Each manifest's description is
   *derived and written* rather than compared (`:259`, `:291-304`), which is why the donor ships
   one description in `package.json` and a different one in `.claude-plugin/plugin.json`; manifest
   `name` is compared manifest-to-manifest (`:403`); and the donor's own `package.json` carries no
   `license` key at all. The `license` clause is therefore this package's own release condition,
   `origin: conversation`, and is marked as such rather than attributed upstream.

   The Codex marketplace entry's plugin `name`, `version`, and `description` agree with
   `dist/codex/.codex-plugin/plugin.json`.
3. **No leaked host keys** — the codex bundle contains no `disable-model-invocation` and no
   `allowed-tools`; the claude-code bundle contains both where required. A key from one host's set
   appearing in the other's bundle is a failure.
4. **Non-trigger corpus completeness** — every U skill in the codex bundle has a non-trigger eval
   case, and every such case's prompt is drawn from that skill's `## Not for` section.
5. **Install smoke test** — the bundle now carries the marketplace manifest required by
   `codex plugin marketplace add <dist/codex>`; follow it with `codex plugin add ak@agent-kit`, then
   confirm the skills are listed. Run manually against the pinned CLI version at release time and
   record it as a receipt; it is not a CI gate because it requires a host install.

**Reported honestly, not worked around:** with no verified host-native eval runner for this host, the
behavioral corpus is executed against the claude-code bundle and, when a runner is attached, through
the host-neutral harness in `adapters/runner-contract/CONTRACT.md`. Results for the codex bundle
alone are `not-run`, recorded as such in the release evidence rather than inferred from the
claude-code run.

---

## 6. The learning runtime's hooks

`ak learn setup wire` registers three hooks in `$CODEX_HOME` when it exists, and skips this host
with a message when it does not: `ak learn hook session-start` on `SessionStart`,
`ak learn hook prompt` on `UserPromptSubmit`, which captures user corrections, and
`ak learn hook stop --source codex` on `Stop`. As on claude-code
(`adapters/claude-code/CONTRACT.md` §7), no skill requires a hook, the bundle ships none, and the
runtime's ledgers never live inside a project repository (ruling
`learning-runtime-is-host-adapter`).
