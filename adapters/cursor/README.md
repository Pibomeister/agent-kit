# Cursor host adapter

Install agent-kit so Cursor Cloud Agents and Cursor IDE agents in a consuming
repository load the catalog skills and role prompts.

The contract, capability honesty and doc citations are
[`CONTRACT.md`](CONTRACT.md). This file is the downstream interface Firstmate
and other repos vendor against.

## Build

From the agent-kit checkout, after dependencies are installed:

```bash
bun run ak build --host cursor
```

writes `dist/cursor/`. To write a dedicated directory instead:

```bash
bun run ak build --host cursor --out /tmp/ak-cursor
```

A relative `--out` is resolved from the **current working directory**, not the
repository root. The directory is **replaced**. `ak build` refuses `--out` of
`/`, `$HOME` or an ancestor of it, the repository root or an ancestor of it, the
current directory or an ancestor of it, a symlink that resolves into one of
those, or a non-empty directory that is not a previous agent-kit bundle for
that host (`.cursor-plugin/ak.json`). An empty directory, a nonexistent path,
or a directory that already holds that build record is allowed. A legacy
record that does not list `outputs` is matched only at the top level.

`--out` requires `--host`. Combine `--check` with `--out` to verify that
directory rather than `dist/cursor`. A default `ak build` with no `--host`
still writes every host under `dist/` and is unchanged for claude-code, codex,
grok, kimi and droid.

## Vendor into a consuming repo (Cloud Agents)

Cursor Cloud Agents load **project** skills from `.cursor/skills/<name>/SKILL.md`
in the cloned repository. Personal `~/.cursor/skills/` are not used by
Automations. Copy the overlay trees; `rsync -a` merges and does not delete the
repo's `.cursor/environment.json`, `.cursor/hooks.json` or `.cursor/mcp.json`.

```bash
BUNDLE="${BUNDLE:-dist/cursor}"   # or the --out directory
REPO="${REPO:?set REPO to the consuming checkout}"

mkdir -p "$REPO/.cursor/skills" "$REPO/.cursor/agents" "$REPO/.cursor/rules" \
  "$REPO/.cursor/roles" "$REPO/.cursor/references" "$REPO/.cursor/schemas" \
  "$REPO/.cursor/templates" "$REPO/.cursor/bin" "$REPO/.cursor/licenses" \
  "$REPO/.cursor/adapters"

rsync -a "$BUNDLE/.cursor/skills/"     "$REPO/.cursor/skills/"
rsync -a "$BUNDLE/.cursor/agents/"     "$REPO/.cursor/agents/"
rsync -a "$BUNDLE/.cursor/rules/"      "$REPO/.cursor/rules/"
rsync -a "$BUNDLE/.cursor/roles/"      "$REPO/.cursor/roles/"
rsync -a "$BUNDLE/.cursor/references/" "$REPO/.cursor/references/"
rsync -a "$BUNDLE/.cursor/schemas/"    "$REPO/.cursor/schemas/"
rsync -a "$BUNDLE/.cursor/templates/"  "$REPO/.cursor/templates/"
rsync -a "$BUNDLE/.cursor/bin/"        "$REPO/.cursor/bin/"
rsync -a "$BUNDLE/.cursor/licenses/"   "$REPO/.cursor/licenses/"
rsync -a "$BUNDLE/.cursor/adapters/"   "$REPO/.cursor/adapters/"
cp -n "$BUNDLE/.cursor/catalog.yaml"   "$REPO/.cursor/catalog.yaml"
```

Licence and attribution files ship at `.cursor/licenses/` (`LICENSE`, `NOTICE`,
`LICENSES/*`, `provenance/licenses/*`). Vendor steps never write the consuming
repo's root `LICENSE`, `NOTICE` or `LICENSES/`. `rsync` of those trees is
additive: it does not delete `.cursor/environment.json`, `.cursor/hooks.json`
or `.cursor/mcp.json`. Merge `$BUNDLE/AGENTS.md` into the consuming repo's
root `AGENTS.md`. Do not replace an existing root `AGENTS.md`. Nested
`.cursor/AGENTS.md` would only apply while the agent works on files under
`.cursor/`.

