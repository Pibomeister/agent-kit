#!/bin/sh
# Refuses a publish whose staged bundle carries a bin/ program without the executable bit.
# A file directly under dist/<host>/bin/ that starts with a shebang is run by its path: the
# skills run `ak …`, and a shell refuses a 100644 bin/ak with "Permission denied" on every
# install. ak build writes these files 0755 (isExecutable in src/packaging/plan.ts); this
# checks that the mode survived into the index the publish commit is made from.
# Usage, from the repository root: tools/publish/exec-bits.sh <release-worktree>
set -eu
release="$1"
staged="$(git -C "$release" ls-files -s -- ':(glob)dist/*/bin/*')"
failed=0
while read -r mode blob _ path; do
  [ -n "$path" ] || continue
  [ "$(git -C "$release" cat-file blob "$blob" | head -c 2)" = "#!" ] || continue
  if [ "$mode" != 100755 ]; then
    echo "refused: $path starts with a shebang and is staged as $mode, not 100755" >&2
    failed=1
  fi
done <<EOF
$staged
EOF
exit "$failed"
