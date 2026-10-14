#!/bin/sh
# Keep each heavy file in its own process, after the ordinary lane has exited.
set -u
lane=${1:-all}
case "$lane" in
  all|unit|integration) ;;
  *) echo "usage: sh tools/test/run.sh [all|unit|integration]" >&2; exit 2 ;;
esac

while IFS= read -r file; do
  if [ ! -f "$file" ]; then
    echo "missing integration test: $file" >&2
    exit 1
  fi
done < tools/test/integration-files.txt

status=0
if [ "$lane" != integration ]; then
  set --
  while IFS= read -r file; do
    set -- "$@" --path-ignore-patterns "$file"
  done < tools/test/integration-files.txt
  bun test "$@" || status=1
fi

if [ "$lane" != unit ]; then
  while IFS= read -r file; do
    bun test --max-concurrency=1 "./$file" || status=1
  done < tools/test/integration-files.txt
fi
exit "$status"
