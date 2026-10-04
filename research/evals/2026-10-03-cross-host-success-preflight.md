# Cross-host success setup, 2026-10-03

This record repairs the setup behind
[`2026-10-03-cross-host-receipts.md`](2026-10-03-cross-host-receipts.md). It makes no paid or
authenticated model turn. The host commands run were version, help and local login-status checks,
one flag given without its value to read the argument parser's reply, and two handshakes that send
no prompt: Codex `initialize` plus `thread/start`, and Grok `initialize` plus `session/new`. Both
handshakes use the copied login. Subject execution remains behind `--execute` and needs separate
approval.

## Earliest divergence

The first invalid assumption was that a dry run proving argv shape also proved a runnable session.
It did not test permission fallback, host identity fields, receipt retention or the grader surfaces.

| Chain | Trigger | Mask | Visible symptom | Repair |
| --- | --- | --- | --- | --- |
| Grok permission | A model emits one multiline or compound Bash call. | The grant emits `Bash(*)`, but `dontAsk` rejects a call that still requires approval. | Three sessions end `cancelled` after a refused Bash call. | Case grants now restrict the built-in tool set with `--tools` and use `--always-approve` inside the disposable case sandbox. The ordinary read-only path keeps `dontAsk` and its deny rules. |
| Grok timeout | The 16-turn case runs against the default 600-second wall clock. | The receipt filters invalid rows down to one reason and discards partial events. | Session 7 says only `timeout`, with no duration, transcript, cost or identity. | The wall clock is the case's `timeout_seconds` raised to a floor of 600 seconds and of 60 seconds per declared turn, so this 16-turn case receives 960 seconds. `timeout_seconds` is a minimum: it can lengthen a run past the floor and cannot shorten it. Every started session, valid or not, is one row of the single `sessions` list with its own `validity`, duration, exit code and stream hash. A session whose grading aborts the run is recorded under `aborted` the same way. |
| Served identity | The runner uses Codex `exec --json`. | That stream exposes the thread id and usage but no resolved model; the other adapters store their model under an ambiguous internal field. | Compact receipts carry only requested bindings and cannot prove which models served. | Codex uses the app-server handshake, whose `thread/start` response returns the resolved model. Claude and Grok retain their host model plus provider request ids. Every result exposes `servedModel`, request ids where available and a session/thread id. Missing served identity makes an otherwise valid session invalid. |
| Grader evidence | A criterion describes persisted content or an action. | Several graders read the last reply, or ask a final-file surface to prove event ordering. Created artifact contents are then deleted with the scaffold. | Correct evidence can be graded as absent, and the receipt cannot be regraded offline. | Persisted-content criteria read the final file; the approved-spec hash check reads the trace; its ticket graders read the named ticket. The raw host output and the artifact contents are written to an ignored `.work/case-runner/<name>.raw.json`; the receipt given to `--json` carries only their SHA-256 hashes and that file's path and hash. Judge reasons, the launch argv, the call an invalid reason quotes and the error text of an aborted session stay in that ignored file too; the committed row keeps the verdicts, the program name with a hash of the argv, the class of the invalid reason and the stage an abort happened at. |

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
488 pass, 0 fail
```

The zero-cost preflight command was run after `bun run ak build --profile all`:

```sh
bun tests/learn/evals/case-runner.ts --preflight \
  --subject <claude subject> --subject <codex subject> --subject <grok subject> \
  --case evals/super-bound/delegated-refresh-token-rotation/case.yaml \
  --case evals/super-bound/vague-checkout-speed-criterion/case.yaml \
  --case evals/super-bound/refused-oversized-change-split/case.yaml \
  --case evals/super-bound/approved-spec-produces-tickets/case.yaml
