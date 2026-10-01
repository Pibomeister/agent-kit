# Publication smoke receipt

The pre-fix GitHub checkout failed in an isolated `CLAUDE_CONFIG_DIR`:

```text
$ claude plugin marketplace add Pibomeister/agent-kit
✔ Successfully added marketplace: agent-kit
$ claude plugin install ak@agent-kit
✘ Failed to install plugin "ak@agent-kit": Source path does not exist: .../marketplaces/agent-kit/dist/claude-code
```

The publication candidate was built with `bun run ak build`, copied into an isolated local
marketplace shaped like the future `published` branch, and exercised with real Claude Code and
Codex plugin CLIs. Both home directories were empty before the smoke. The Codex JSON lines below
show the identifying fields; its path fields were omitted from this receipt:

The `git-subdir` source was also exercised against a local Git remote carrying the candidate
`published` branch, with `path: dist/claude-code` and `ref: published`:

```text
$ CLAUDE_CONFIG_DIR="$PWD/.work/smoke/git-home" claude plugin marketplace add "$PWD/.work/smoke/git-source"
✔ Successfully added marketplace: agent-kit-git-probe (declared in user settings)
$ CLAUDE_CONFIG_DIR="$PWD/.work/smoke/git-home" claude plugin install ak@agent-kit-git-probe
✔ Successfully installed plugin: ak@agent-kit-git-probe (scope: user)
```

The separate two-host smoke then used the same generated bundle directories in an isolated local
marketplace:

```text
$ CLAUDE_CONFIG_DIR="$PWD/.work/smoke/claude-home" claude plugin marketplace add "$PWD/.work/smoke/release"
✔ Successfully added marketplace: agent-kit (declared in user settings)
$ CLAUDE_CONFIG_DIR="$PWD/.work/smoke/claude-home" claude plugin install ak@agent-kit
✔ Successfully installed plugin: ak@agent-kit (scope: user)
$ CODEX_HOME="$PWD/.work/smoke/codex-home" codex plugin marketplace add "$PWD/.work/smoke/release" --json
{"marketplaceName":"agent-kit","alreadyAdded":false}
$ CODEX_HOME="$PWD/.work/smoke/codex-home" codex plugin add ak@agent-kit --json
{"pluginId":"ak@agent-kit","version":"0.1.0-dev"}
$ AK_PUBLISHED_ROOT="$PWD/.work/smoke/release" CLAUDE_CONFIG_DIR="$PWD/.work/smoke/claude-home" CODEX_HOME="$PWD/.work/smoke/codex-home" bun .work/smoke/release/dist/claude-code/bin/ak update
PASS Claude Code user: 0.1.0-dev -> 0.1.0
PASS Codex: 0.1.0-dev -> 0.1.0
$ AK_PUBLISHED_ROOT="$PWD/.work/smoke/release" CLAUDE_CONFIG_DIR="$PWD/.work/smoke/claude-home" CODEX_HOME="$PWD/.work/smoke/codex-home" bun .work/smoke/release/dist/claude-code/bin/ak doctor
PASS Claude Code marketplace source: resolves to ak 0.1.0. Remedy: No action needed.
PASS Codex marketplace source: resolves to ak 0.1.0. Remedy: No action needed.
PASS Claude Code plugin: enabled; installed 0.1.0; published 0.1.0. Remedy: No action needed.
PASS Codex plugin: enabled; installed 0.1.0; published 0.1.0. Remedy: No action needed.
WARN project enablement: no readable .claude/settings.json. Remedy: Set enabledPlugins["ak@agent-kit"] to true in this repo.
WARN tracker binding: no ak.tracker.yaml. Remedy: Add a project tracker binding if this repo uses an external tracker.
WARN tracker token: no binding token_file to check. Remedy: Add a valid tracker binding first.
WARN linearis: no linear-linearis binding to check. Remedy: Add the binding if this repo uses Linear.
```

The update was rerun at `0.1.0` and returned PASS for both hosts.
The bundled `bin/ak` was copied to an isolated `PATH`, marked executable, and invoked directly as
`ak update` and `ak doctor`; both returned the same results.

The branch does not exist on GitHub before merge; the publish workflow creates it after a green
push to `main`. The remote
GitHub install still needs the same isolated smoke after that workflow completes. No release branch
or tag was pushed during this PR.
