# Publication and setup smoke receipt

Measured source: `1bc7ce052488ac0a0be9ebb61c0e66340944c3b1` on `fm/ak-fixes`. Its code is
identical to its parent `46a8f87`; that commit changed only this receipt.
Host instruments: Claude Code 2.1.287, Codex CLI 0.159.0, Bun 1.3.10, Node 25.6.1,
Git 2.50.1 (Apple Git-155) and real `linearis@2026.8.0`. Every host install used isolated
configuration directories.
The unpublished bundle came from `bun run ak build` at this source revision (exit 0, 0 errors,
0 checks skipped). The built Codex bundle carries `dist/codex/.claude-plugin/marketplace.json`
(marketplace `agent-kit`, plugin `ak` with source `./`) beside `dist/codex/.codex-plugin/plugin.json`.

## Failing-first checks

Before the fix, the added focused tests failed in seven cases: linked-worktree detection,
backend-required team, blank token, unreadable previous manifest, downgrade, zsh status handling,
and the SSH shorthand source. The existing valid cases passed as negative controls.
At the measured source revision:

```text
$ bun test tests/maintenance.test.ts tests/linearis-guard.test.ts tests/version-gate.test.ts tests/marketplace-source.test.ts
26 pass, 0 fail, 89 expect() calls, exit 0
```

This receipt does not quote a full-suite, lint or typecheck figure at this revision. Those are
the pipeline's test and lint gates, which run on the same head. The `ak build` figure above
comes from the working tree and is not a provenance receipt; use
`research/probes/validate-figure.sh` for that.

## HTTPS-only marketplace install

`research/probes/marketplace-https.sh` builds the bundle, creates a local Git remote with a
`published` branch, and sets `GIT_CONFIG_GLOBAL` to rewrite only
`https://github.com/Pibomeister/agent-kit.git` to that remote. `GIT_SSH_COMMAND=false` blocks
SSH for both trials. Real Claude Code reads the root marketplace manifest in an isolated
`CLAUDE_CONFIG_DIR`:

```text
$ bash research/probes/marketplace-https.sh
shorthand install exit=1
https install exit=0: Successfully installed plugin: ak@agent-kit (scope: user)
PASS: HTTPS source installs ak while SSH is disabled; shorthand is the negative control
exit 0
```

The shorthand is the deliberately failing control. The committed HTTPS source installs without
an SSH key. At the measured source revision, the public GitHub `published` branch did not yet exist,
so this test replaced only the network endpoint with a local remote.

## Linearis guard under zsh

`research/probes/linearis-guard.sh` extracts the executable guard from the backend document,
installs the pinned package in a scratch project, and routes real requests to a dead proxy. Its
negative control uses `npm exec --no` from a different project with linearis only on `PATH`.

```text
$ bash research/probes/linearis-guard.sh
PASS  negative control: npm exec --no accepts a PATH binary outside this project
PASS  zsh guarded success keeps result JSON
PASS  zsh guarded auth rejection becomes exit 42
linearis 2026.8.0, guard extracted from adapters/tracker/backends/linear-linearis.md at 1bc7ce0: 0 failed
exit 0 (12 PASS rows)
```

The targeted tests also preserve exit 1 for an unrelated application error and keep stderr
warnings out of successful result JSON.

## Doctor and update against configured Git source

A local bare remote holds a `published` branch laid out as `publish-bundle.yml` writes it
(`dist/` plus `.agents/plugins/marketplace.json`). `GIT_CONFIG_GLOBAL` rewrites only
`https://github.com/Pibomeister/agent-kit.git` to it, and `GIT_SSH_COMMAND=false` blocks SSH. In an
isolated `CODEX_HOME`, the real commands register and install from the GitHub URL:

```text
$ codex plugin marketplace add https://github.com/Pibomeister/agent-kit.git --ref published
marketplace_add_exit=0   # config.toml: source_type = "git", ref = "published"
$ codex plugin add ak@agent-kit --json
plugin_add_exit=0        # "version": "0.1.0"
```

`AK_PUBLISHED_ROOT` points at that release tree. Doctor and update ran from a scratch Git project
with a fresh `CLAUDE_CONFIG_DIR` holding no Claude install, so the Claude and project warnings are
expected:

```text
$ bun dist/claude-code/bin/ak doctor
WARN Claude Code marketplace source: not configured.
PASS Codex marketplace source: resolves to ak 0.1.0.
PASS Codex plugin: enabled; installed 0.1.0; published 0.1.0.
doctor_exit=0
$ bun dist/claude-code/bin/ak update
PASS Codex: 0.1.0 -> 0.1.0
update_exit=0
```

Against an old local Claude marketplace (a copy of `dist/claude-code` added by path, then
`claude plugin install ak@agent-kit`), both commands exit 1:

```text
FAIL Claude Code marketplace source: configured marketplace is local or points at another source.
doctor_exit=1
FAIL Claude Code update: configured marketplace is local or points at another source.
update_exit=1
```

Automated integration tests cover doctor and update from a linked worktree and a subdirectory;
bundled doctor rejects a blank token, a binding missing the required team, and an unknown backend.
The version-gate tests reject a missing published manifest, a changed bundle at a reused version,
and a downgrade; a valid version bump and first publish pass.

After merge, `.github/workflows/publish-bundle.yml` creates or updates `published` from `ak build`.
No release tag is needed. The real GitHub smoke follows below.

## Post-merge smoke against GitHub's real `published` branch

