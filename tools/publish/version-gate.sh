#!/bin/sh
# Refuses a built bundle whose content differs from origin/published without a version bump,
# a package.json version that disagrees with the catalog version the bundle carries, and any
# failure to read origin/published. Only an absent published branch counts as a first publish.
# On success refs/remotes/origin/published is current, or deleted when there is no branch.
# Usage, from the repository root: tools/publish/version-gate.sh <built-dist>
set -eu
current="$1"
manifest=claude-code/.claude-plugin/plugin.json
version() { node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$1"; }
current_version="$(version "$current/$manifest")"
package_version="$(version package.json)"
if [ "$current_version" != "$package_version" ]; then
  echo "catalog.yaml version $current_version and package.json version $package_version differ" >&2
  exit 1
fi
found=0
git ls-remote --exit-code --heads origin published >/dev/null || found=$?
if [ "$found" -eq 2 ]; then
  git update-ref -d refs/remotes/origin/published
  echo "No published branch yet: first publish"
  exit 0
fi
if [ "$found" -ne 0 ] || ! git fetch -q origin +refs/heads/published:refs/remotes/origin/published; then
  echo "refused: cannot read origin/published" >&2
  exit 1
fi
previous="$(mktemp -d)"
trap 'rm -rf "$previous"' EXIT
git archive -o "$previous/published.tar" refs/remotes/origin/published dist
tar -x -f "$previous/published.tar" -C "$previous"
if ! diff -r -q "$previous/dist" "$current" >/dev/null && [ "$(version "$previous/dist/$manifest")" = "$current_version" ]; then
  echo "Bundle changed without a catalog.yaml and package.json version bump" >&2
  exit 1
fi
