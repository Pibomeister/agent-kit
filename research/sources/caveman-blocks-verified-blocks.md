# caveman-ai/blocks: procedure detection donor note

This is a research-only pin of `caveman-ai/blocks` at
`f7210f72f439c416db274520a7cffdaf9a935478` (2026-10-13). It does not
install or run the donor binary, hooks, telemetry or block authoring tools.
The approved Phase 1 pilot would adapt selected detection mechanics into
agent-kit's existing skills loop under separate provenance rows; the donor's
broader workflow is not adopted.

## Source, licence and marks

- Repository: https://github.com/caveman-ai/blocks
- Mechanism inspected at the pin: `README.md`, `docs/HOOK.md`, and
  `internal/capture/`.
- Licence: Apache-2.0. The upstream `LICENSE` and `NOTICE` are copied
  byte-for-byte to `provenance/licenses/caveman-ai_blocks.*`. The NOTICE names
  Copyright 2026 Julius Brussee and points to the donor's trademark policy.
- `TRADEMARKS.md` reserves the Caveman name, wordmark and rock logo. References
  here identify the source only; agent-kit claims no endorsement or mark rights.
  That file refers to `LICENSING.md`, which is absent at this pin.

Any distributed adaptation must keep the applicable Apache-2.0 licence and
NOTICE, state its modifications in provenance, and carry those texts in each
host bundle and the standalone runtime. The research pin alone ships no
adapted donor code or snapshot.

## Observed donor mechanism

The donor watches shell calls for inline scripts. Its hook captures supported
Python forms, scrubs stored text, fingerprints a script's shape, and records
repeated sightings across sessions; its CLI can turn a recurring shape into a
repo-local Python block. `docs/HOOK.md` names the call-name table and shape
fingerprint and describes local candidate state, hints and transcript scans.
The donor's hook does not deny or rewrite a command. These are observations of
the pinned source, not instructions activated by this note.

The donor's own state includes script bodies and a 16 KiB cut. The approved
agent-kit pilot instead keeps complete supported bodies in a deletable sibling
root outside every git ledger and counts oversize, dynamic or invalid inputs
without a fingerprint. It uses the existing shell lexer and secret gate,
source-time windows, and metadata-only ledger rows. Candidate IDs, promotion,
block files and live hints wait for a later decision after the Phase 1 pilot.

## Adoption boundary

The pilot asks whether repeated shapes perform one useful common task in two
owned projects. Three distinct active sessions in fourteen days is eligibility
guidance, not proof that a block should be authored. At CP1 the maintainer
compares scrubbed examples with existing tools and may report zero useful
groups. No later phase starts from this research pin alone.
