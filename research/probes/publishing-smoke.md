# Publication and setup smoke receipt

Measured source: `c0201d6015947691e53daa8a1f06d01f703490b2` on `fm/ak-fixes`.
Host instruments: Claude Code 2.1.287, Codex CLI 0.159.0, Bun 1.3.10, Node 25.6.1,
Git and real `linearis@2026.8.0`. Every host install used isolated configuration directories.
The unpublished bundle came from `bun run ak build` at this source revision.

## Failing-first checks

Before the fix, the added focused tests failed in seven cases: linked-worktree detection,
backend-required team, blank token, unreadable previous manifest, downgrade, zsh status handling,
and the SSH shorthand source. The existing valid cases passed as negative controls.
At the measured source revision:

```text
$ bun test tests/maintenance.test.ts tests/linearis-guard.test.ts tests/version-gate.test.ts tests/marketplace-source.test.ts
26 pass, 0 fail, 89 expect() calls, exit 0
```

The same source tree passed the full suite before commit: 2717 pass, 1 donor-snapshot skip,
0 fail, exit 0. `bun run lint`, `bunx tsc --noEmit`, `bun run ak validate`, `bun run ak build`,
and `bun run ak build --check` exited 0. The validator reported one skipped donor-path check
because `.donors/` was unavailable here; that figure is not a provenance receipt.

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
an SSH key. The public GitHub `published` branch does not exist until the post-merge workflow runs,
so this test replaces only the network endpoint with a local remote.

## Linearis guard under zsh

`research/probes/linearis-guard.sh` extracts the executable guard from the backend document,
installs the pinned package in a scratch project, and routes real requests to a dead proxy. Its
negative control uses `npm exec --no` from a different project with linearis only on `PATH`.

```text
$ bash research/probes/linearis-guard.sh
PASS  negative control: npm exec --no accepts a PATH binary outside this project
PASS  zsh guarded success keeps result JSON
PASS  zsh guarded auth rejection becomes exit 42
linearis 2026.8.0, guard extracted from adapters/tracker/backends/linear-linearis.md at c0201d6: 0 failed
exit 0 (12 PASS rows)
```

The targeted tests also preserve exit 1 for an unrelated application error and keep stderr
warnings out of successful result JSON.

## Doctor and update against configured Git source

The installed Codex marketplace was registered from the local Git remote using the real
`--ref published` command. Its `CODEX_HOME/config.toml` has a Git source and `ref = "published"`.
`AK_PUBLISHED_ROOT` points to an isolated local bundle with the same `0.1.0` manifest. A fresh `CLAUDE_CONFIG_DIR`
contains no Claude install, so its warnings are expected:

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

Against an actual old local Claude marketplace, both commands exit 1 and say the configured
source is local, with a re-add remedy. Automated integration tests cover doctor and update from a
linked worktree and a subdirectory; bundled doctor rejects a blank token, a binding missing the
required team, and an unknown backend. The version-gate tests reject a missing published manifest,
a changed bundle at a reused version, and a downgrade; a valid version bump and first publish pass.

After merge, `.github/workflows/publish-bundle.yml` creates or updates `published` from `ak build`.
No release tag is needed. The remaining remote smoke is to run the README's Claude and Codex
GitHub install commands in fresh isolated homes after that workflow succeeds.
