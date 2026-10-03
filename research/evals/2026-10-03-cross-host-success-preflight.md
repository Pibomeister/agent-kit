# Cross-host success setup, 2026-10-03

This record repairs the setup behind
[`2026-10-03-cross-host-receipts.md`](2026-10-03-cross-host-receipts.md). It makes no paid or
authenticated model call. The only host commands run were version, help and local login-status
checks. Subject execution remains behind `--execute` and needs separate approval.

## Earliest divergence

The first invalid assumption was that a dry run proving argv shape also proved a runnable session.
It did not test permission fallback, host identity fields, receipt retention or the grader surfaces.

| Chain | Trigger | Mask | Visible symptom | Repair |
| --- | --- | --- | --- | --- |
| Grok permission | A model emits one multiline or compound Bash call. | The grant emits `Bash(*)`, but `dontAsk` rejects a call that still requires approval. | Three sessions end `cancelled` after a refused Bash call. | Case grants now restrict the built-in tool set with `--tools` and use `--always-approve` inside the disposable case sandbox. The ordinary read-only path keeps `dontAsk` and its deny rules. |
| Grok timeout | The 16-turn case runs against the default 600-second wall clock. | The receipt filters invalid rows down to one reason and discards partial events. | Session 7 says only `timeout`, with no duration, transcript, cost or identity. | Effective timeout is at least 600 seconds and 60 seconds per declared turn, so this case receives 960 seconds. Every invalid row and its raw stream now remains in `sessions`. |
| Served identity | The runner uses Codex `exec --json`. | That stream exposes the thread id and usage but no resolved model; the other adapters store their model under an ambiguous internal field. | Compact receipts carry only requested bindings and cannot prove which models served. | Codex uses the app-server handshake, whose `thread/start` response returns the resolved model. Claude and Grok retain their host model plus provider request ids. Every result exposes `servedModel`, request ids where available and a session/thread id. Missing served identity makes an otherwise valid session invalid. |
| Grader evidence | A criterion describes persisted content or an action. | Several graders read the last reply, or ask a final-file surface to prove event ordering. Created artifact contents are then deleted with the scaffold. | Correct evidence can be graded as absent, and the receipt cannot be regraded offline. | Persisted-content criteria read the final file; the approved-spec hash check reads the trace; its ticket graders read the named ticket. Receipts retain raw host output and content-addressed artifact snapshots. |

The installed Codex CLI is `0.159.2`. Its `exec --json` contract has no model field in
`ThreadStartedEvent`, while `ThreadStartResponse` from app-server has required `model` and
`modelProvider` fields. The upstream definitions are
[`exec_events.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs) and
[`thread.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).

## Failed-criterion classification

The four Sol raw session streams were read from the prior worktree's ignored `.work` receipts. The
committed Claude receipt retains outcomes and two short observations, but not its raw transcripts or
created artifacts. That missing source is a harness defect; Claude classifications below are limited
to evidence the committed receipt actually retains.

| Host / case | Failed or unresolved criterion | Classification | Evidence |
| --- | --- | --- | --- |
| Sol / delegated refresh rotation | `persists-stop-evidence` | Model behaviour | All reviewers found bare readiness booleans without criterion evidence. |
| Sol / delegated refresh rotation | `preserves-human-authorship` | Model behaviour | Two reviewers accepted the human owner; one found no explicit boundary limiting agent work. The disagreement is a subject-output ambiguity, not a missing surface. |
| Sol / delegated refresh rotation | `cites-the-consultation-artifact` | Model behaviour | The ticket stored bare paths instead of a transcript/receipt evidence reference with a judgment-evidence note. |
| Sol / vague checkout criterion | `persists-readiness-before-stop` | Model behaviour | All reviewers found the six readiness booleans lacked per-criterion evidence. |
| Sol / vague checkout criterion | `turns-vagueness-into-frontier-question` | Model behaviour | The reply asked for scope, workload, metric and target, but two reviewers found no verification path. |
| Sol / oversized change | `persists-assessment-before-stop` | Grader defect | Two reviewers accepted the final file; one rejected it only because a file-only surface could not prove when it was persisted. The repaired criterion judges final persisted content only. |
| Sol / oversized change | `orders-a-reversible-stack` | Model behaviour | All reviewers found the exact ordered stack absent. |
| Sol / approved specification | `consumes-hash-bound-approval` | Grader/case defect | The stream checks all four hashes, but the grader defaulted to the final reply. It now reads the trace. |
| Sol / approved specification | `emits-zero-context-tickets` | Grader/case defect | The final reply linked a ticket while its contents were outside the grading surface. The case now names the output path and the grader reads it. |
| Sol / approved specification | `tickets-carry-three-evidence-blocks` | Grader/case defect | Same missing ticket-content surface. |
| Claude / oversized change | `persists-assessment-before-stop` | Grader defect | The old temporal criterion required ordering evidence the final-file surface could not supply. No raw Claude artifact was retained for a deeper claim. |
| Claude / oversized change | `orders-a-reversible-stack` | Model behaviour | The committed observation says the subject offered the stack or an exception instead of recording the required ordered recommendation. |
| Claude / approved direction with open decisions | all three failures | Model behaviour | The committed observation says two implementation tickets were created before the open decisions were resolved. This auxiliary case is not in the four-case rerun. |
| Claude / approved specification | all three judged criteria | Harness defect | They were skipped at the cost ceiling, so the case was ungraded. The missing raw stream also prevents offline recovery. |

