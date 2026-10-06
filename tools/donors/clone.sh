#!/bin/sh
# Clones every donor in provenance/upstream.lock.yaml to the path its entry names, and checks out its pin.
# Full history, never --depth: a shallow clone resolves the tip and fails at the pin (AGENTS.md, "Receipts
# name their instrument"). Blob-filtered, so history is complete and only the pinned tree is downloaded.
# A clone that already holds its pin is left alone. CI runs this before `bun test`, so the donor snapshot
# byte comparison in tests/donor-snapshots.test.ts runs there instead of being skipped.
# Usage, from the repository root: tools/donors/clone.sh
set -eu
bun --eval '
import { readFileSync } from "node:fs";
import { parse } from "yaml";
for (const d of parse(readFileSync("provenance/upstream.lock.yaml", "utf8")).donors) console.log(d.path, d.url, d.commit);
' | while read -r path url commit; do
  if [ -d "$path/.git" ] && git -C "$path" cat-file -e "$commit^{commit}" 2>/dev/null; then
    echo "clone.sh: $path already holds $commit"
    continue
  fi
  rm -rf "$path"
  git clone --quiet --filter=blob:none --no-checkout "$url" "$path"
  git -C "$path" checkout --quiet --detach "$commit"
  echo "clone.sh: $path at $commit"
done
