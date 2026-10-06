# Host-fact receipts, 2026-10-03

One receipt per host fact the constitution-support brief lists for verification (its Appendix B,
`research/sources/mission-brief-constitution-support.md` `C:L130-148`). The design in
`docs/decisions/0009-constitution-support.md` depends on these facts, and this directory is the
evidence that each one holds on the installed hosts, or how it differs.

## Instruments

| Item | Value |
|---|---|
| Machine | Linux 6.8.0-138-generic, x86_64 |
| Claude Code | `claude --version` prints `2.1.288 (Claude Code)`; binary `~/.local/share/claude/versions/2.1.288`, sha256 `0298068b686e7fdbaf9402a7a587bb7f49c0b0e084de09f69145a0719207640c` |
| Codex | `codex --version` prints `codex-cli 0.153.4`; npm package `@openai/codex@0.153.4`; native binary `vendor/x86_64-unknown-linux-musl/bin/codex`, sha256 `56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da` |
| Codex source | `openai/codex` tag `rust-v0.153.4`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (2026-09-04), the tag matching the installed CLI. Source paths below are relative to `codex-rs/` at that commit |
| Claude Code docs | Fetched 2026-10-03 as raw markdown from `https://code.claude.com/docs/en/<page>.md`: `hooks` (sha256 `bb10057a…2dec`), `permissions` (`998f954e…eef6`), `memory` (`fe99e50e…e2cb`), `sandboxing` (`89b54972…295f`), `context-window` (`6beaae83…50cd`), `settings-reference` (`76582550…7e5c`), `changelog` (`48577d55…4501`) |
| Codex docs | Fetched 2026-10-03: `https://learn.chatgpt.com/docs/hooks`, `…/docs/enterprise/managed-configuration`, `…/docs/agent-configuration/agents-md`, `…/docs/build-skills`, `…/docs/third-party/github`. The `developers.openai.com/codex/…` addresses redirect to these |
| Repository | agent-kit at `7c1c530`; nothing in the repository was executed for these receipts |

A digest pins what was read on the day; the docs pages are living documents and will move.

## Verdicts

| Receipt | Fact as the brief states it | Verdict |
|---|---|---|
| [claude-code-1](claude-code-1-hook-failures.md) | Timed-out hooks don't block; exit 1 without JSON is non-blocking; exit 2 blocks | Verified, nuance: every exit code but 0 and 2 is non-blocking without JSON, including 127 for a missing script |
| [claude-code-2](claude-code-2-hook-context-timing.md) | PreToolUse additionalContext lands next to the tool result, after the tool runs | Verified |
| [claude-code-3](claude-code-3-path-rules.md) | `paths:` rules load when Claude reads a matching file, not on every tool use | Verified, nuance: 2.1.288 also loads them on Write and Edit |
| [claude-code-4](claude-code-4-agents-md-loading.md) | AGENTS.md skipped when a CLAUDE.md exists; `claude-md-and-agents-md` loads both (2.1.277+) | Verified, nuance: the setting is honoured only from user, `--settings` or managed settings, never from a repository |
| [claude-code-5](claude-code-5-permission-gaps.md) | `git push` deny misses `git -C . push`; Read/Edit deny misses subprocesses; sandbox covers Bash and children | Verified; the sandbox is off by default and needs `socat` on Linux |
| [claude-code-6](claude-code-6-precedence.md) | Hook decisions don't bypass deny or ask rules | Verified |
| [claude-code-7](claude-code-7-compaction.md) | Project-root CLAUDE.md is re-read after compaction | Verified |
| [codex-1](codex-1-ask.md) | `permissionDecision: "ask"` is parsed but unsupported; hook failed, call proceeds | Verified from source and docs; not observed live |
| [codex-2](codex-2-hook-trust.md) | Non-managed hooks skipped until trusted, trust per hash; managed hooks trusted by policy | Verified, nuance: the hash covers the hook definition, not the script it runs |
| [codex-3](codex-3-managed-delivery.md) | requirements.toml `[hooks]` enforces but doesn't distribute scripts; `[features].hooks = true` forces hooks on | Verified |
| [codex-4](codex-4-hook-failures.md) | Callback error, timeout or malformed response fails without blocking | Verified from source and docs; not observed live |
| [codex-5](codex-5-apply-patch.md) | apply_patch arrives as `tool_input.command` holding the patch text, with no file path | Verified from source and docs; nuance: a patch run through the shell arrives as Bash |
| [codex-6](codex-6-nested-agents-md.md) | AGENTS.md loads only along root-to-cwd; review applies scoped files per changed file | First half verified; second half holds for GitHub review, and the CLI review only instructs the model to do it |
| [codex-7](codex-7-manual-only-skills.md) | `allow_implicit_invocation: false` stops implicit invocation; `$skill` still works | Verified, nuance: the skill is hidden from the model's list, and a malformed `openai.yaml` drops the policy |
| [codex-8](codex-8-context-cap.md) | Hook additionalContext capped near 2,500 tokens by default | Verified, nuance: about 10,000 bytes per handler, spilled to disk rather than dropped |

No fact was contradicted. Two facts in the brief rest on figures the repository has since moved
past; they are recorded in the ADR rather than here, because neither is a host fact.

## Live sessions

The brief allows a handful of short live sessions, each under the existing login with an isolated
configuration directory. Every Claude Code session ran under `env -i` with `HOME`, `PATH`, `LANG`,
`TERM`, the probe variable and `CLAUDE_CONFIG_DIR` pointing at a fresh directory holding only a copy
of the OAuth credentials file. No API key was set, no plugin, user setting or managed setting was
present, and `~/.claude` was never written.

| # | Script | Window (UTC) | Facts |
|---|---|---|---|
| 1 | `probes/claude-code/probe-a.sh` | 02:32:12–02:32:51 | claude-code-1, -2, -5, -6 |
| 2 | `probes/claude-code/probe-c.sh` | 02:33:26–02:33:59 | claude-code-3, -4 (default) |
| 3 | `probes/claude-code/probe-c2.py` | 02:34:25–02:34:44 | claude-code-7 |
| 4 | `probes/claude-code/probe-b.sh` | 02:35:08–02:35:11 | claude-code-4 (setting) |

A fifth launch, of probe B with no credentials copied, stopped at `Not logged in` before any model
call and is not counted.

**No Codex session ran.** No file-based Codex login exists on this machine: there is no
`auth.json` under `~/.codex` or anywhere below the home directory, and `codex login status` with an
empty `CODEX_HOME` prints `Not logged in`. Copying a login was the only route the brief allows, so
the Codex facts that only a live session can show are marked *not observed live*. The captain
accepted those verdicts on 2026-10-03, as ADR-0009 records. Every Codex verdict
rests on the source at the tag, the docs, and `probes/codex/codex-local-checks.sh`. That script calls
no model: it renders the prompt with `codex debug prompt-input`, lists hooks over `codex app-server`,
and runs the installed binary in a `--network none` container to place a file at
`/etc/codex/requirements.toml` without root.

## Re-derive

Each receipt names its own commands. The probes need the CLI versions above. The Codex source reads
need a checkout of the tag:

```bash
git clone --filter=blob:none --no-checkout https://github.com/openai/codex codex-src
git -C codex-src sparse-checkout set codex-rs docs && git -C codex-src checkout rust-v0.153.4
```
