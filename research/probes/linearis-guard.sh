#!/usr/bin/env bash
#
# Re-derive the "Verified offline" table in adapters/tracker/backends/linear-linearis.md §3.
#
# The table is a claim about the guarded form printed in that section, so this
# probe runs *that* form -- it extracts the first ```sh block under "## 3." from
# the file, replaces `<command>` with the probe's arguments, and never carries a
# copy of its own that could drift from the document.
#
#   ./research/probes/linearis-guard.sh
#
# It installs linearis@2026.8.0 exactly into a scratch project (the one network
# step, against the npm registry), then routes every linearis request to a dead
# proxy, so no run can reach Linear. Node's fetch ignores HTTPS_PROXY unless
# NODE_USE_ENV_PROXY=1 is set (Node >= 22.21 / 24), so that is set too; without
# it the requests go straight out, and row 8 would report Linear's
# "Authentication required" instead of "fetch failed". No real token is used: the "tokens" are
# fixed strings, and every run that gets as far as linearis fails on the network
# or on the missing token, which is the point.
#
# Each row prints PASS or FAIL; the exit status is the number of FAILs.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
DOC="$ROOT/adapters/tracker/backends/linear-linearis.md"
VERSION="2026.8.0"

WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

GUARD="$WORK/guard.sh"
awk '
  /^## 3\./ { in3 = 1 }
  in3 && /^```sh$/ && !done { grab = 1; next }
  grab && /^```$/ { grab = 0; done = 1 }
  grab { print }
' "$DOC" | sed 's/<command>/"$@"/' > "$GUARD"
if [ ! -s "$GUARD" ]; then
  echo "linearis-guard: no sh block under §3 of $DOC" >&2
  exit 1
fi

PROJ="$WORK/project"
mkdir -p "$PROJ/src/deep"
(
  cd "$PROJ" || exit 1
  git init -q
  printf '{ "name": "probe", "private": true }\n' > package.json
  npm install --silent --no-audit --no-fund --save-exact "linearis@$VERSION" > /dev/null 2>&1
) || { echo "linearis-guard: npm install linearis@$VERSION failed" >&2; exit 1; }
printf 'backend: linear-linearis\ntoken_file: .linear-token\ndefaults: { team: PROBE }\n' > "$PROJ/ak.tracker.yaml"

# The operator's home: holds the deprecated global token the guard must not let linearis read.
OPHOME="$WORK/operator-home"
mkdir -p "$OPHOME"
printf 'lin_api_global_probe\n' > "$OPHOME/.linear_api_token"

# A logging mktemp ahead of the real one records every temp home the guard makes, so the trap's
# cleanup is observable. TMPDIR would not do: macOS mktemp -d ignores it.
SHIM="$WORK/shim"; MKTEMP_LOG="$WORK/mktemp.log"
mkdir -p "$SHIM"; : > "$MKTEMP_LOG"
REAL_MKTEMP="$(command -v mktemp)"
printf '#!/bin/sh\nd="$(%s "$@")" || exit\nprintf "%%s\\n" "$d" >> %s\nprintf "%%s\\n" "$d"\n' "$REAL_MKTEMP" "$MKTEMP_LOG" > "$SHIM/mktemp"
chmod +x "$SHIM/mktemp"

DEAD=(NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 NO_UPDATE_NOTIFIER=1)

FAILS=0
row() { # row <name> <ok:0|1> <detail>
  if [ "$2" -eq 1 ]; then echo "PASS  $1"; else echo "FAIL  $1 -- $3"; FAILS=$((FAILS + 1)); fi
}

guarded() { # guarded <cwd> [VAR=val ...] -- <linearis args>
  local cwd="$1"; shift
  local vars=()
  local shell_flags=()
  [ "${GUARD_ERREXIT:-}" = 1 ] && shell_flags=(-e)
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  (cd "$cwd" && env "${DEAD[@]}" HOME="$OPHOME" PATH="$SHIM:$PATH" token_file=.linear-token ${vars[@]+"${vars[@]}"} \
    "${GUARD_SHELL:-sh}" ${shell_flags[@]+"${shell_flags[@]}"} -c ". \"\$0\"" "$GUARD" "$@") 2>&1
}

# 1. Absent token, from a subdirectory.
rm -f "$PROJ/.linear-token"
out="$(guarded "$PROJ/src/deep" -- issues list)"; st=$?
row "absent token refused from a subdirectory, linearis never reached" "$([ $st -eq 1 ] && [[ "$out" == *"refused: .linear-token is absent"* ]] && [ ! -s "$MKTEMP_LOG" ] && echo 1 || echo 0)" "exit $st: $out"

# 2. Blank token.
printf ' \r\n\t' > "$PROJ/.linear-token"
out="$(guarded "$PROJ/src/deep" -- issues list)"; st=$?
row "blank token refused" "$([ $st -eq 1 ] && [[ "$out" == *"is blank"* ]] && echo 1 || echo 0)" "exit $st: $out"

# 3. Two lines.
printf 'lin_api_one\nlin_api_two\n' > "$PROJ/.linear-token"
out="$(guarded "$PROJ/src" -- issues list)"; st=$?
row "multi-line token refused" "$([ $st -eq 1 ] && [[ "$out" == *"more than one line or word"* ]] && echo 1 || echo 0)" "exit $st: $out"

# 4. GIT_DIR naming another repository does not redirect the search.
OTHER="$WORK/other"; mkdir -p "$OTHER"; git -C "$OTHER" init -q
rm -f "$PROJ/.linear-token"
out="$(guarded "$PROJ/src" GIT_DIR="$OTHER/.git" GIT_WORK_TREE="$OTHER" -- issues list)"; st=$?
row "GIT_DIR/GIT_WORK_TREE from the caller ignored" "$([ $st -eq 1 ] && [[ "$out" == *".linear-token is absent"* ]] && echo 1 || echo 0)" "exit $st: $out"

