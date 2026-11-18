# GAP-PROBE — GS-004e live isolation arms did not run

2026-11-18

Coverage limit, not a pass. The GS-004e Claude Code and Codex probe arms did
not run. They need a host login nobody granted. No credential was copied, read,
or used.

This note is the same shape as GAP-MASTRA in
`src/review-isolation-probe/hosts.ts`: recorded rather than scored as a pass.
Fixture arms in `tests/review-isolation-probe.test.ts` still run. They are not
a live host result.

## Instrument

| Item | Value |
|---|---|
| Hosts | claude-code, codex |
| Host version | not observed |
| Plugins / hooks | not observed |
| Driver | not run |
| Date | 2026-11-18 |
| Task | GS-004e live arms, recorded from GS-004f |

`ak doctor` does not read this file. It only reads
`research/host-facts/<date>/review-isolation-<host>.md` when that note holds a
real host version.

## Arms

Every arm below is `not-run`. None is `pass`.

| Arm | Marker | Verdict | Observation |
|---|---|---|---|
| parent-turn | none planted | not-run | live spawn needs an authenticated host CLI |
| hooks-and-memory | none planted | not-run | live spawn needs an authenticated host CLI |
| auto-loaded-instructions | none planted | not-run | live spawn needs an authenticated host CLI |
| transcript-on-disk | none planted | not-run | live spawn needs an authenticated host CLI |
| role-file-denied | none planted | not-run | live spawn needs an authenticated host CLI |

The same five arms on Codex are `not-run` for the same reason. Codex
transcript-on-disk stays uncovered for a second reason already on main: CS-12
(the package guard is not plantable on that host).

GAP-MASTRA (Mastra Code, no adapter on main, no CLI dispatch path) is unchanged
and is also not a pass.

## Commands

none invoked

## Receipts

There is no verdict JSON. A missing login is not evidence that a channel held.
It is evidence that the live arms were not run.
