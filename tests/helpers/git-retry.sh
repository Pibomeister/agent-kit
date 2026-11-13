#!/bin/sh
# Retries a git read that must print a path or a hash when it exits 0 with empty
# output. At most 3 attempts, with the same arguments. A finished git, any exit
# status, is returned as it is. An `ls-tree` that is still empty after the
# attempts is returned empty, so a path the pin does not contain stays missing.
# Setting or deleting a symbolic ref, an ancestor check, and every other
# command replace this shell with the real git. AK_GIT_REAL is that git.
# The copy placed on PATH bakes the path in, because the runner resolves this
# script as git and then starts it with a cleared environment.
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
    rev-parse | symbolic-ref | merge-base | blame | ls-tree)
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
  ls-tree) must=1 ;;
esac

if [ "$must" != 1 ]; then
  exec "$real" "$@"
fi

attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  # macOS mktemp without a template ignores TMPDIR and uses the per-user temp
  # dir, which collects entries until creates in it stall. A template is what
  # places these captures in /tmp.
  out=$(mktemp /tmp/ak-git-out.XXXXXX) || exit 1
  err=$(mktemp /tmp/ak-git-err.XXXXXX) || exit 1
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
