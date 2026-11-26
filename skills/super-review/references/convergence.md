# Converging review: the default loop

Every review run of a change uses this loop, from its first round to its last. The rules are
ADR-0018 and `policies/review.yaml` `convergence`. This file is the operating form of them: which
command runs when, which line goes into the ledger, and what each verdict makes the caller do.

The loop has three rules.

1. **Round 1 is the one full review.** After it, a round is fix-only: the delta since the last
   reviewed head, plus a closure check on each earlier finding.
2. **A new finding after round 1 blocks only with evidence.** It needs a reproduction that is red
   at the head and green at the merge base, or it is a security, destructive or data-loss finding
   that names the asset at risk and the action that harms it. No single seat vetoes: a seat's
   `block` word is recorded and blocks nothing. Only ledger rows block.
3. **The cap is three rounds per scope:** one full and two closure. At the cap every open row gets
   its outcome by rule, the change parks, and the caller reports it. Nothing at the cap approves on
   its own.

## Contents

- The commands
- Before each round
- Round 1: the full review
- Later rounds: fix-only
- After each round
- At the cap

## The commands

Run the bundle's own CLI, `<bundle>/bin/ak review` (a Bun script), or `ak review` where the `ak`
on `PATH` has the `review` command. The four commands are:

| Command | What it does |
|---|---|
| `ak review scope --ledger <L> --base <merge-base> --head <sha> [--previous <scope.json>]` | Prints what the next round covers |
| `ak review ledger add --ledger <L> --event <file\|->` | Appends round, verdict, finding, closure, evidence and follow-up lines |
| `ak review ledger show --ledger <L>` | Prints the state the lines fold to |
| `ak review decide --ledger <L> --head <sha> --seats <n> [--missing-evidence <item>]...` | Prints the verdict and the one next action |

The ledger is one JSONL file per pull request. Keep it at a path the author of the change cannot
write: the runner's artifact directory, or the directory a binding's brief names. Never put it
inside the worktree under review. `ak review decide` trusts every line in the file.

Where neither CLI can run, the three rules still bind. Apply them by hand, and name the limit in
the review result: `verdict computed without ak review decide`.

## Before each round

Run `ak review scope` with `--out <scope.json>`. Give `--previous` the scope record of the last
reviewed round once the ledger holds one. Give `--record`, `--intent` and `--criteria` when they
exist, so that each trigger is evaluated. The outcome says what to do:

| Outcome | Do this |
|---|---|
| `full` | Open round 1 and review the whole change |
| `closure` | Open the next round over the delta since the last reviewed head |
| `carry` | Append the record's `event` (a `carry` line). Call no seat: the earlier verdict covers the head |
| `new-scope` | Append the record's `event` (a `scope-open` line), then open round 1 of the new scope |
| `hold` | Park the change and report it. The lane's captain splits or replans |

A new scope restarts the round count and invalidates the approvals. The findings stay. A pull
request gets one new scope. A further trigger is a `hold`.

## Round 1: the full review

1. Append `{"kind":"round-open","head":"<sha>"}`. The first round of a scope is `full`.
2. For each seat, append its verdict, `{"kind":"verdict","seat":"<seat>","word":"approve"}` or
   `"block"`, and one finding report per finding: `seat`, `severity`, `category`, `origin`, `file`,
   `line`, `cause_key` and `text` (`schemas/review-ledger.schema.json` `finding_report`). A
   security, destructive or data-loss finding adds `risk: {asset, action}`. A convention finding
   adds the project `rule` it cites.
3. Append `{"kind":"round-close"}`. Pass `--snapshot <dir>` to `ledger add` to anchor the findings
   in the reviewed tree.

In round 1 a P0 or P1 finding that the change introduced blocks on reading evidence alone.

Findings that the delivery pipeline's Review reported are imported as round 0, under the seat
`pipeline`, with `"mode":"import"`. That seat never rules. An imported finding blocks only when a
review seat reports it too.

## Later rounds: fix-only

1. The author answers each open row with a `response` line, `fixed` or `dispute`. The author never
   closes a row.
2. Append `round-open` for the new head. The mode is `closure`.
3. Seat only the lanes the delta protocol names, over the delta since the last reviewed head and
   the behavior it affects (`protocols/review-delta/PROTOCOL.md`). Do not review the whole change
   again.
4. For each earlier finding, the seat that holds it appends a `closure` line: `vote` is
   `addressed` or `not-addressed`, with a `location`. A reproduction closes or keeps a row with no
   vote: record it as an `evidence` line, `kind: "repro"`, with `exit` at the head and `base_exit`
   at the merge base. The caller runs the reproduction. The tool runs nothing.
5. A new finding goes into the ledger like any other. It blocks only when it sits inside the delta
   scope and carries a reproduction that is red at the head (`exit` not 0) and green at the merge
   base (`base_exit` 0), or when it is an always-block finding with its risk sentence. Every other
   new finding, and every P2, P3, pre-existing or uncited convention finding, is filed. A filed row
   needs a `followup` line with a reference before the verdict is `approved`.
6. Append each seat's verdict and `round-close`.

## After each round

Run `ak review decide` at the reviewed head. `--seats` is the class's `independent_seats` in
`policies/review.yaml` `convergence.evidence_by_class`. Each item of that class's evidence with no
receipt at the head is one `--missing-evidence`. The decision is the review's verdict: the
synthesis step does not overrule it.

| `decide` action | The review's verdict | Do this |
|---|---|---|
| `none` (`approved`, exit 0) | `approved` | Record the review gate |
| `fix` | `changes-requested` | Hand the blocking rows to apply-findings, then run the next round |
| `closure-round` | `changes-requested` while a row blocks | Run a closure round over the delta |
| `file-follow-ups` | `changes-requested` | File each listed row and append its `followup` line |
| `review-round` or `close-round` | none yet | Run round 1, or append the missing `round-close` |
| `supply-evidence` or `repair` | `unavailable` | Name the missing item or the refused line, and supply or repair it |
| `council` | `blocked` | Park and report. Send one council card per escalated row |
| `bounded-closure` | none yet | Run the one bounded round the council's `fix` ruling gives |
| `owner-hold` or `captain-hold` | `blocked` | Park and report. The named person decides |

## At the cap

The tool refuses a fourth `round-open` in a scope. At the cap, `decide` gives every row its
outcome by rule. A row with a red reproduction escalates, and so does an always-block row. A row
whose theme reopened in two consecutive rounds escalates as a design decision. Every other open
row is deferred, and it needs a follow-up reference.

Park the pull request and report the decision record. Do not approve it, do not open a new full
review, and do not open a fourth round. A human may add one more closure round, once per scope,
with an `extension` line that names the order. That round is still a delta.

The gate tool's `review-full` and `review-delta` records follow the same verdict: record approval
only when `ak review decide` exits 0 at the head being recorded.
