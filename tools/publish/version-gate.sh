#!/bin/sh
# Refuses a built bundle whose content differs from the published one without a version bump,
# and a package.json version that disagrees with the catalog version the bundle carries.
# Usage, from the repository root: tools/publish/version-gate.sh <published-dist> <built-dist>
# A missing published manifest means nothing has been published yet.
set -eu
previous="$1"
current="$2"
manifest=claude-code/.claude-plugin/plugin.json
version() { node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$1"; }
current_version="$(version "$current/$manifest")"
package_version="$(version package.json)"
if [ "$current_version" != "$package_version" ]; then
  echo "catalog.yaml version $current_version and package.json version $package_version differ" >&2
  exit 1
fi
[ -f "$previous/$manifest" ] || exit 0
if ! diff -r -q "$previous" "$current" >/dev/null && [ "$(version "$previous/$manifest")" = "$current_version" ]; then
  echo "Bundle changed without a catalog.yaml and package.json version bump" >&2
  exit 1
fi
