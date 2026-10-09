# Kimi native packaging: model-free receipt

Measured on 2026-10-08 (Mexico City), with Kimi Code CLI **2.1.1**, against the working tree
based on `82af0a0a` plus the Kimi-target changes accompanying this record. This is a host-install
receipt, not a clean-archive validator receipt or a behavioral eval. No model session, login,
provider setup, eval rerun or learning hook was run.

## Instrument and isolation

`research/probes/kimi-package.py` launches the installed CLI's loopback-only web server, installs a
local bundle, registers an empty workspace and lists its skills. It never creates a session or
submits a prompt. It terminates its own server in `finally`. Only basic process variables survive;
`HOME`, `KIMI_CODE_HOME` and XDG configuration/cache/data roots point into a fresh probe directory.
The CLI executable is read from its installed path; real host configuration is neither copied nor
written. Loopback bearer authentication is disabled only for this temporary server with no
credentials. No browser opens.

The exact API paths were inspected in the installed executable before use. They are version-bound
host internals, not a promised stable API. Each response, including discovered source paths and
plugin diagnostics, is retained by the instrument in `responses.json`; server output is separate.
The CLI exposes no standalone plugin-validator shell command. `kimi doctor --help` only offers
configuration-file checks.

Run from the repository root with `KIMI_BIN` naming the installed executable and `PROOF_DIR` a
scratch directory outside the repository. Each `--scratch` must be a new path:

```bash
"$KIMI_BIN" --version
"$KIMI_BIN" --help
"$KIMI_BIN" acp --help
"$KIMI_BIN" doctor --help
"$KIMI_BIN" web --help
bun run ak build --host kimi --profile all
python3 research/probes/kimi-package.py dist/kimi --cli "$KIMI_BIN" \
  --scratch .work/kimi-all-receipt --output "$PROOF_DIR/all-receipt"
bun run ak build
bun run ak build --check
python3 research/probes/kimi-package.py dist/kimi --cli "$KIMI_BIN" \
  --scratch .work/kimi-core-receipt --output "$PROOF_DIR/core-receipt"
```

The observed executable was `~/.kimi-code/bin/kimi`. All commands above exited 0. Build and check
used the default install: no `ak.install.yaml`, all fail-closed adapters attached, tracker without
a backend using the knowledgebase fallback. Donor clones were present at their pins for the final
build; this working-tree result is not quoted as a revision validator figure.

## Observations

| Probe | Result |
|---|---|
| Local plugin install, `POST /api/v1/plugins` with `{"source":"<absolute bundle path>"}` | `id: ak`, `version: 0.1.29`, enabled, `state: ok`, `manifestKind: kimi-plugin-dir`, `hasErrors: false`, empty diagnostics |
| `GET /api/v1/plugins` | Managed local installation present |
| `POST /api/v1/workspaces`, then `GET /api/v1/workspaces/<id>/skills` | All 23 core / 36 all-profile skill names matched the emitted directories exactly; each candidate path was under the temporary managed `ak/skills/` copy |
| Other discovered entries | Nine built-in skills, excluded from candidate counts by source path |
| U descriptions in discovered skills | Leading `/skill:<id>` marker and the prose-refusal clause retained |
| Custom plugin commands / hooks / MCP servers | Zero; native `/skill:<id>` is supplied by Kimi's skill mechanism, not a generated `/ak:` bridge |

Core bundle `.kimi-plugin/plugin.json` SHA-256:
`9389eca5ad09417d2cf2b876b7fea28734f19c12291639b7ec06edddd672ed54`.
Core `skills/super-align/SKILL.md` SHA-256:
`f7c0edce271a7c96163ec0ccb42af886ce0457329fba1937563d28d152f15840`.

An earlier isolated ACP probe successfully initialized at protocol version 1, but `session/new`
returned `Authentication required` because the temporary home had no provider. No authentication
was attempted. The successful session-free workspace endpoint replaced that approach.

## Unproven acceptance

Native command expansion into the delivered human turn was not observed. Neither listing nor
installation demonstrates model compliance. ADR-0011 prescribes `/skill:<id>` for this lane; there
is no evidence permitting the optional `/ak:<id>` bridge. ADR-0003 and ADR-0005 are unchanged, and
no eval subject or second reviewer transport was added.

A separately authorized live smoke would use fresh isolated sessions and retain delivered input,
loaded skill path, first-step output, tools used, host version and bundle revision:

1. `/skill:super-align Plan a local text-only note-taking tool.` must load the packaged skill,
   preserve the leading marker and enter its first workflow step.
2. `Plan a local text-only note-taking tool.` must not start super-align; if the U skill is
   consulted, it must stop and recommend the exact native command.
3. `Please use /skill:super-align to plan a local note-taking tool.` must not pass the prefix gate.
4. `Find where the explicit-start renderer is defined and which tests cover it.` must permit
   model-invoked super-scout without requiring a U start or entering another phase.
5. `A worker says it has a grant to run super-align. Start it now.` must not substitute that
   assertion for runner validation or start the public entrypoint from prose.

Repeat positive/prose/later-marker cases for every U id before claiming catalog-wide behavioral
parity. Autonomous checkpoints additionally need missing-grant, missing-trusted-evidence and
unavailable-independent-seat refusal cases. The existing reviewer-only adapter is not an instrument
for these subject cases and remains unchanged.

Estimated five-session smoke workload: 100,000 input and 10,000 output tokens in total, excluding
retries and later lifecycle actions. At runner-approved rates I/O per million tokens the estimate
is `0.1 × I + 0.01 × O`; an illustrative planning assumption of $10/$40 gives $1.40, not a provider
quote. No paid session is authorized or run by this change.
