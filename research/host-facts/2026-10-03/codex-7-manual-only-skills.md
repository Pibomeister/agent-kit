# codex-7 — manual-only skills

**Fact as stated** (`C:L146`): `agents/openai.yaml` `policy.allow_implicit_invocation: false` stops
implicit invocation, while `$skill` still works.

**Instrument:** codex-cli 0.153.4; source `rust-v0.153.4` (`3d2ee51`); docs fetched 2026-10-03;
`probes/codex/codex-local-checks.sh` section L1 (no model called).

**Verdict:** verified. The mechanism is hiding the skill from the model, and a malformed file drops it.

## Evidence

Source. The metadata file is `agents/openai.yaml` (`ext/skills/src/loader/mod.rs:20-21`). When the
policy is false the skill entry is hidden from the prompt (`ext/skills/src/provider/host.rs:147-149`):

```rust
if !skill.allows_implicit_invocation() {
    entry = entry.hidden_from_prompt();
}
```

and it is left out of the skill tools (`ext/skills/src/catalog.rs:256-263`). An explicit `$name`, a
`skill://` path or a picker selection checks only `enabled` (`ext/skills/src/selection.rs:21-80`); the
unit test `prompt_hidden_skill_can_still_be_invoked` (`ext/skills/tests/skills_extension.rs:2369-2443`)
asserts it. An `openai.yaml` that fails to parse is ignored with a warning and default metadata
(`ext/skills/src/loader/metadata.rs:130-139`). Codex never parses `disable-model-invocation`.

Docs, `https://learn.chatgpt.com/docs/build-skills`, "Optional metadata":

> allow_implicit_invocation (default: true): When false, Codex won't implicitly invoke the skill based
> on user prompt; explicit $skill invocation still works.

Local check (`probes/codex/codex-local-checks.out.txt`), two repository skills under `.agents/skills/`:

```text
skill:manual-skill     absent from prompt     (policy.allow_implicit_invocation: false)
skill:visible-skill    listed in prompt
explicit $manual-skill SKILL.md body in debug prompt-input: no (prompt-input renders the mention as plain user text)
```

The last line is inconclusive by construction: `debug prompt-input` does not expand mentions, so the
explicit half rests on source, test and docs.

## Nuances

1. **Hidden, not denied.** The model cannot see the skill in its list; it could still read the
   SKILL.md through the shell if it found the file.
2. **A malformed `openai.yaml` silently drops the policy** and the skill is listed again.
3. The packager emits no such file today, and `adapters/codex/CONTRACT.md` line 90 says "No
   equivalent key verified" on 0.154.0. That statement is false at 0.153.4.

## What this changes

Open decision 7 has a working key on this host. The ADR weighs it against the redirect behaviour
ADR-0003 and ADR-0006 rely on: a hidden skill cannot tell a prose request to use its typed command.

## Re-derive

`bash probes/codex/codex-local-checks.sh`, section L1.
