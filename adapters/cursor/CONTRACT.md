# adapters/cursor — host contract

Contract only. The packager that emits this bundle is `src/packaging/`.

This file states what the Cursor IDE and Cursor Cloud Agent host provides, which
`schemas/common.schema.json#/$defs/capability` values it can satisfy, how the
contract degrades where it cannot, and how a consuming repository vendors the
bundle into a layout Cursor actually discovers.

Observations marked **verified (docs)** were read from Cursor's published
documentation on 2026-11-03. Each cited URL is listed in §8. Observations marked
**unverified** were not confirmed in those pages and are not implemented as
guessed paths. Everything else is a requirement on the packager.

```yaml
enforces: []
notes:
  - Cursor honors disable-model-invocation, and this package does not emit it.
  - Subagent readonly is a host permission hint, not attested seat isolation.
  - No filesystem, network or process confinement is claimed by this package.
```

---

## 1. Bundle shape

`ak build --host cursor` emits:

```text
dist/cursor/
├── .cursor-plugin/
│   ├── plugin.json            # Cursor Plugin manifest; skills[] enumerated
│   ├── marketplace.json       # one plugin entry, source "./"
│   └── ak.json                # build record, profile, modes, exclusions
├── .cursor/
│   ├── skills/<id>/SKILL.md   # project / Cloud Agent discovery
│   ├── skills/<id>/references/
│   ├── agents/<role>.md       # custom subagents for catalog roles
│   ├── rules/ak-super-review.mdc
│   ├── roles/, references/, schemas/, bin/, catalog.yaml
├── AGENTS.md                  # merge into the consuming repo root
├── LICENSES/, provenance/licenses/
└── NOTICE, LICENSE
```

The content tree is nested under `.cursor/` so that copying `.cursor/skills/` and
`.cursor/agents/` onto a consuming repository is the layout Cloud Agents clone
with the repo. Relative links inside packaged skills are rewritten for that
nesting. Plugin manifests and licence texts stay at the bundle root.

