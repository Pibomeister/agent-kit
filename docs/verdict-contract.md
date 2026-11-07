# The verdict contract

A review or council verdict is read from one structured final verdict
field, and from nowhere else (issue #195). The failure this prevents: a
transcript that mentions WORTHY early and ends in rejection was once
summarised as WORTHY by scanning the prose, which could have merged
rejected work.

## The field

The answering seat ends its transcript with exactly one line of this
exact shape, as the final non-empty line:

```text
VERDICT: <value>
```

The value is an exact, case-sensitive member of the consumer's enum.
The adversarial enum is `WORTHY` or `REJECT`. Prose anywhere else in
the transcript, including the word WORTHY, carries no verdict.

## Fail-closed rule

Each of these is no verdict, and a gate that must decide treats it as
the rejecting value:

- no verdict field, or an empty transcript;
- more than one verdict field;
- a verdict field that is not the final non-empty line;
- a malformed field (extra words, no value, indentation);
- a value outside the exact enum, including a lowercase variant.

Permission is never inferred from surrounding prose.

## AgentKit consumers

`parseFinalVerdict`, `parseAdversarialVerdict` and
`failClosedAdversarialVerdict` in [src/verdict.ts](../src/verdict.ts)
are the shared parser for review and adversarial transcripts. Council
seats do not read transcripts: a seat answers only with a JSON council
answer whose `choice` field must be one of the card's exact options.
Non-JSON launcher stdout, including a transcript that ends in a
`VERDICT:` line, is not an answer, so the substitute chain moves on and
an exhausted chain leaves the seat unavailable, which escalates rather
than approves.

## Downstream adoption (Casco handoff)

Casco's captain-side adversarial review script is outside this
repository and cannot be edited here. Its required integration is:

1. Prompt the reviewer to end with exactly one final line
   `VERDICT: WORTHY` or `VERDICT: REJECT`, and no text after it.
2. Replace any prose scan (first match, substring or keyword search
   over the transcript) with the strict rule above: extract only a
   well-formed final field, require exactly one, and require the
   exact enum.
3. Treat every failure — missing, duplicated, malformed, non-final
   or out-of-enum — as REJECT, and print the summary from that parsed
   verdict only, never from the transcript text.
4. Keep a regression transcript that mentions WORTHY early and ends
   `VERDICT: REJECT`; its summary must print REJECT.

A shell consumer can implement the same rule without importing this
package: take the last non-empty line, require it to match
`VERDICT: ` plus one exact enum value, require no other line to start
with `VERDICT:`, and default to REJECT. Until Casco adopts this, its
local fix is not covered by AgentKit's tests; that remaining
cross-project acceptance is open and belongs to Main.
