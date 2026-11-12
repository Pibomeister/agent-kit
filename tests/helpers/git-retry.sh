#!/bin/sh
# Retries a git read that must print a path or a hash when it exits 0 with empty
# output. At most 3 attempts. A finished git, any exit status, is returned as it
# is. Setting or deleting a symbolic ref, an ancestor check, and every other
# command replace this shell with the real git. AK_GIT_REAL is that git.
# Keep the classification in step with commandMustPrint in git-spawn.ts.

real=${AK_GIT_REAL:?}

must=0
sub=
pos=0
delete=0
ancestor=0
porcelain=0
seen=0
for arg in "$@"; do
  case $arg in
    rev-parse | symbolic-ref | merge-base | blame)
      if [ -z "$sub" ]; then sub=$arg; fi
      ;;
  esac
  case $arg in
    --porcelain) porcelain=1 ;;
    -d | --delete) delete=1 ;;
    --is-ancestor) ancestor=1 ;;
    --format=%?*) must=1 ;;
  esac
done
for arg in "$@"; do
  if [ "$seen" -eq 0 ]; then
    if [ "$arg" = "$sub" ]; then seen=1; fi
    continue
  fi
  case $arg in
    -*) ;;
    *) pos=$((pos + 1)) ;;
  esac
done
case $sub in
  rev-parse) must=1 ;;
  merge-base)
    if [ "$ancestor" -eq 0 ]; then must=1; else must=0; fi
    ;;
  symbolic-ref)
    if [ "$delete" -eq 0 ] && [ "$pos" -eq 1 ]; then must=1; else must=0; fi
    ;;
  blame)
    if [ "$porcelain" -eq 1 ]; then must=1; else must=0; fi
    ;;
esac

if [ "$must" != 1 ]; then
  exec "$real" "$@"
fi

attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  out=$(mktemp)
  err=$(mktemp)
  "$real" "$@" >"$out" 2>"$err"
  status=$?
  if [ "$status" -eq 0 ] && [ "$attempt" -lt 3 ] && ! grep -q '[^[:space:]]' "$out" && ! grep -q '[^[:space:]]' "$err"; then
    rm -f "$out" "$err"
    sleep 0.05
    continue
  fi
  cat "$out"
  cat "$err" >&2
  rm -f "$out" "$err"
  exit "$status"
done
