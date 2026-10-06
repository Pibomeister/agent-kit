#!/bin/sh
# Clones every donor in provenance/upstream.lock.yaml to the path its entry names, and checks out its pin.
# Full history, never --depth: a shallow clone resolves the tip and fails at the pin (AGENTS.md, "Receipts
# name their instrument"). Blob-filtered, so history is complete and only the pinned tree is downloaded.
# An existing clone is reused and checked out at its pin; one that lacks the pin is fetched, never deleted.
# CI runs this before `bun test`, so the donor snapshot byte comparison in tests/donor-snapshots.test.ts
# runs there instead of being skipped.
# Usage, from the repository root: tools/donors/clone.sh
set -eu
rows=$(bun --eval '
import { readFileSync } from "node:fs";
import { parse } from "yaml";
for (const d of parse(readFileSync("provenance/upstream.lock.yaml", "utf8")).donors) console.log(d.path, d.url, d.commit);
')
if [ -z "$rows" ]; then
  echo "clone.sh: provenance/upstream.lock.yaml names no donors" >&2
  exit 1
fi
printf '%s\n' "$rows" | while read -r path url commit; do
  if [ -e "$path" ] && [ ! -d "$path/.git" ]; then
    echo "clone.sh: $path exists and is not a git clone; move it aside" >&2
    exit 1
  fi
  if [ ! -d "$path/.git" ]; then
    git clone --quiet --filter=blob:none --no-checkout "$url" "$path"
  elif ! git -C "$path" cat-file -e "$commit^{commit}" 2>/dev/null; then
    git -C "$path" fetch --quiet origin
  fi
  git -C "$path" checkout --quiet --detach "$commit"
  echo "clone.sh: $path at $commit"
done
