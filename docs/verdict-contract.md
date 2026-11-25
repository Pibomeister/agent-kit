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
are the shared parser for review and adversarial transcripts.
`ak council run` reads a seat through `launchSeat`. A JSON council
answer whose `choice` is one of the card's exact options still stands.
Stdout that is not JSON is read through `adversarialChoiceFromTranscript`,
the `launchSeat` fallback, which receives the raw stdout Buffer. The
JSON path is `toString` then `JSON.parse` and is unchanged. The
transcript path approves only when every one of these holds.
The Buffer is valid UTF-8. `TextDecoder` with `fatal: true` succeeds.
Every byte is printable ASCII 0x20-0x7E, or tab, line feed, or
carriage return. Any other byte refuses. That includes C1 controls,
8-bit CSI 0x9B, a BOM, non-ASCII lookalikes, fullwidth characters,
and Unicode quotes.
Outside the `VERDICT` line, none of these ASCII characters appear.

```text
{ } [ ] < > ` ~ \
```

The text has no HTML entity matching `&#?[a-z0-9]+;` and no
percent-escape matching `%[0-9a-f]{2}`.
The remainder is stdout without the `VERDICT` line, trimmed. It does
not `JSON.parse` to any value, scalars included. `true`, `1`, `"x"`,
`null`, and `false` plus `VERDICT` are refused.
Markdown links, non-ASCII prose, inline code in backticks, and angle
brackets are fail-closed. Seats that want rich output must emit the
JSON answer.
A well-formed final `VERDICT: WORTHY` or `VERDICT: REJECT` is the
seat's choice when that value is one of the card options. A yes/no
card is not answered by a `VERDICT` field. Mixed stdout is
unavailable. The substitute chain continues and no REJECT is
synthesized.
Garbage, an empty transcript, a missing field, or a value outside the
card options is not an answer, so the substitute chain moves on and an
exhausted chain leaves the seat unavailable, which escalates rather
than approves. A well-formed `VERDICT: REJECT` on a plain prose
transcript is a recorded rejection, not an unavailable seat.

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
