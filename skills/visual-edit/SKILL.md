---
name: visual-edit
description: >-
  Human-started command: it runs only when the human's message begins with `/ak:visual-edit`. On any
  other request do not load or follow it; tell the human to type that command. Opens named routes
  from a running local app as URL-backed frames, then applies pending visual revisions through
  source. Use when a human asks to compare or visually edit real routes. Not for static mock-ups,
  unimplemented product alternatives, or behavior changes.
license: MIT
metadata:
  ak_catalog_id: visual-edit
---

## When to use

- A human wants to compare real routes or responsive states from a running local app on a visual canvas.
- A human wants style, text or layout edits made visually and then applied to the app's source.

## Not for

- Static mock-ups, copied markup or screenshots. The running routes are the source of truth.
- Comparing unimplemented product alternatives; hand that bounded question to `prototype`.
- Behavior, state-model or cross-file changes; those require an approved ticket for `super-build`.
- Runtime verification without a visual editing session; that belongs to `verify` or `super-verify`.

## Authority

Authority: `explicit`. A human starts it with `/ak:visual-edit`; no grant or prose request starts it.

## Inputs

- A Design editor URL the operator runs or is given. A self-hosted editor is first class;
  `https://design.agent-native.com` is one convenience value. Missing: `missing-prerequisite:editor`.
- The `@agent-native/core` CLI, a bridge token minted through the selected editor's MCP connector or
  WebMCP, and its bridge daemon listening on `127.0.0.1:7331`. Missing any one names
  `missing-prerequisite:bridge-cli`, `missing-prerequisite:bridge-token` or
  `missing-prerequisite:bridge-daemon`.
- Only to save or share the design: an account on the selected editor. Opening routes, comparing
  viewports and applying pending edits run signed out. Missing when a save or share is asked for:
  `missing-prerequisite:editor-account`.
- A running local dev server, repository root, requested route paths and named viewports. A route
  that does not respond is `missing-prerequisite:dev-server`, with that route named.
- Optional named acceptance criteria. They let the resulting receipt enter `super-verify`'s matrix;
  without them the batch is still applied, receipted and acknowledged.

## Workflow

1. Check how the run started before any tool call. If the message does not begin with
   `/ak:visual-edit`, stop and return that exact command.
2. Freeze the editor URL, repository root, dev-server URL, ordered routes and viewports. If the
   request is for a not-yet-built alternative, hand the bounded question to `prototype` and stop.
3. Check every prerequisite the request needs by using it; an address or status declared in a
   project file is configuration, not evidence. Stop on the first missing id; never replace a missing
   editor, bridge or dev server with generated markup, a screenshot or another static preview.
4. Probe every requested route at the dev-server URL. Preserve the human's route labels, order and
   viewports; discover routes only when none were supplied.
5. Use `npx @agent-native/core@latest design connect` to read the manifest and run the durable
   token-matched bridge. Reuse a healthy matching bridge rather than starting a second app on 7331.
6. Through the selected editor's MCP connector or WebMCP, open the design with the exact routes and
   viewports. Each screen stays a URL-backed frame with route, URL, bridge and viewport metadata.
7. Before handing over the canvas, verify the connection, every requested route and viewport, each
   frame's `src` rather than `srcdoc`, and the Code panel's local source root plus one opened file.
   A failed check stops with its name; a returned link alone is not readiness.
8. Hand the verified canvas to the human. Visual changes remain pending and never write source from
   the canvas. Preserve the pending batch until it is applied or explicitly discarded. A save or
   share asked for without the account stops with its id and leaves the session as it is.
9. Pull the pending handoff and its revision through the bridge; a repository file that describes
   a pending revision is not a handoff. For a compiled route, locate and edit authored source
   through the coding agent. A change beyond style, literal text or local layout stops for an
   approved ticket, then hands the revision to `super-build`; do not partially apply it here.
10. Read every target file before writing, apply the pending batch to source, and confirm the dev
    server refreshes each affected route at its named viewport. A version conflict is re-read and
    re-planned, never overwritten.
11. Emit the receipt in Outputs, acknowledge the exact pending revision only after the source and
    dev-server confirmation exist, then pull once more. A non-empty pull is another pending batch,
    not evidence that acknowledgment failed.
12. When acceptance criteria were supplied, pass the receipt to `super-verify`; it decides whether
    the receipt covers them or whether another check is required.

## Hard gates

Gate: any missing editor, CLI, token, daemon, dev server or route stops with its named
prerequisite, and a missing account stops a save or share. The run never degrades to generated markup.

Gate: the running app is the source of truth. Requested screens are URL-backed frames at the named
viewports, never copied markup or static snapshots.

Gate: the connection, frames and Code panel are verified before the human receives the canvas.

Gate: canvas changes remain pending. Compiled routes and source files change only through the coding
agent; acknowledgment follows source application and dev-server confirmation, never precedes them.

Gate: a change beyond style, literal text or local layout is not absorbed here. It requires an
approved implementation ticket and `super-build`.

Gate: an applied batch has a schema-valid receipt bound to source revision and environment before
acknowledgment. Narrative is not a receipt (ruling `closure-requires-independent-verification`).

| The thought | Why it is wrong | Do this instead |
|---|---|---|
| "The route is down, so a static page is close enough." | It removes the running app from the loop. | Name `missing-prerequisite:dev-server` and stop. |
| "The canvas looks right, so I can acknowledge now." | Pending edits are not source changes. | Apply, confirm the dev server, write the receipt, then acknowledge. |
| "This compiled screen can apply itself." | Canvas edits cannot safely locate authored source. | Pull the revision and change source through the coding agent. |

## Outputs

- Returned canvas session data: editor URL, design and connection ids, ordered routes, named
  viewports, and the completed pre-handoff checklist. Tokens are excluded.
- For each applied pending revision, a `verification` receipt
  (`schemas/verification.schema.json`): the probe parameters name route, viewport and visual-edit
  revision; `artifacts` names every changed source file with its digest; `source_revision` binds the
  code; the probe's observed value records the dev-server confirmation. `supports` lists the supplied
  criteria and `super-verify` may consume it. With none supplied the receipt carries `no_criteria`
  instead, saying so and naming what was verified: the running app showing the applied edit.
- When the edit exceeds this skill's boundary, the unchanged pending revision and the approved
  ticket requirement are handed to `super-build`; no partial source edit is an output.

## Side effects

`workspace-write`, `process-exec`, `artifact-write`, `external-fetch`. No commit, push or direct
canvas-to-source write. Account and bridge secrets stay process-local and never enter outputs.

## Stop conditions

- `complete`: the verified canvas is ready with no pending batch, or one batch is applied, confirmed,
  receipted and acknowledged.
- `needs-input`: invocation or a named prerequisite is missing, or a non-style change lacks an
  approved implementation ticket.
- `failed`: the editor or bridge rejects the connection, source conflicts cannot be reconciled, the
  dev server does not reflect the write, or the receipt cannot validate. Leave the revision pending.
- `cancelled`: stop before the next write and leave any unapplied revision pending and unacknowledged.

## Limits

- Missing prerequisites: 0 (gate). Self-hosted and hosted editor URLs satisfy the same checks;
  neither the hosted convenience nor static output substitutes for a missing prerequisite.
- Frames per focused batch: 3-7 (guidance). Use exactly the requested routes and viewports; expand
  beyond seven only for an explicit exhaustive request.
- Direct application: style, literal text and local layout only (gate). Everything broader enters
  `super-build`; exploratory alternatives enter `prototype`; acceptance evidence enters
  `super-verify`.
