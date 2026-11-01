# ADR-0016 — The skill doctor's improvement loop

**Status:** Accepted.
**Date:** 2026-10-31.
**Authority:** the captain's AK-4 Phase 2 request of 2026-10-31, through Firstmate's brief.
**Prior art read:** `src/learn/doctor/cli.ts` `doctorArea`, `src/learn/doctor/suggest.ts`
`gateSuggestion`, `src/learn/setup/schedule.ts`, ruling `learning-drafts-not-publishes`.

## Context

`ak learn doctor` reports skill health and writes proposed edits, and a person applies them by hand.
Phase 2 adds a scheduled loop that turns those proposals into pull requests. Three limits apply:
transcripts stay on the machine, judge calls use the signed-in seat, and a proposed change is a
holistic rewrite and never an addendum.

## Decision

**A new verb, not a second doctor.** `ak learn doctor loop` calls the existing run for collection,
scoring and the report. `ak learn doctor run` still writes no skill file and opens no pull request.

**Only supported proposals proceed.** A proposal proceeds only when a session it cites failed and
used that skill. A proposal for a new skill stays in the report.

**The rewrite step sees no session.** Its judge call holds the skill name, the rule, the change and
the file at the pull request's base. The rule and the change are checked against the sessions before
that call. The prompt holds no transcript, no scorer reason and no evidence moment.

**The runtime refuses an addendum.** The check reads the diff. A reply fails when it removes no
non-blank line, or when one block of three or more net new lines is larger than everything removed
from the file. A reply also fails when it renames the skill, passes the 300-line cap, or keeps fewer
than half of the file's non-blank lines.

**Outgoing text is checked before it leaves.** The added lines, the rule and the change fail when
they repeat eight consecutive words from this run's transcripts, reasons or moments, name the home
directory, or hold text the capture scrub would redact. A missing transcript stops the pass, because
the check cannot run without it. The pull request body carries no session key or moment.

**The commit touches no work tree.** Git plumbing builds one commit on the fetched base with a
temporary index, and the commit must change that one path. Hooks do not run and the skill file on
disk stays as it was.

**The gate publishes.** With `--publish`, the loop pushes through the `no-mistakes` remote, and that
pipeline opens the pull request. No other route exists: the loop never pushes to origin and never
runs `gh pr create`. Without that remote, the pass refuses before any judge call. Without `--publish`, rewrites stay
in the output directory. The loop never merges and never enables auto-merge.

**A person decides, and the ledger remembers.** `doctor/rewrites.json` in the skills ledger records
each branch before its push, so a crash cannot open a rule twice. Each pass reads the open pull
requests. A merge records the proposal accepted and a close records it rejected, so the doctor's
existing gate does not propose a rejected rule again. A failed read decides nothing. Each skill has
one open rewrite at most, and `--max-prs` caps the total, three by default. Every recorded open entry
counts against the cap, including one whose pull request the pipeline has not opened yet.

**The commit carries the decision text.** The gate's pipeline opens the pull request from the commit,
so the commit message holds the pull request body: the rule, the change, and the
merge-accepts and close-rejects instruction.

**The schedule is a local unit.** `ak learn doctor schedule` writes a launchd, systemd or cron entry
named `dev.agent-kit.learn.doctor`. It fires on Sundays at noon and has no interval flag. It does not
fire at load, login or boot, because each pass spends judge calls and can open pull requests. A
systemd timer catches up after a missed Sunday, and launchd catches up after sleep. A machine that is
off on launchd or cron waits for the next Sunday. A hosted schedule cannot work, because the transcripts and the
signed-in seat exist only on the machine. The unit loads only with `--load`, publishes only with
`--publish`, and `ak learn setup uninstall` removes it.

## Consequences

- The rewrite prompt lives in `src/learn/doctor/rewrite.ts`, not in `roles/`. The Phase 2 brief forbade
  a token-budget baseline change, so the prompt is not pinned in `tools/budget/surfaces.ts`. Moving it
  to a catalog role, with a pin, is a later decision that needs that baseline change.
- The word-run check catches copied text, and it does not catch a paraphrase. The rewrite step's
  inputs are the main protection, and the person reading the pull request is the last one.
- Through the gate, a pull request appears only after the pipeline finishes, so the record's `pr`
  field stays empty until a later pass reads it. A pipeline that never opens one keeps its slot and
  its skill's one open rewrite, and each pass prints a `waiting:` line for that branch. The loop does
  not guess that the pipeline failed. A person answers the pipeline or removes the entry.
