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
version_greater() {
  node - "$1" "$2" <<'JS'
const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const current = pattern.exec(process.argv[2]);
const previous = pattern.exec(process.argv[3]);
if (!current || !previous) process.exit(1);
for (let i = 1; i <= 3; i++) {
  const a = BigInt(current[i]);
  const b = BigInt(previous[i]);
  if (a !== b) process.exit(a > b ? 0 : 1);
}
const a = current[4]?.split(".");
const b = previous[4]?.split(".");
if (!a && b) process.exit(0);
if (a && !b) process.exit(1);
if (!a || !b) process.exit(1);
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] === undefined || b[i] === undefined) process.exit(a.length > b.length ? 0 : 1);
  if (a[i] === b[i]) continue;
  const an = /^(0|[1-9]\d*)$/.test(a[i]);
  const bn = /^(0|[1-9]\d*)$/.test(b[i]);
  if (an && bn) process.exit(BigInt(a[i]) > BigInt(b[i]) ? 0 : 1);
  if (an !== bn) process.exit(an ? 1 : 0);
  process.exit(a[i] > b[i] ? 0 : 1);
}
process.exit(1);
JS
}
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
previous_version="$(version "$previous/dist/$manifest")" || {
  echo "refused: published plugin manifest is unreadable" >&2
  exit 1
}
diff_rc=0
diff -r -q "$previous/dist" "$current" >/dev/null || diff_rc=$?
if [ "$diff_rc" -gt 1 ]; then
  echo "refused: cannot compare the published bundle" >&2
  exit 1
fi
if [ "$diff_rc" -eq 1 ] && ! version_greater "$current_version" "$previous_version"; then
  echo "Bundle changed without a catalog.yaml and package.json version bump" >&2
  exit 1
fi
