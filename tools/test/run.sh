#!/bin/sh
# Keep each heavy file in its own process, after the ordinary lane has exited.
set -u

while IFS= read -r file; do
  if [ ! -f "$file" ]; then
    echo "missing integration test: $file" >&2
    exit 1
  fi
done < tools/test/integration-files.txt

# Fixtures write scratch under one private root that is removed at exit. Bun lists every directory
# above its cwd and script on start, so a crowded macOS $TMPDIR costs each bun child about 250ms.
TMPDIR=$(mktemp -d /tmp/ak-test-XXXXXX) || exit 1
trap 'rm -rf "$TMPDIR"' EXIT
export TMPDIR
# A supervisor may inject Git config (a hooks path) through the environment; fixtures must not run it.
# Fixture commits must not start detached auto-maintenance. Set here, before bun starts, because
# Bun.spawn and child_process without an explicit env pass the startup environment, not process.env.
unset GIT_CONFIG_PARAMETERS
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false
export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
# /usr/bin/git on macOS is the xcrun launcher. A link to the selected tool skips it for every child.
# The link must not sit in a directory named bin: Git then derives its prefix from the link's path.
if [ "$(command -v git)" = /usr/bin/git ] && tool=$(xcrun --find git 2>/dev/null); then
  mkdir "$TMPDIR/git-tool" && ln -s "$tool" "$TMPDIR/git-tool/git"
  if [ "$("$TMPDIR/git-tool/git" --exec-path)" = "$("$tool" --exec-path)" ]; then
    PATH=$TMPDIR/git-tool:$PATH
    export PATH
  fi
fi

status=0
set --
while IFS= read -r file; do
  set -- "$@" --path-ignore-patterns "$file"
done < tools/test/integration-files.txt
bun test --parallel="${AK_TEST_PARALLEL:-4}" "$@" || status=1

while IFS= read -r file; do
  bun test --max-concurrency=1 "./$file" || status=1
done < tools/test/integration-files.txt
exit "$status"