The first publication completed at
https://github.com/Pibomeister/agent-kit/actions/runs/36942947494 (success).
`main` was `60df574f3298b818c440327e1d4b4abd67f91e37`; the real GitHub
`published` branch was `b1ae37039086a7011303e838037ae8a61b89eb4e`.
The commands below ran from a fresh scratch Git project with fresh `HOME`,
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`. An empty `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_NOSYSTEM=1` and `GIT_SSH_COMMAND=false` kept the run HTTPS-only and
independent of the operator's Git settings. The local `bin` folder was added
first on `PATH` for the downloaded `ak`. The four host install commands and
maintenance-command URL are the README commands; only the destination of the
`curl -o` download was the isolated `bin` folder.

```text
published=b1ae37039086a7011303e838037ae8a61b89eb4e
2.1.287 (Claude Code)
codex-cli 0.159.0
1.3.10
git version 2.50.1 (Apple Git-155)

$ claude plugin marketplace add Pibomeister/agent-kit
Adding marketplace…Cloning via SSH: git@github.com:Pibomeister/agent-kit.git
Refreshing marketplace cache (timeout: 120s)…
Cloning repository (timeout: 120s): git@github.com:Pibomeister/agent-kit.git
SSH clone failed, retrying with HTTPS: https://github.com/Pibomeister/agent-kit.git
Refreshing marketplace cache (timeout: 120s)…
Cloning repository (timeout: 120s): https://github.com/Pibomeister/agent-kit.git
Clone complete, validating marketplace…
Cleaning up old marketplace cache…
✔ Successfully added marketplace: agent-kit (declared in user settings)
exit=0

$ claude plugin install ak@agent-kit --scope project
Installing plugin "ak@agent-kit"...✔ Successfully installed plugin: ak@agent-kit (scope: project)
exit=0

$ codex plugin marketplace add Pibomeister/agent-kit --ref published
Added marketplace `agent-kit` from https://github.com/Pibomeister/agent-kit.git#published.
Installed marketplace root: /Users/eduardopicazo/orca/workspaces/agent-kit/fm-ak-fixes/.work/real-github/codex/.tmp/marketplaces/agent-kit
exit=0

$ codex plugin add ak@agent-kit
Added plugin `ak` from marketplace `agent-kit`.
Installed plugin root: /Users/eduardopicazo/orca/workspaces/agent-kit/fm-ak-fixes/.work/real-github/codex/plugins/cache/agent-kit/ak/0.1.0
exit=0

$ curl -fsSL https://raw.githubusercontent.com/Pibomeister/agent-kit/published/dist/claude-code/bin/ak -o /Users/eduardopicazo/orca/workspaces/agent-kit/fm-ak-fixes/.work/real-github/bin/ak
exit=0

$ chmod +x /Users/eduardopicazo/orca/workspaces/agent-kit/fm-ak-fixes/.work/real-github/bin/ak
exit=0

$ ak doctor
PASS Claude Code marketplace source: resolves to ak 0.1.0. Remedy: No action needed.
PASS Codex marketplace source: resolves to ak 0.1.0. Remedy: No action needed.
PASS Claude Code plugin: enabled; installed 0.1.0; published 0.1.0. Remedy: No action needed.
PASS Codex plugin: enabled; installed 0.1.0; published 0.1.0. Remedy: No action needed.
PASS project enablement: ak@agent-kit is enabled in this repo. Remedy: No action needed.
WARN tracker binding: no ak.tracker.yaml. Remedy: Add a project tracker binding if this repo uses an external tracker.
WARN tracker token: no binding token_file to check. Remedy: Add a valid tracker binding first.
WARN linearis: no linear-linearis binding to check. Remedy: Add the binding if this repo uses Linear.
exit=0

$ ak update
PASS Claude Code project: 0.1.0 -> 0.1.0
PASS Codex: 0.1.0 -> 0.1.0
exit=0

$ ak doctor
PASS Claude Code marketplace source: resolves to ak 0.1.0. Remedy: No action needed.
PASS Codex marketplace source: resolves to ak 0.1.0. Remedy: No action needed.
PASS Claude Code plugin: enabled; installed 0.1.0; published 0.1.0. Remedy: No action needed.
PASS Codex plugin: enabled; installed 0.1.0; published 0.1.0. Remedy: No action needed.
PASS project enablement: ak@agent-kit is enabled in this repo. Remedy: No action needed.
WARN tracker binding: no ak.tracker.yaml. Remedy: Add a project tracker binding if this repo uses an external tracker.
WARN tracker token: no binding token_file to check. Remedy: Add a valid tracker binding first.
WARN linearis: no linear-linearis binding to check. Remedy: Add the binding if this repo uses Linear.
exit=0
```

## Follow-up bundle transport check (unpublished 0.1.1)

From this follow-up working tree, `bun run ak build` exited 0. The version gate
`tools/publish/version-gate.sh dist` exited 0 against GitHub's published 0.1.0.
The workflow's `tar -czf`/`tar -xzf` transfer preserved the executable bit on
`dist/claude-code/bin/ak` (`test -x` exited 0). Running that extracted command
with `doctor --json` in the checkout exited 1 because no host plugin is installed
in the checkout's configuration; its JSON parsed into eight findings. This
checks artifact transport and JSON output, not a live 0.1.1 installation.

The follow-up guard probe (`bash research/probes/linearis-guard.sh`) exited 0 with
15 PASS rows and 0 failures. Its new auth rows ran under `sh -e`, `bash -e` and
`zsh -e`, each preserving the rejection text and exit 42. The 42-line guard
blocks in the backend and tracker reference are byte-identical.