**Verified (docs):** project skills are `.cursor/skills/<name>/SKILL.md`
([skills](https://cursor.com/docs/skills)). Cloud Automations load repository
`.cursor/skills/`, not unsynced personal skills. Cursor Plugins use
`.cursor-plugin/plugin.json` and discover `skills/` by default, or a custom
`skills` path ([plugins reference](https://cursor.com/docs/reference/plugins)).
This bundle sets `"skills"` to the enumerated `.cursor/skills/<id>` directories
so plugin install and repo vendoring share one tree.

**Not emitted:** `.cursor/environment.json`. Cloud environment config is owned by
the consuming repository
([cloud setup](https://cursor.com/docs/cloud-agent/setup)). Emitting one here
would overwrite a downstream environment. **Not emitted:** `.cursor/hooks.json`
and `hooks/hooks.json`. Cursor can run project hooks
([hooks](https://cursor.com/docs/hooks)); this bundle does not ship a guard or
learning hook on this host.

---

## 2. Generated frontmatter keys

The canonical `SKILL.md` carries spec keys only (`AUTHORING.md` §4). This adapter
adds none of Cursor's extra keys:

| Cursor key | Emitted? | Why |
|---|---|---|
| `name`, `description` | yes | Required by [skills](https://cursor.com/docs/skills); `name` matches the folder |
| `paths` / legacy `globs` | no | Scoping is the consuming repo's |
| `disable-model-invocation` | no | ADR-0003; every skill stays model-loadable |
| `icon`, `color` | no | Custom Mode badge styling; not required |

Custom Modes keep a skill in context for the whole session when the human picks
the skill and submits with Option+Enter / Alt+Enter
([prompting](https://cursor.com/docs/agent/prompting)). Any skill with valid
frontmatter can back a mode. This package does not emit extra mode files.

U skills remain `mode: manual`. Cursor inherits each skill's `claude-code`
packaging row when it has no Cursor row. The shared capability ceiling still
caps the declared mode. The native explicit start is `/<id>`, matching the `/`
menu skill name ([skills](https://cursor.com/docs/skills); ADR-0011).

---

## 3. Capability support

Every `common#/$defs/capability` value carries the status
`adapters/claude-code/CONTRACT.md` §3 gives it, with no per-capability difference
that would raise the ceiling. That table is what `ak validate` parses. Restating
it here would be a second copy. Cursor-specific host features that are not in
that enum:

| Feature | Status | Detail |
|---|---|---|
| `isolated-review-context` | `partial` | Docs only, not session-tested. Custom subagents have their own context window and start clean ([subagents](https://cursor.com/docs/subagents)). The parent includes whatever it puts in the task prompt. The host does not attest that a reviewer never saw the author's narrative. Upgrade when a Cloud Agent reviewer subagent whose prompt omitted the author's narrative cannot read the parent transcript |
| `independent-context` | `not-provided` | Same as claude-code §3: no excluded-lineage attestation. Host-only verifier receipts are `host-unattested` |
| Subagent dispatch | `partial` | Docs only, not session-tested. Project subagents are `.cursor/agents/*.md` with `name`, `description`, optional `readonly` ([subagents](https://cursor.com/docs/subagents)). Cloud Agents can use subagents. Cloud subagents on isolated VMs exist (`/in-cloud`); this bundle does not require that path. Upgrade when a Cloud Agent session dispatches one of those files, starts with a clean context, and `readonly: true` is observed to block writes |
| Hooks / guard | `partial` | Docs only. `.cursor/hooks.json` is supported in IDE and Cloud Agents, including `preToolUse`, `subagentStart` / `subagentStop`, `stop` ([hooks](https://cursor.com/docs/hooks), [cloud agents](https://cursor.com/docs/cloud-agent)). This bundle ships none. A missing hook fails open. User-level `~/.cursor/hooks.json` is not available on Cloud Agent VMs. Upgrade when a shipped hook is session-tested on Cloud Agents |
| Memory | `not-provided` | Product "Memories" is not a package-owned ledger. This bundle does not wire `ak learn` on Cursor. Unverified as an isolation boundary |
| Transcript locations | `partial` | Cloud Agent conversation state is stored on Cursor's backend, not as a documented repo path ([security](https://cursor.com/docs/cloud-agent/security)). `subagentStop` input includes `agent_transcript_path` ([hooks](https://cursor.com/docs/hooks)). The parent IDE transcript's on-disk path is **unverified**. Built-in Cursor Cloud MCP exposes run transcripts. This package cannot deny a reviewer reading a parent transcript by path |

Attached fail-closed adapters lift the ceiling the same way as on other hosts
(ruling `fail-closed-adapter-lifts-ceiling`). An unavailable independent seat
blocks its checkpoint (ruling `missing-supervisor-never-implementer`).

---

## 4. Host-capability honesty

Cursor documents `disable-model-invocation: true` as hiding the skill from
automatic application while still allowing `/skill-name`
([skills](https://cursor.com/docs/skills)). **Not used.** The U skill's
description clause and stop-first workflow step hold the law.

`readonly: true` on a subagent restricts writes
([subagents](https://cursor.com/docs/subagents)). Reviewer agents in this bundle
set it. It is a host permission hint. "Reviewers cannot edit" is still enforced
by the review protocol, not by this flag as a sandbox.

Grant validation, attested independence and trusted evidence are **not**
provided. Delegated-grant entrypoints are unavailable without a runner.
`profiles/autonomy` does not install against this host on its own.

---

## 5. Install

Downstream interface (exact commands): `adapters/cursor/README.md`.

```bash
bun run ak build --host cursor
# or a dedicated directory (replaced wholesale). Relative --out is from cwd:
bun run ak build --host cursor --out /tmp/ak-cursor
```

Vendor into a consuming repository (Cloud Agents and IDE agents in that repo):

```bash
rsync -a dist/cursor/.cursor/skills/   "$REPO/.cursor/skills/"
rsync -a dist/cursor/.cursor/agents/   "$REPO/.cursor/agents/"
rsync -a dist/cursor/.cursor/rules/    "$REPO/.cursor/rules/"
rsync -a dist/cursor/.cursor/roles/    "$REPO/.cursor/roles/"
rsync -a dist/cursor/.cursor/references/ "$REPO/.cursor/references/"
rsync -a dist/cursor/.cursor/schemas/  "$REPO/.cursor/schemas/"
rsync -a dist/cursor/.cursor/bin/      "$REPO/.cursor/bin/"
# merge dist/cursor/AGENTS.md into the repo-root AGENTS.md; do not overwrite
```

`rsync` of those trees is additive: it does not delete
`.cursor/environment.json`, `.cursor/hooks.json` or `.cursor/mcp.json`.

IDE plugin smoke (local, not Cloud Automations): copy the bundle to
`~/.cursor/plugins/local/ak` and reload
([plugins](https://cursor.com/docs/plugins)). Team marketplace import needs
`.cursor-plugin/marketplace.json` at a repository root
([plugins reference](https://cursor.com/docs/reference/plugins)). Remote
marketplace publication is unverified.

`ak doctor` and `ak update` do not manage this host.

---

## 6. Testing

Tests this adapter owns live in `tests/cursor-packaging.test.ts` and the shared
packaging suite:

1. **Discovery layout** — every authored skill is `.cursor/skills/<id>/SKILL.md`
   with `name` equal to the folder and a `description`. Every authored role is
   `.cursor/agents/<slug>.md` or listed as excluded with a reason. Unauthored
   catalog skills appear in `.cursor-plugin/ak.json` `excluded`.
2. **Frontmatter** — no `disable-model-invocation`. U descriptions and first
   steps use `/<id>`. M descriptions are unchanged.
3. **Additive default** — claude-code, codex, grok, kimi and droid plans contain
   no `.cursor/` paths and keep their previous manifest locations.
4. **`--out`** — requires exactly one `--host`; relative `--out` is from the
   current directory; `--check --out` verifies that directory. The write refuses
   `/`, `$HOME` and its ancestors, the repository root and its ancestors, cwd
   and its ancestors, a symlink into those, and a non-empty directory without
   this host's build record. A legacy build record without `outputs` is matched
   only at the top level. Default `ak build` still writes `dist/<host>`.
5. **`ak validate`** — the tree with this adapter present is clean.

Live Cloud Agent discovery, slash expansion retaining the leading `/<id>`, and
subagent `readonly` enforcement are **unverified** in a session. They are
acceptance cases, not this bundle's offline proof.

---

## 7. super-review and reviewer seats

A Cursor Cloud Agent on a branch or PR starts review by invoking `/super-review`
(model-started `full` and `readiness` per ADR-0013; `delta` stays inside an open
run). The skill body, roles and `bin/ak-gate.mjs` travel in the vendored
`.cursor/` tree.

Context separation on Cursor is **partial**:

- Dispatch each reviewer seat as the matching `.cursor/agents/<slug>.md`
  subagent. Verified: each subagent has its own context window and does not see
  prior conversation history unless the parent puts it in the prompt
  ([subagents](https://cursor.com/docs/subagents)).
- Reviewer agents set `readonly: true`.
- The parent must not paste the author's narrative into the reviewer task.
- Cursor does not attest excluded lineage. A reviewer can still be briefed with
  author text. Isolation is conventional, as on claude-code.
- The author does not sit a reviewer seat and does not close a finding (ruling
  `missing-supervisor-never-implementer`).

There is no second review pipeline. Public wrappers and the supervisor pair run
the same protocol.

---

## 8. Documentation URLs this contract relied on

| URL | What it confirmed |
|---|---|
| https://cursor.com/docs/skills | Project skill dirs `.cursor/skills/` and `.agents/skills/`; `SKILL.md` `name`/`description`/`paths`/`disable-model-invocation`; Cloud Automations need repo `.cursor/skills/`; `/` invocation; Custom Modes; compatibility dirs `.claude/skills/` and `.codex/skills/` (not used here) |
| https://cursor.com/docs/rules | `.cursor/rules/*.mdc`; frontmatter `description`, `globs`, `alwaysApply`; plain `.md` in that folder is ignored; `AGENTS.md` at repo root and nested, applied when working in that directory |
| https://cursor.com/docs/subagents | `.cursor/agents/*.md`; `name`, `description`, `readonly`; own context window; Cloud Agents supported; parent supplies the prompt |
| https://cursor.com/docs/plugins | Cursor Plugin `.cursor-plugin/plugin.json`; local `~/.cursor/plugins/local`; marketplace import |
| https://cursor.com/docs/reference/plugins | Manifest fields including `skills`/`agents` custom paths; default `skills/` discovery; `.cursor-plugin/marketplace.json` shape; agent and rule frontmatter |
| https://cursor.com/docs/agent/prompting | Custom Modes: Option+Enter / Alt+Enter keeps a skill in context |
| https://cursor.com/docs/hooks | `.cursor/hooks.json`; Cloud support matrix; `subagentStop.agent_transcript_path`; fail-open not claimed as a sandbox |
| https://cursor.com/docs/cloud-agent | Cloud Agents run repo `.cursor/hooks.json`; Cursor Cloud MCP transcripts |
| https://cursor.com/docs/cloud-agent/setup | `.cursor/environment.json` for VM setup; resolution order; Cloud Agents read `AGENTS.md` |
| https://cursor.com/docs/cloud-agent/best-practices | Commit project skills; repo rules `.cursor/rules/*.mdc` |
| https://cursor.com/docs/cloud-agent/security | Conversation state stored on Cursor backend, not a documented workspace transcript path |

**Unverified, therefore not implemented as a discovery path:** a bare repo-root
`skills/` directory; `.cursor/AGENTS.md` applying to the whole repo (nested
`AGENTS.md` is scoped to that directory); the on-disk path of an IDE parent
transcript; whether Cloud Agents load project `.agents/skills/` as well as
`.cursor/skills/` (Automations are documented only for `.cursor/skills/`).
