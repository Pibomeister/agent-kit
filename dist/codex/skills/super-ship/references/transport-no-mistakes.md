# Transport: no-mistakes

Loaded by `super-ship publish` when the project ships through no-mistakes. The authority for every
rule here is ruling `no-mistakes-as-ship-transport` and `adapters/runner-contract/CONTRACT.md` §5;
this file is the operating form of them. It applies the same way under Firstmate
(`adapters/firstmate/CONTRACT.md` §2) and in a standalone run.

## What the transport is

no-mistakes is how the push happens, not who decides it. super-ship has already decided: receipts and
a verdict bind to the snapshot being shipped. no-mistakes then re-runs the project's deterministic
checks on that head, pushes it, opens the pull request and watches CI. super-ship stays the single
creator of the pull request: no other lane in the run opens one, and no-mistakes opens it only
because super-ship started the push.

## Every push skips three steps

```
--skip review,document,rebase
```

| Skipped | Why |
|---|---|
| `review` | Review judgment belongs to super-review. A second review pipeline would produce findings no lane owns and a verdict nothing binds to |
| `document` | It commits on its own. A commit the lifecycle did not review would ship on a verdict that no longer describes the head |
| `rebase` | The same: it moves the head after the verdict was bound |

A push that cannot carry the skips does not happen. The run stops with `needs-input` rather than
pushing through a pipeline that reviews or rewrites the change.

## Nothing parks as a commit

The repository's trusted no-mistakes config must set `auto_fix.test`, `auto_fix.lint` and
`auto_fix.ci` to `0`, so a failing gate parks instead of committing a fix. Where those values are
absent or non-zero, the transport is not configured and the ship stops before the push. Under
Firstmate, `ak firstmate preflight` checks this before a task is bound, reading the copy on the
default branch because that is the only one no-mistakes trusts.

## The intent

`--intent` carries the captain's intent: what the person who asked for the change wanted, verbatim
from the work source. It never carries Firstmate's task spec, the lifecycle's plan or a summary the
run wrote. Where the work source has no stated intent, the flag is left out rather than filled.

## Before the push: reconcile

Reconcile before every remote effect, per `adapters/runner-contract/CONTRACT.md` §5:

1. Read the branch's open pull request, deterministically. Unknown is not none (workflow step 8).
2. Read the active no-mistakes run for the branch, if any.
3. Where the pull request exists and its head is the head being shipped, the push is already done:
   return it rather than pushing again.
4. Where a run is active on an older head, the new push supersedes it. That is the intended way to
   replace a parked run, not a conflict.

## When a gate parks

A parked gate is a finding against the shipped head, and it goes back through the lifecycle:

1. Treat the parked output as a verification failure on that head.
2. Fix it through super-build, re-verify through super-verify and re-review through
   `super-review delta`. The fix counts against the fix-cycle cap.
3. The new head invalidates the receipts and verdict bound to the old one, because the revision or
   the diff hash changed.
4. Ship again. The new push supersedes the parked run.

Never answer a parked gate from inside the pipeline (`respond fix` or an equivalent). That creates a
commit the lifecycle did not review, which is what the skips exist to prevent. At the fix-cycle cap
the run stops with `cap-reached` instead of pushing again.

## What it never does

It never merges. Merge authority stays with whoever holds it: under Firstmate, the supervisor's
configured merge authority; standalone, the person. It never rewrites history on the remote and never
force-pushes.
