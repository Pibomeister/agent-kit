# Grok permission-cancellation diagnosis, 2026-10-02

This follow-up diagnoses the three invalid sessions in the
[quiet-machine smoke](2026-10-02-grok-smoke-3.md) without starting another authenticated host
session. The evidence is the retained `/tmp/agent-kit-grok-smoke-3/` transcript dumps, committed
receipts 12–14, the subject adapter and permission mediator, and Grok 1.0.46's installed help and
user guide.

## Cause

The cancellations came from two controls that the receipt had collapsed into one description:

- The subject launches Grok with `--permission-mode dontAsk`. Bare `env` is read-only to the scorer
  but had no matching Bash allow rule, so it fell through to that mode. The final ship command also
  fell through because its embedded `python3 -c` segment is neither allowlisted nor read-only to the
  scorer. The assignment mediator did not refuse either call: it only rewrites assignment-led read
  chains and otherwise emits no decision. No Grok sandbox flag was present.
- The build session's final Grep was already covered by the adapter's explicit `--allow Grep`.
  `invalidSession` names the last attempted call whenever Grok reports `stopReason: cancelled`, but
  that stop reason also covers the host turn cap. The smoke ran with `--max-turns 20`; its retained
  dump omitted the final `num_turns`, so “refused Grep” was an inference, not evidence that the
  permission layer rejected Grep. The retained evidence cannot distinguish a turn-20 cancellation
  from another cancellation after that allowed call.

The earlier redirect probe supplies the missing behavioral distinction: an explicit deny rejected
`ls -la 2>/dev/null && git status -sb 2>/dev/null`, returned the failure to the model, and the same
session retried without redirects and ended normally. A deny-rule refusal is therefore recoverable;
an unmatched call falling through to `dontAsk` and a cap cancellation are the paths to avoid.

## Bounded repair

The subject stays in `dontAsk`; no broader permission mode, sandbox profile, scorer rule, grader,
timeout, prompt or invalid-session rule changed.

- `Bash(env)` now admits only the exact bare environment listing. This is safe at this boundary
  because `cleanEnv` already limits the subject to process basics, adapter-declared variables and
  explicit operator opt-ins. `env <command>`, `printenv` and token-display forms remain unapproved.
- `Bash(python3 *)` is now an explicit deny. The smoke's embedded interpreter remains refused, but
  it takes the same recoverable explicit-deny path proved by the redirect session rather than the
  unmatched `dontAsk` path.
- The committed matrix example sets Grok `max-turns: null`. The evaluator's 300-second timeout
  remains the outer bound, while the launch no longer cuts off an allowed inspection at an
  indistinguishable host turn cap.

The fixture `grok-smoke-3-env.doc-derived.jsonl` preserves the archived call and terminal-event
shape. It is derived from the parsed smoke transcript because the raw host stream and its final
turn count were not retained. The regression checks that `env` is scorer-read-only and admitted,
that embedded interpreter code remains scorer-non-read-only and explicitly denied, and that the
documented Grok launch is uncapped.

## No-spend checks

`grok --version` reported `grok 1.0.46 (2765805b9442) [stable]`. `grok --help` confirms the
`--allow`, `--deny`, `--permission-mode` and `--max-turns` launch flags and lists `dontAsk` as a
permission mode. The CLI exposes no permission-policy dry run or rule-explanation command, so the
changed live rule behavior cannot be verified against the host without an authenticated session.
No such session was run.

Offline regression command:

```bash
bun test tests/learn/evals-subjects.test.ts tests/learn/evals-panel.test.ts
```

Result: 62 passed, 0 failed.

## Live confirmation, not run

After copying the committed matrix example to `.work/eval-matrix.yaml` and replacing its opaque
seat bindings, this exact sequential command confirms the three ordinary cases:

```bash
for case in dev-super-build-p1 dev-diagnose-p1 dev-super-ship-s1; do
  bun tests/learn/evals/trigger-eval.ts \
    --set dev \
    --arm natural \
    --subject subject-grok \
    --jobs 1 \
    --cases "$case" \
    --json "/tmp/agent-kit-grok-permission-fix/$case/result.json" \
    --dump-transcripts "/tmp/agent-kit-grok-permission-fix/$case/transcripts"
done
```

The expected host cost is **$0.39468084**, the sum reported by the same three smoke-3 cases. The
uncapped launch can run until the unchanged 300-second evaluator timeout, so that figure is a point
estimate rather than a ceiling. This command was not run.

