#!/bin/sh
# Keep each heavy file in its own process, after the ordinary lane has exited.
set -u

while IFS= read -r file; do
  if [ ! -f "$file" ]; then
    echo "missing integration test: $file" >&2
    exit 1
  fi
done < tools/test/integration-files.txt

# Fixtures using TMPDIR share this private root, removed at exit. Process-scoped fixture helpers
# manage their own root (tests/helpers/process-tmp.ts). Bun lists every directory
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
# The ordinary lane runs files in parallel, so a per-test wall clock stretches with load. Both lanes
# use --timeout=30000 because the 5s per-test timeout is the harness default, not a product deadline.
# Explicit per-test timeouts still win.
# AK_TEST_PARALLEL is the explicit override. Unset, the worker count follows the one-minute load
# average per CPU: 4 below 2, 2 from 2 up to 4, and 1 at 4 or above. A reading that cannot be taken
# stays at 4, the count this lane used before the load rule.
ordinary_parallel() {
  if [ -n "${AK_TEST_PARALLEL:-}" ]; then
    printf '%s\n' "$AK_TEST_PARALLEL"
    return
  fi
  cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1\n')
  load=
  if [ -r /proc/loadavg ]; then
    load=$(awk '{print $1; exit}' /proc/loadavg 2>/dev/null || true)
  fi
  if [ -z "$load" ]; then
    load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2; exit}' || true)
  fi
  awk -v load="$load" -v cpus="$cpus" 'BEGIN {
    c = cpus + 0
    if (c < 1 || load == "") { print 4; exit }
    per = (load + 0) / c
    if (per >= 4) print 1
    else if (per >= 2) print 2
    else print 4
  }'
}
parallel=$(ordinary_parallel) || parallel=4
if [ -z "$parallel" ]; then
  parallel=4
fi
bun test --parallel="$parallel" --timeout=30000 "$@" || status=1

while IFS= read -r file; do
  bun test --max-concurrency=1 --timeout=30000 "./$file" || status=1
done < tools/test/integration-files.txt
exit "$status"