# 5. No binding up to the top level, and one in the repository's parent the search must not reach.
mv "$PROJ/ak.tracker.yaml" "$WORK/ak.tracker.yaml"
out="$(guarded "$PROJ/src/deep" -- issues list)"; st=$?
row "no binding: refused at the top level, search ends" "$([ $st -eq 1 ] && [[ "$out" == *"no ak.tracker.yaml"* ]] && echo 1 || echo 0)" "exit $st: $out"
mv "$WORK/ak.tracker.yaml" "$PROJ/ak.tracker.yaml"

# 6. linearis itself, empty token, empty home.
EMPTY="$WORK/empty-home"; mkdir -p "$EMPTY"
out="$(cd "$PROJ" && env "${DEAD[@]}" LINEAR_API_TOKEN="" HOME="$EMPTY" XDG_CONFIG_HOME="$EMPTY" "$PROJ/node_modules/.bin/linearis" issues list 2>&1)"; st=$?
row "linearis, empty token and empty home: No API token found" "$([ $st -ne 0 ] && [[ "$out" == *"No API token found"* ]] && echo 1 || echo 0)" "exit $st: $out"

# 7. Control: the global fallback is real.
out="$(cd "$PROJ" && env "${DEAD[@]}" LINEAR_API_TOKEN="" HOME="$OPHOME" XDG_CONFIG_HOME="$OPHOME" "$PROJ/node_modules/.bin/linearis" issues list 2>&1)"; st=$?
row "control: operator home's ~/.linear_api_token is used" "$([[ "$out" == *"linear_api_token"* ]] && [[ "$out" != *"No API token found"* ]] && echo 1 || echo 0)" "exit $st: $out"

# 8. Guarded, project token present, operator home holding the global token.
printf '  lin_api_project_probe \r\n' > "$PROJ/.linear-token"
out="$(guarded "$PROJ/src" -- issues list)"; st=$?
row "guarded: project token used, global token not read, request stopped at the dead proxy" "$([[ "$out" == *"fetch failed"* ]] && [[ "$out" != *"linear_api_token"* ]] && echo 1 || echo 0)" "exit $st: $out"
made="$(grep -c . "$MKTEMP_LOG")"; leftover=0
while IFS= read -r d; do [ -e "$d" ] && leftover=$((leftover + 1)); done < "$MKTEMP_LOG"
row "guarded: every temporary home removed" "$([ "$made" -gt 0 ] && [ "$leftover" -eq 0 ] && echo 1 || echo 0)" "$made made, $leftover left behind"

# Negative control: npm exec --no still picks a PATH binary in another project.
GLOBAL_ONLY="$WORK/global-only"; GLOBAL_BIN="$WORK/global-bin"
mkdir -p "$GLOBAL_ONLY" "$GLOBAL_BIN"
printf '{"name":"global-only","private":true}\n' > "$GLOBAL_ONLY/package.json"
ln -s "$PROJ/node_modules/.bin/linearis" "$GLOBAL_BIN/linearis"
out="$(cd "$GLOBAL_ONLY" && PATH="$GLOBAL_BIN:$PATH" NO_UPDATE_NOTIFIER=1 npm exec --no -- linearis --version 2>&1)"; st=$?
row "negative control: npm exec --no accepts a PATH binary outside this project" "$([ "$st" -eq 0 ] && [ "$out" = "$VERSION" ] && echo 1 || echo 0)" "exit $st: $out"

if command -v zsh >/dev/null; then
  rm "$PROJ/node_modules/.bin/linearis"
  cat > "$PROJ/node_modules/.bin/linearis" <<'SH'
#!/bin/sh
if [ "$1" = --version ]; then echo 2026.8.0; exit 0; fi
if [ "$1" = probe-success ]; then echo '{"issues":[]}'; exit 0; fi
echo '{"error":"Authentication required, not authenticated"}' >&2
exit 1
SH
  chmod +x "$PROJ/node_modules/.bin/linearis"
  out="$(GUARD_SHELL=zsh guarded "$PROJ/src" -- probe-success)"; st=$?
  row "zsh guarded success keeps result JSON" "$([ "$st" -eq 0 ] && [ "$out" = '{"issues":[]}' ] && echo 1 || echo 0)" "exit $st: $out"
  out="$(GUARD_SHELL=zsh guarded "$PROJ/src" -- probe-auth)"; st=$?
  row "zsh guarded auth rejection becomes exit 42" "$([ "$st" -eq 42 ] && [[ "$out" == *"Authentication required, not authenticated"* ]] && echo 1 || echo 0)" "exit $st: $out"
  for shell in sh bash zsh; do
    out="$(GUARD_SHELL="$shell" GUARD_ERREXIT=1 guarded "$PROJ/src" -- probe-auth)"; st=$?
    row "$shell -e guarded auth rejection keeps exit 42 and text" "$([ "$st" -eq 42 ] && [[ "$out" == *"Authentication required, not authenticated"* ]] && echo 1 || echo 0)" "exit $st: $out"
  done
fi

echo "linearis $VERSION, guard extracted from ${DOC#"$ROOT/"} at $(git -C "$ROOT" rev-parse --short HEAD)$([ -z "$(git -C "$ROOT" status --porcelain -- "$DOC")" ] || echo ' (working tree: uncommitted)'): $FAILS failed"
exit "$FAILS"
