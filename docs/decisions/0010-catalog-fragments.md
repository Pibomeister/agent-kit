# ADR-0010 — Catalog fragments add entries without editing catalog.yaml

**Status:** Accepted.
**Date:** 2026-10-05.
**Authority:** the maintainer's decision, 2026-10-05, to offer the seam in this repository so that a
downstream fork can declare its own entries and take `catalog.yaml` from upstream unchanged; merging
this record is its acceptance. Numbered 0010 because ADR-0009 is claimed by an open change. Amends
what "single source of truth" means for `catalog.yaml`, not what the catalog governs.
**Prior art read:** `provenance/adaptations.d/` and `loadAdaptationFragments`
(`src/validation/provenance.ts`), `loadCatalog` (`src/catalog/load.ts`), `resolveProfile`
(`src/packaging/profiles.ts`), `checkSchemas` (`src/validation/schemas.ts`), `checkContent`
(`src/validation/content.ts`).

## Context

`catalog.yaml` declares everything the package can install, package or reference, and `ak validate`
fails on content it does not declare. A fork that ships one more install profile, or one entry of
its own, has had to edit that file. Upstream edits it too, whenever an entry is added or authored,
so the fork's edit is a hunk that can conflict on any sync that touches the same lines.

Provenance rows are already written the way this problem wants. Each batch writes one fragment under
`provenance/adaptations.d/`, so batches never edit one shared file, and `ak build` renders the
merged `provenance/adaptations.yaml`.

## Decision

### 1. `catalog.d/<name>.yaml` fragments, merged by the loader

A fragment is a YAML file under `catalog.d/` holding `schema_version: 1` and any of the catalog's
sections. `loadCatalog` merges each fragment's entries into those `catalog.yaml` declares, so every
caller of `loadCatalog` sees one catalog. `src/firstmate/bind.ts` parses `catalog.yaml` itself, but
only for `package.version`, which a fragment cannot set (§3).

### 2. In memory, with no generated file

This is where the catalog departs from the adaptations precedent. The merged adaptations file
exists because `NOTICE` sends a downstream reader to it. Nothing sends a reader to a merged catalog,
and the code under `src/` that reads entries reads them through the loader. A generated copy would
be a second catalog: one a fork could edit by mistake, and one that could drift from
`catalog.yaml`. So the merge happens on every load, and there is nothing to hold in sync.

### 3. A fragment adds entries, and never overrides or removes one

An id that `catalog.yaml` or an earlier fragment already declares in the same section is
`catalog.duplicate-id`, reported against the later file. The first declaration stands.
Last-writer-wins would make an entry's meaning depend on file order, which is the hazard
`provenance.conflicting-adaptation` refuses for the same reason.

A fragment carries no `package:` block, because package identity belongs to `catalog.yaml` alone.
The loader never reads one from a fragment, and `schemas/catalog.schema.json#/$defs/fragment`
refuses one. Fragments merge in file-name order, each after `catalog.yaml`, so a section's order
is the same on every run.

A downstream profile needs nothing more than this. `resolveProfile` reads a profile's members from
the `skills:` list in `profiles/<id>.yaml`, so a new profile does not touch the `profiles:` field of
any upstream skill.

### 4. The fragment's shape is the catalog's own

`#/$defs/fragment` refers to each section's entry shape in the same schema rather than restating
it, so a fragment entry and a `catalog.yaml` entry cannot drift apart. `catalog.yaml` still
validates on its own against the schema root, with every section required, and a fork's fragments
cannot make an incomplete `catalog.yaml` pass. `checkSchemas` validates each fragment the loader
merged. A fragment the loader could not parse is reported once, by the loader, and never reaches
the schema check.

### 5. Checked where catalog content is checked, and attributed to its file

`catalog.d/` is in the denylist's scan roots (`SCAN_DIRS`, `src/validation/content.ts`). A tree the
scan does not walk reports clean whatever it holds, and a fork's fragment is exactly the catalog
content the denylist exists to police.

Each entry records the file that declared it (`CatalogEntry.file`). Loader issues, and checks about
one entry, name that file, so an error about a fragment entry does not send its author to
`catalog.yaml`. Messages that say `catalog.yaml` in the sense of "the catalog" stay as they are.
Each merged fragment emits a `catalog.fragment-merged` note naming what it adds. A figure quoted
from a tree with fragments is about `catalog.yaml` plus those fragments, and the note puts that in
the run's own output. A tree without fragments reports exactly what it reported before.

### 6. This repository carries no fragments

Upstream declares its own entries in `catalog.yaml`, so one file still says what this repository
ships. `catalog.d/` is the surface for installs built on top of it.

## What this does not cover

- **The invocation policy.** `policies/invocation.yaml` must classify every catalog skill
  (`policy.skill-not-classified`), so a skill declared in a fragment still needs a row there.
- **The conversation map.** An authored directory-backed entry with
  `provenance_origin: conversation` needs a `provenance/conversation-map.yaml` row, and that file
  takes no fragments. One with a donor origin records its rows under `provenance/adaptations.d/` as
  usual. A profile carries no provenance origin, so a downstream profile needs neither.
- **Rulings that govern a whole section.** A ruling that declares `universal: [<section>]` must
  bind every entry of that section (`rulings.universal-binds-mismatch`,
  `src/validation/rulings.ts`). `closure-requires-independent-verification` and
  `required-lane-failure-is-unavailable` declare `universal: [roles]`, so a role declared in a
  fragment also needs edits to `policies/resolved-conflicts.yaml`. A profile is unaffected.
- **Schemas.** A schema entry can name only an id the `schemas` enum in `catalog.schema.json`
  lists, and `catalog.yaml` declares every one of them. A new schema is therefore a change to that
  schema and to `catalog.yaml`, never a fragment.

## Consequences

- A fork adds a profile with two new files, `catalog.d/<name>.yaml` and `profiles/<id>.yaml`, and
  its `catalog.yaml` stays byte-identical to upstream's.
- A fork cannot change an upstream entry through a fragment. Changing one is an edit to
  `catalog.yaml`, and it shows in the diff as one.
- **Reverting** means deleting `readFragments` and the per-file loop from `loadCatalog`,
  `#/$defs/fragment` and the fragment targets in `checkSchemas`, and `catalog.d/` from `SCAN_DIRS`,
  then marking this ADR superseded. A fork's fragment entries would then be undeclared content, and
  `ak validate` would report them.