No grader bar was lowered. The repaired criteria remove impossible timing claims from file-only
surfaces and point evidence claims at the evidence they already required. An offline reference test
runs every one of the four cases with a marker for each judged criterion planted only on the surface
that criterion is meant to read (the output file, the trace or the final reply), and with no marker
in a counterpart run. A stub judge passes a criterion only when its marker reaches it, so a grader
aimed at the wrong surface fails, with one exception: the trace ends with the final reply, so a
criterion meant for the reply and moved to the trace is not detected. This proves the grading
surfaces to that extent, without a judge model call; it does not show that a judge model applies the
criteria correctly.

## Free reproduction and verification

The exact refused Bash shape from session 8 is retained in the original receipt. The local test
asserts only the launch argv: a granted case now starts Grok with the restricted `--tools` list plus
`--always-approve` and without `dontAsk`. It does not start Grok, so whether the host admits the
compound shape under that argv is not shown here.

```text
bun test tests/learn/evals-case-runner.test.ts tests/learn/evals-subjects.test.ts \
  tests/grader-lint.test.ts tests/schemas.test.ts tests/typecheck.test.ts
455 pass, 0 fail
```

The zero-cost preflight command was run after `bun run ak build --profile all`:

```sh
bun tests/learn/evals/case-runner.ts --preflight \
  --host claude --host codex --host grok \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml
```

All three hosts returned `ok: true` for all seven checks:

```text
claude  binary login bundle-skills case-fixtures tool-permissions served-identity-fixture timeouts
codex   binary login bundle-skills case-fixtures tool-permissions served-identity-fixture timeouts
grok    binary login bundle-skills case-fixtures tool-permissions served-identity-fixture timeouts
```

Each login check is local and redacts the credential content. The identity check parses stored host
output fixtures. Preflight never starts a subject or reviewer.

The full unpaid suite was also run. Its first run reported 2,899 passes and one skip. Three
typecheck failures observed in that run were fixed and the complete typecheck file then passed. The
remaining unrelated failure reproduced when isolated: `worker CLI cannot use supervisor verbs
through the live service` reached its 30-second test timeout, and under continued machine load
`worker bunfig and PATH cannot forge the two supervisor seats` also reached that existing timeout.
The associated unhandled assertion is the same readiness race recorded on main; this change does
not touch `tests/runner/runner.test.ts` or its product path. The separate runner-guard repair owns
that known repository-wide risk.

## Three-model rerun estimate

The Claude column uses the prior four-case measured amounts. The Sol column uses the four valid
2026-10-03 receipts. No valid Grok grading cost exists, so its estimate uses the corresponding
Claude amount instead of treating invalid partial sessions as representative.

| Case | Claude | Sol | Grok estimate |
| --- | ---: | ---: | ---: |
| Delegated refresh-token rotation | $1.84511520 | $0.87766336 | $1.84511520 |
| Vague checkout-speed criterion | $0.38056000 | $0.57576404 | $0.38056000 |
| Refused oversized-change split | $0.35358000 | $0.32225344 | $0.35358000 |
| Approved specification produces tickets | $1.24043260 | $0.49037672 | $1.24043260 |
| Per-model subtotal | **$3.81968780** | **$2.26605756** | **$3.81968780** |

Estimated total: **$9.90543316**. A conservative ceiling takes the larger observed amount for each
case and applies it to all three models: **$12.04467552**. Round that to a **$12.05 hard cap** if the
rerun is approved.

Stop rules:

1. Rebuild and rerun preflight at the exact revision immediately before the first paid session. Any
   red check stops the run.
2. Run one session at a time. A missing `servedModel`, missing host correlation id, permission
   refusal, timeout, non-zero host exit, unavailable grader or ungraded result stops the whole run.
3. A graded failure stops the remaining cases for that model because that model can no longer pass
   the four-case proof set.
4. Before each launch, stop if cumulative reported spend plus the next session's table amount would
   exceed the approved cap. A session with no cost is charged its table amount for this gate.
5. Do not retry a session or substitute a binding without a new approval. Requested bindings never
   stand in for the receipt's served identity.

The paid rerun has not started and remains a separate approval decision.
