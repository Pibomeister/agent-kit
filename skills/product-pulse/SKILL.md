---
name: product-pulse
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:product-pulse`. On
  any other request do not load or follow it; tell the human to type that command. Reads the
  product's configured signal sources over a lookback window and publishes a one-page pulse report
  (headlines, usage, system performance, followups) with deltas against the prior equal window and
  the strategy's key metrics carried forward. Use when a human wants a read on how the product is
  doing and runs /ak:product-pulse. Not a dashboard, not permission to change the roadmap, and never
  a write to any product system.
license: MIT
metadata:
  ak_catalog_id: product-pulse
---

Inspect changes and signals against existing product anchors. A report, not permission to change
the roadmap.

## When to use

- A human wants a single-page read of the last day, week or launch hour.
- A launch just went out and a human wants the first hour's numbers in one place.
- A human wants the strategy's key metrics read against what the product actually did.

## Not for

- Changing the roadmap, the strategy or the backlog. Followups stay in the report; acting on one is a
  separate human-started run.
- Replacing a dashboard or investigating deeply. Native tools still do that.
- A shipping log. Shipped work lives in the tracker and the commit history.
- Any write to the product, its database or an external system. Every source is read-only.

## Authority

Authority: `explicit`. A human starts this skill with `/ak:product-pulse`. It may start
model-invoked skills only. It holds no authority over the product, the tracker or the strategy: its
only writes are its own configuration page and its reports, both in the knowledgebase.

## Inputs

- The lookback window the human gave (`1h`, `24h`, `7d`, `30d`). Absent: the configured default,
  else `24h`. Unparseable: ask.
- The pulse configuration: a `concept` page scoped to the product, read with the knowledgebase
  adapter's `readContext`. Absent, or the human asked to set up or reconfigure: run setup first.
  Its keys are in [the run guide](references/run.md).
- The product's strategy page, through `readContext`, for its key metrics. Absent: the report goes
  without a strategy-metrics line and says so; no anchor is invented.
- The signal sources the configuration names, reached through the host's data tools in read-only
  mode: product analytics, application tracing, payments if configured, and a database only when
  enabled and read-only.
- An unreachable knowledgebase is `needs-input`. A configured source the host cannot reach is
  reported as `no data`, never estimated.

## Workflow

1. **Check how this run was started**, before any other step and before any tool call. It is started
   only when the human's message begins with `/ak:product-pulse`; no grant starts it. A request in
   prose is not a start, even when it names this skill or the command. Otherwise, stop here: make no
   tool call, say that this command is human-started, and give the human the line to type,
   `/ak:product-pulse` and their request.
2. **Resolve the window.** Apply a 15-minute trailing buffer to its upper bound to absorb ingestion
   lag: a `24h` window reads `[now - 24h - 15m, now - 15m]`. The prior window is the same length,
   immediately before.
3. **Load or set up the configuration.** With none on record, follow
   [the setup guide](references/setup.md): seed from the strategy page, interview one question at a
   time, refuse read-write database credentials, show the configuration with one edit round, and
   publish it.
4. **Query**, per the run guide: analytics, tracing and payments in parallel; database queries after,
   one at a time, tight and scoped, skipped with a note when one would be expensive. Every tool call
   is read-only; a tool's write mode is never used.
5. **Resolve the strategy metrics.** For each key metric: omit it if excluded; mark it
   `no data (instrumentation pending)` if pending; otherwise read it from its configured source, or
   the default analytics source marked `(default source)`. A query that returns nothing is listed as
   `no data`, never dropped.
6. **Assemble the report** from [the report template](assets/report-template.md): Headlines, Usage,
   System performance, Followups, and a footer naming the source windows and the buffer. Thirty to
   forty lines. Thin sections stay thin.
7. **Scrub and check.** Run the template's checklist. No email, account identifier or message
   content survives into the report.
8. **Publish** the report as a new revision of the product's pulse page, and read it back.
9. **Surface.** Post the Headlines verbatim, the top Followup if it looks urgent, and where the report
   lives. Never paste the whole report into chat.
10. **Mention a reminder, lightly.** At setup, suggest once that the human keep a recurring reminder
    to run `/ak:product-pulse`; on the third or later ad hoc run, mention it once. A schedule may only
    remind the human; it never starts a run, and this skill creates no reminder or schedule.

## Hard gates

Gate: read-only everywhere. No write to the product, its database or any external system; a
read-write database credential is refused at setup and never used if offered later.

Gate: no personal data in the report. No email, account identifier or message content, in any
section, the quality sample included.

Gate: no roadmap, strategy or tracker change. A request to act on the numbers is named as outside
this skill and left for a separate human-started run.

Gate: no invented numbers. A delta needs the prior equal window; without one the delta is omitted. A
source with no answer reads `no data`.

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "Give me write access and I can fix the counts at the source." | A pulse that mutates what it measures is not a read, and the credential outlives the run. | Refuse; offer a read-only connection or no database at all. |
| "Their emails would make the error list easier to debug." | The report is durable and shared; personal data in it is a leak. | Describe the error without identifiers; the native tool has the details. |
| "Signups dropped 30%, so I'll move onboarding to the top of the roadmap." | A report is not permission to change the roadmap. | Put it in Followups and stop. |
| "No prior window, but it's probably up about 10%." | An estimated delta reads as a measurement. | Omit the delta. |
| "This error count is high, I'll flag it red." | No thresholds were configured; a label is a judgment the reader did not ask for. | Present the number and let the reader judge. |

## Outputs

- A pulse report: a new revision of the product's pulse page, a `concept` page scoped to the product,
  published through the knowledgebase adapter's `publishArtifact` under a `kb-document` placement.
  Its revision history is the timeline of past pulses.
- On setup, the pulse configuration, a `concept` page scoped to the product, published the same way.
- The knowledgebase resolves both locations; this skill writes nothing into the working repository
  (ruling `central-kb-owns-project-artifacts`).
- In chat: the Headlines, the top Followup if urgent, and where the report lives.

## Side effects

`external-fetch`, `scratch-write`, `kb-draft`, `kb-publish`. No `workspace-write`, no
`tracker-write`.

`kb-publish` is a remote side effect. Its idempotency key derives from the run, the operation, the
page's stable remote identity and the artifact's hash; the read-back is the record the publish
returns, read before the write and confirmed after it (`adapters/runner-contract/CONTRACT.md`,
"Idempotency"). A publish whose read-back cannot be performed is `failed`, never complete.

## Stop conditions

- `complete` — the report is published and read back, and its headlines are in chat.
- `needs-input` — not started with `/ak:product-pulse`, the knowledgebase cannot be read or written,
  no signal source is configured or reachable, the window is unparseable, or a setup answer is
  awaited.
- `failed` — a publish's read-back cannot be performed.
- `cancelled` — the human withdrew; nothing further is published.

## Limits

- Report length: thirty to forty lines (guidance).
- Followups: three to five, each specific enough to act on (guidance).
- Top errors: five, or the configured count (guidance).
- Quality sample, when enabled: up to ten sessions (guidance).
- Trailing buffer on the window: fifteen minutes (guidance).
