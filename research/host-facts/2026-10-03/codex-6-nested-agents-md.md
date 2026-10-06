# codex-6 — nested AGENTS.md

**Fact as stated** (`C:L145`): files load only along the root-to-working-directory chain; code
review applies the scoped files per changed file.

**Instrument:** codex-cli 0.153.4; source `rust-v0.153.4` (`3d2ee51`); docs fetched 2026-10-03;
`probes/codex/codex-local-checks.sh` section L1 (no model called).

**Verdict:** the first clause is verified. The second holds for GitHub review as code; for the CLI's
review it is an instruction to the model, not a loading rule.

## Evidence: the chain

Source, `core/src/agents_md.rs:1-16`: the project root is found by walking up to a
`project_root_markers` entry (default `.git`); every `AGENTS.md` from the root down to the working
directory is concatenated in that order; "We do **not** walk past the project root." Per directory
the order is `AGENTS.override.md`, then `AGENTS.md`, then configured fallback names, at most one file
(`agents_md.rs:210-281`). The combined budget is `DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024`
(`config/src/config_toml.rs:73`). A project marked untrusted loads no project docs
(`agents_md.rs:61-63`).

Docs, `https://learn.chatgpt.com/docs/agent-configuration/agents-md`, "How Codex discovers
guidance": "Starting at the project root (typically the Git root), Codex walks down to your current
working directory … Codex includes at most one file per directory."

Local check (`probes/codex/codex-local-checks.out.txt`), working directory `sub/deeper`, markers in
four files, prompt rendered by `codex debug prompt-input`:

```text
ROOT-AGENTS-L1         present
SUB-AGENTS-L1          present
SIBLING-AGENTS-L1      absent
BELOW-CWD-AGENTS-L1    absent
```

## Evidence: review

`core/src/tasks/review.rs:119` swaps in the review rubric, which says
(`prompts/templates/review/rubric.md:46-48`, "Repository Rule Attribution"): "Use the root and scoped
project instruction files applicable to changed files, respecting normal project-document precedence
… More-specific guidance wins on conflict". The loader is unchanged, so a CLI review started at the
root has only the root chain in context and is told to consult the scoped files.

Docs, `https://learn.chatgpt.com/docs/third-party/github`, "Customize what Codex reviews": "Codex
applies the root and more-specific guidance that covers each changed file, so unrelated changes don't
have to carry service-specific context." This describes `@codex review` on GitHub.

## Nuances

1. The 32 KiB budget is combined across the chain, and it is configurable.
2. Per-changed-file scoping in the CLI depends on the model reading the scoped file; it was not
   observed, because no Codex session ran.

## What this changes

`## Code Review Rules` sections in nested AGENTS.md files are a sound target for GitHub review and a
best-effort one for the CLI. The compiler's core has to fit the combined budget along the deepest
chain a project uses, not only the root file. On Codex a path-scoped article reaches a working agent
only when its directory is on the chain, so path rules there come from the guard's first-write deny.

## Re-derive

`bash probes/codex/codex-local-checks.sh`, section L1.