```

Preflight takes the same `--subject` selection `--execute` will run, from the local
`.work/eval-matrix.yaml`, and probes each selected subject's host once. The host checks below
returned `ok: true` on all three hosts at Claude Code 2.1.289, Codex 0.159.2 and Grok 1.0.46. That
run predates the `grader-readiness` check and selected the hosts by name; the host checks themselves
are unchanged.

```text
claude  binary login bundle-skills case-fixtures cli-flags
codex   binary login bundle-skills case-fixtures cli-flags thread-identity
grok    binary login bundle-skills case-fixtures cli-flags tool-names
```

`grader-readiness` now sits in each host row. It fails when a selected subject's reviewer panel
cannot be seated from the matrix, when a selected case has a grader type with no local evaluator, or
when a judged grader reads mock calls only. It has not been run against the operator's matrix here,
because this worktree has no `.work/eval-matrix.yaml`; the tests drive it with a stub matrix.

Each login check is local and redacts the credential content. The other host checks probe the
installed CLI:

- `cli-flags` takes every flag the adapter would pass for the selected cases and looks for it in the
  CLI's own help (`claude --help`, `codex app-server --help`, `grok --help`). Claude's help omits
  `--max-turns`. For a flag the help omits, the check runs the CLI with that flag alone and accepts
  it only when the argument parser answers that its value is missing; an unknown flag gets a
  different reply. That is how `--max-turns` passed, and the check says so in its detail.
- `tool-names` reads the tool ids Grok advertises for a new session from an ACP handshake that sends
  no prompt, and requires every id in a case's `--tools` set to be among them. It also requires every
  granted tool to contribute an id, and a case that loads a skill to keep `read_file`. The 27
  advertised ids include `run_terminal_command`, `read_file`, `search_replace`, `write`, `grep`,
  `list_dir`, `web_search` and `web_fetch`. There is no skill tool and no glob tool: Grok loads a
  skill with `read_file`, and `Glob` is served by `list_dir`. The `Skill` grant previously
  contributed no id, so a case granting `Skill` without `Read` would have lost skill loading; it now
  maps to `read_file`. The four cases here grant `Read` as well, so their `--tools` set is unchanged.
- `thread-identity` runs Codex `initialize` plus each case's `thread/start` request and requires the
  response to carry a model and a thread id. It starts no turn. The Codex identity fixture the tests
  parse, `codex-handshake.jsonl`, is that handshake's output with paths, ids, account fields and the
  model name replaced.

The checks do not show that a model can complete a case under these flags; only a paid session
does. Claude and Grok served identity is not probed, because neither host reports it without a
turn; their parsers are tested on streams captured from earlier live sessions. Preflight never
starts a subject or reviewer turn.

The wall-clock floor has no preflight check. It is computed in one place and the dry run prints the
resulting `timeout_ms` for each session.

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

Stop rules. `--execute` enforces every rule in this list; `tests/learn/evals-case-runner.test.ts`
drives each one against stub hosts.

1. `--execute` runs the same readiness check as preflight's `grader-readiness` over the whole
   selected subject and case set, and refuses the run with exit 2, no session and no receipt when it
   finds a problem.
2. `--execute` refuses to start without `--max-spend-usd <cap>` and `--estimates <file>`. The file
   maps each subject id to each case name to the table amount above, and a selected subject-case
   pair it does not cover stops the run before any session.
3. Sessions run strictly one at a time, in subject then case order. Nothing is retried: a session
   that throws ends the run with exit 2 and every remaining pair is listed as skipped.
4. Before each launch the runner adds that pair's estimate to the spend charged so far and stops the
   whole run if the sum exceeds the cap. A completed session is charged its reported subject cost
   plus its grader cost; a session that reports no subject cost is charged its estimate.
5. An invalid row stops the whole run before another launch. A row is invalid on a timeout, a
   host-refused call, a non-zero host exit, an empty reply, a reached turn cap, a missing served
   model, a missing session or thread id, or a missing request id on a host whose stream emits one.
6. An ungraded result stops the whole run before another launch. A row is ungraded when a judged
   grader's file is absent, the reviewers disagree, or a reviewer gives no readable verdict.
7. A graded failure stops that subject: its remaining cases are skipped and the runner goes on to
   the next subject unless rule 4, 5 or 6 has fired.

Request ids are a host capability, declared per adapter as `requestIds`. The Claude stream carries a
`request_id` on each assistant line and the Grok stream carries a `requestId` on its end line, so a
session from either host without one is invalid. The Codex app-server stream carries no provider
request id, so a Codex row is identified by its thread id and served model alone.

The receipt records `max_spend_usd`, `charged_usd` and a `skipped` list naming each pair that did
not run and why (`spend-cap`, `invalid-row`, `ungraded-row`, `aborted` or `subject-failed`). A run with any skipped
pair exits non-zero.

Two steps stay with the operator, and the runner does not enforce them: rebuild and rerun preflight
at the exact revision immediately before the first paid session, and do not rerun a stopped session
or substitute a binding without a new approval.

The paid rerun has not started and remains a separate approval decision.