Emitted paths the host reads:

| Path in the consuming repo | What Cursor loads |
|---|---|
| `.cursor/skills/<id>/SKILL.md` | Skills (`/` menu and automatic) |
| `.cursor/agents/<slug>.md` | Custom subagents (reviewer seats) |
| `.cursor/rules/ak-super-review.mdc` | Rule, `alwaysApply: false` |
| repo-root `AGENTS.md` (merged) | Always-available instructions |

## IDE plugin install (not Cloud Automations)

```bash
mkdir -p "$HOME/.cursor/plugins/local/ak"
rsync -a dist/cursor/ "$HOME/.cursor/plugins/local/ak/"
```

Reload the Cursor window. The plugin manifest is
`.cursor-plugin/plugin.json`. Skills are registered at `./.cursor/skills/<id>`.
This path is for the local IDE. Cloud Automations still need the repo vendor
steps above.

## How a Cloud Agent runs super-review

On the target branch or pull request:

1. Confirm `.cursor/skills/super-review/SKILL.md` is in the repo the agent cloned.
2. Invoke `/super-review` with `full`, `readiness`, or `delta` (delta only inside
   an open run). The agent doing the work may start `full` and `readiness`.
3. For each reviewer seat, dispatch the subagent in `.cursor/agents/` whose
   `name` is the role slug (`reviewer-standards`, `reviewer-spec`,
   `code-review-security`, …). Those reviewer files set `readonly: true`.
4. Do not paste the author's narrative into a reviewer prompt. Cursor gives the
   subagent a clean context window; it does not attest isolation.
5. The author does not sit a reviewer seat and does not close a finding.

`ak doctor` and `ak update` do not manage Cursor. The isolation-probe version
check runs only where `research/host-facts/` holds a review-isolation note with
a real host version. Re-run the build and rsync to refresh a vendored copy.

## Self-host on this repository

agent-kit vendors that overlay into `.cursor/` so a Cloud Agent cloning this
repo discovers the skills without a separate install. Root `AGENTS.md` stays
the maintainer guide. After a packaging change run
`tools/cursor/self-host.sh --vendor`. `tools/cursor/self-host.sh --check` fails
when the committed copy differs from a fresh `ak build --host cursor`.
`.cursor/environment.json` is repo-owned and is not part of the overlay.
`tools/cursor/install.sh` (the Cloud Agent `install` command) may append one
marked PATH line to the first of `~/.bash_profile`, `~/.bash_login`,
`~/.profile` that exists, which is the order `bash -l` reads. If none of those
files exist, it writes `~/.profile`. It does that only when `~/.bun/bin/bun` is
1.3.14 and a login shell cannot already find that version.

On a Cursor cloud worker it may also create `/usr/local/bin/bun` as a
symlink to `~/.bun/bin/bun`. A cloud worker is `CURSOR_AGENT_WORKER_ID` or
`CURSOR_WORKER_POOL_NAME` non-empty, and `CURSOR_AGENT_CLI_LOCAL_MODE` not
equal to `true`. `CURSOR_AGENT=1` is also set by local IDE and CLI agents, so
it is not enough. Cloud Agent tool shells are not login shells, so they do
not read the login PATH line. The symlink is the PATH entry those shells
already search. If `/usr/local/bin` is not writable, `sudo_link_system_bun`
uses passwordless `sudo -n`. It never replaces a `/usr/local/bin/bun` that
is not that symlink. Off-cloud, it never replaces an existing
`~/.bun/bin/bun` that is not the pin. On any other machine it stays inside
`$HOME` and prints the skip on stderr. If those worker markers are absent,
sudo never runs.
