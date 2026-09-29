#!/usr/bin/env bash
# Run the built bundle's eval suite on this machine, print a per-arm table and write a receipt.
#
#   scripts/eval-local.sh [--inherit-env] [claude plugin eval options…]
#   scripts/eval-local.sh --tag firstmate --runs 3 --max-cost-usd 2
#   scripts/eval-local.sh --exclude-tag needs-fixture
#
# Grants. Each case gets the gated tools its case.yaml declares and no others. The cases are
# grouped by those tools and each group runs as its own host invocation (see "Grants" below), so a
# full run is several invocations whose results are merged into one JSON and one receipt.
#
# Isolation. The host already gives every eval child a temporary home, working directory and
# configuration, so the user's settings, hooks, CLAUDE.md, plugins, MCP servers and memory are
# absent from both arms; research/evals/2026-09-25-isolation.md measured that. What the host does
# pass through is part of the invoking shell's environment: every ANTHROPIC_*, CLAUDE_CODE_* and
# EVAL_* variable. Run from inside an agent session, that is the session's id, messaging socket,
# feature flags and any model override. So by default the host runs under `env -i` with only the
# variables in `pass_env` below (plus LC_* and any names listed in $AK_EVAL_PASS_ENV).
# --inherit-env skips that and hands the host the whole shell environment; it exists for the
# control run in scripts/eval-isolation-probe.sh and is recorded in the receipt.
#
# Why the ~/.docker shuffle: the eval sandbox refuses to start a Bash-granting case while any symlink
# sits under ~/.docker, and Docker Desktop keeps symlinks in ~/.docker/cli-plugins and ~/.docker/bin.
# The script moves those two directories aside for the run and puts them back on every exit path,
# including Ctrl-C. Nothing else under ~/.docker is touched. Run it only by hand; CI never calls it.
#
# Reads: dist/claude-code (run `bun run ak build --profile all` first), or $AK_EVAL_BUNDLE. Writes: evals/results/
# under the bundle, the JSON result to $AK_EVAL_JSON (default: a temp file whose path is printed),
# and the receipt beside it as <result>.receipt.json. The host runs with --keep-temp, which keeps
# each run's sandbox (workspace and trace.jsonl) under the system temporary directory after the
# invocation returns; each trace is then copied under <result>.traces/<case dir>/<arm>-<n>.jsonl,
# because the system cleans that directory on its own schedule.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bundle="${AK_EVAL_BUNDLE:-$root/dist/claude-code}"
[[ -d "$bundle" ]] || { echo "eval-local: no $bundle; run 'bun run ak build --profile all' first" >&2; exit 2; }
command -v jq >/dev/null || { echo "eval-local: jq is required" >&2; exit 2; }

# /usr/bin/git on macOS is a developer-tool shim. Inside the eval sandbox it cannot update the
# cache it uses to locate the real executable, so every Git-backed case stops before the behavior
# under test. Resolve the concrete executable while still outside the sandbox and put a directory
# holding only a symlink to it first on the child's PATH, so nothing else beside it is shadowed.
# Other platforms keep the ordinary PATH resolution. Whether the sandbox runs the executable is
# unverified until a paid run exercises it; the receipt's summary line says so.
host_git="$(command -v git 2>/dev/null || true)"
host_git_source=path
if command -v xcrun >/dev/null 2>&1; then
  xcode_git="$(xcrun -f git 2>/dev/null || true)"
  if [[ -n "$xcode_git" && -x "$xcode_git" ]]; then
    host_git="$xcode_git"
    host_git_source=xcrun
  fi
fi
[[ -n "$host_git" && -x "$host_git" ]] || { echo "eval-local: git is required" >&2; exit 2; }
git_shim="$(mktemp -d "${TMPDIR:-/tmp}/ak-git-shim.XXXXXX")"
ln -s "$host_git" "$git_shim/git"
host_path="$git_shim:$PATH"

# The script reads four of the host's options itself: --case and --tag (to know which cases run),
# --eval-dir (where they live) and --max-cost-usd (one budget across every invocation). --case and
# --tag stop here: the host keeps only the last --case it is given, so the selection is made by
# staging a copy of the bundle whose eval directory holds only the selected cases (see "Grants").
# --eval-dir, --runs and --ablation go through to the host; the script also notes the last two to
# tell which cases a cut-short invocation left short. --allow-tools is taken out and replaced by the
# case grants unless the user passed it, in which case it goes through unchanged and overrides them.
# --scaffold is added when the host offers it and the user passed neither it nor --no-scaffold; the
# cases in this repository are ours, so their scaffold scripts are trusted. When scaffolds do not
# run, each invocation lists the cases that declare one in `scaffoldSkipped`.
# --exclude-tag is the script's own; the host has no exclude. A selected case carrying any excluded
# tag is dropped from the staged copy before the host sees it, and the receipt lists it under
# `exclusions`, so a quoted figure says which cases it leaves out.
isolation=env-allowlist
args=()
case_globs=()
tags=()
exclude_tags=()
user_tools=()
budget=
eval_dir=
runs=
ablation=
scaffold=auto
while [[ $# -gt 0 ]]; do
  case "$1" in
    --inherit-env) isolation=inherited-env; shift ;;
    --case) case_globs+=("$2"); shift 2 ;;
    --case=*) case_globs+=("${1#*=}"); shift ;;
    --eval-dir) eval_dir="$2"; args+=("$1" "$2"); shift 2 ;;
    --eval-dir=*) eval_dir="${1#*=}"; args+=("$1"); shift ;;
    --runs) runs="$2"; args+=("$1" "$2"); shift 2 ;;
    --runs=*) runs="${1#*=}"; args+=("$1"); shift ;;
    --ablation) ablation="$2"; args+=("$1" "$2"); shift 2 ;;
    --ablation=*) ablation="${1#*=}"; args+=("$1"); shift ;;
    --scaffold) scaffold=on; args+=("$1"); shift ;;
    --no-scaffold) scaffold=off; args+=("$1"); shift ;;
    --max-cost-usd) budget="$2"; shift 2 ;;
    --max-cost-usd=*) budget="${1#*=}"; shift ;;
    --exclude-tag) exclude_tags+=("$2"); shift 2 ;;
    --exclude-tag=*) exclude_tags+=("${1#*=}"); shift ;;
    --tag=*) tags+=("${1#*=}"); shift ;;
    --allow-tools=*) user_tools+=("${1#*=}"); shift ;;
    --tag | --allow-tools)
      flag="$1"; shift
      while [[ $# -gt 0 && "$1" != -* ]]; do
        if [[ "$flag" == --tag ]]; then tags+=("$1"); else user_tools+=("$1"); fi
        shift
      done ;;
    *) args+=("$1"); shift ;;
  esac
done

revision="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
dirty=false
[[ -z "$(git -C "$root" status --porcelain 2>/dev/null)" ]] || dirty=true
# The packager writes no build stamp, so freshness is the mtime comparison: no source newer than
# the bundle. It is only asked of the repository's own dist/.
fresh=null
if [[ "$bundle" == "$root/dist/claude-code" ]]; then
  fresh=true
  if [[ -n "$(cd "$root" && find catalog.yaml skills packs protocols roles references adapters schemas policies profiles provenance src evals -newer "$bundle" -print -quit 2>/dev/null)" ]]; then
    fresh=false
    echo "eval-local: $bundle is older than its sources; run 'bun run ak build --profile all' to measure this tree" >&2
  fi
fi
bundle_sha="$(cd "$bundle" && find . -type f ! -path './evals/results/*' -print0 | LC_ALL=C sort -z \
  | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
install=default
[[ -f "$root/ak.install.yaml" ]] && install=ak.install.yaml
donors=false
[[ -d "$root/.donors" ]] && donors=true
host_version="$(claude --version 2>/dev/null || echo unknown)"
if [[ "$scaffold" == auto ]]; then
  if claude plugin eval --help 2>/dev/null | grep -qE -- '--scaffold( |$)'; then
    scaffold=on
    args+=(--scaffold)
  else
    scaffold=unsupported
  fi
fi

pass_env=(HOME USER LOGNAME PATH SHELL TERM LANG TMPDIR
  HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE
  ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN
  CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CONFIG_DIR)
read -r -a extra <<<"${AK_EVAL_PASS_ENV:-}"
while IFS= read -r name; do pass_env+=("$name"); done < <(compgen -e | grep '^LC_' || true)
runner=()
passed=()
if [[ "$isolation" == env-allowlist ]]; then
  runner=(env -i)
  for name in "${pass_env[@]}" "${extra[@]+"${extra[@]}"}"; do
    if [[ "$name" == PATH ]]; then
      runner+=("PATH=$host_path")
      passed+=(PATH)
    elif [[ -n "${!name+set}" ]]; then
      runner+=("$name=${!name}")
      passed+=("$name")
    fi
  done
else
  runner=(env "PATH=$host_path")
fi

aside="$(mktemp -d "${TMPDIR:-/tmp}/ak-docker-aside.XXXXXX")"
moved=()
# shellcheck disable=SC2329 # invoked by the EXIT trap
restore() {
  local name
  for name in "${moved[@]+"${moved[@]}"}"; do
    if [[ -e "$HOME/.docker/$name" ]]; then
      echo "eval-local: ~/.docker/$name reappeared during the run; the original is kept at $aside/$name" >&2
    else
      mv "$aside/$name" "$HOME/.docker/$name"
    fi
  done
  rmdir "$aside" 2>/dev/null || true
  rm -rf "$git_shim"
}
trap restore EXIT
trap 'exit 130' INT TERM

for name in cli-plugins bin; do
  if [[ -e "$HOME/.docker/$name" || -L "$HOME/.docker/$name" ]]; then
    mv "$HOME/.docker/$name" "$aside/$name"
    moved+=("$name")
  fi
done
if [[ -d "$HOME/.docker" ]] && find "$HOME/.docker" -type l -print -quit | grep -q .; then
  echo "eval-local: ~/.docker still holds a symlink outside cli-plugins/ and bin/; Bash-granting cases may not start" >&2
fi

json="${AK_EVAL_JSON:-$(mktemp -d "${TMPDIR:-/tmp}/ak-eval.XXXXXX")/result.json}"
mkdir -p "$(dirname "$json")"
receipt="${json%.json}.receipt.json"

# Grants. The host adds an --allow-tools grant to every case in the invocation, not only to the cases
# that list the tool (research/evals/2026-09-25-isolation.md), so one union grant would widen every
# case that lists fewer. The selected cases are grouped by the gated tools they declare, and each
# group runs in its own invocation against a staged copy of the bundle whose eval directory holds
# only that group's cases. The same staging applies the --case, --tag and --exclude-tag selection,
# so the host is never asked to select. Only an unfiltered run of one group uses the bundle itself.
[[ -n "$eval_dir" ]] || eval_dir="$(jq -r '.experimental.evals // "evals"' "$bundle/.claude-plugin/plugin.json" 2>/dev/null || echo evals)"
# One line per case: run, skip (not selected) or exclude (selected, but carries an excluded tag).
listing="$(cd "$root" && AK_EVALS_DIR="$bundle/$eval_dir" \
    AK_CASE_GLOBS="$(printf '%s\n' "${case_globs[@]+"${case_globs[@]}"}")" \
    AK_TAGS="$(printf '%s\n' "${tags[@]+"${tags[@]}"}")" \
    AK_EXCLUDE_TAGS="$(printf '%s\n' "${exclude_tags[@]+"${exclude_tags[@]}"}")" bun -e '
      import { parse } from "yaml";
      import { readdirSync, readFileSync } from "fs";
      import { basename, dirname, join, relative } from "path";
      const root = process.env.AK_EVALS_DIR!;
      const lines = (v?: string) => (v ?? "").split("\n").filter(Boolean);
      const globs = lines(process.env.AK_CASE_GLOBS).map((g) => new Bun.Glob(g));
      const tags = lines(process.env.AK_TAGS);
      const excluded = lines(process.env.AK_EXCLUDE_TAGS);
      const gated = (t: string) => /^(Bash|Write|Edit|WebFetch|NotebookEdit)(\(|$)/.test(t) || t.startsWith("mcp__");
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (d === root && e.name === "results" ? [] : walk(join(d, e.name)))
          : e.name === "case.yaml" ? [join(d, e.name)] : []);
      for (const file of walk(root).sort()) {
        const doc = parse(readFileSync(file, "utf8")) ?? {};
        const name = String(doc.name ?? basename(dirname(file)));
        const own: string[] = doc.tags ?? [];
        const selected = (globs.length === 0 || globs.some((g) => g.match(name)))
          && (tags.length === 0 || own.some((t) => tags.includes(t)));
        const status = !selected ? "skip" : own.some((t) => excluded.includes(t)) ? "exclude" : "run";
        const tools = [...new Set<string>((doc.execution?.allowed_tools ?? doc.allowed_tools ?? []).filter(gated))].sort();
        const runs = Number.isInteger(doc.runs) ? String(doc.runs) : "";
        const scaffold = doc.context?.scaffold_script ?? doc.scaffold_script ? "scaffold" : "";
        console.log([status, tools.join(","), relative(root, dirname(file)), name, runs, scaffold].join("\t"));
      }')" || { echo "eval-local: could not read the cases under $bundle/$eval_dir" >&2; exit 2; }
if ! awk -F'\t' '$1 == "run" { found = 1 } END { exit !found }' <<<"$listing"; then
  echo "eval-local: no case under $bundle/$eval_dir matches the --case, --tag and --exclude-tag filters; nothing run" >&2
  exit 2
fi
missing_skills="$(while IFS= read -r skill; do
  [[ -f "$bundle/skills/$skill/SKILL.md" ]] || echo "$skill"
done < <(awk -F'\t' '$1 == "run" { split($3, p, "/"); print p[1] }' <<<"$listing" | sort -u))"
if [[ -n "$missing_skills" ]]; then
  echo "eval-local: $bundle does not install $(paste -sd, - <<<"$missing_skills"); run 'bun run ak build --profile all' first" >&2
  exit 2
fi
exclusions="$(awk -F'\t' -v d="$eval_dir" '$1 == "exclude" { print d "/" $3 "\t" $4 }' <<<"$listing" \
  | jq -Rsc --args 'split("\n") | map(select(. != "") | split("\t") | {dir: .[0], name: .[1]})
               | {tags: $ARGS.positional, cases: .}' "${exclude_tags[@]+"${exclude_tags[@]}"}")"
excluding="$(jq -r '.cases | length > 0' <<<"$exclusions")"
[[ "$excluding" == false ]] || echo "eval-local: $(jq '.cases | length' <<<"$exclusions") case(s) excluded by tag" >&2
groups=()
if [[ ${#user_tools[@]} -gt 0 ]]; then
  grant_source=user
  groups=("$(IFS=,; echo "${user_tools[*]}")")
else
  grant_source=cases
  while IFS= read -r key; do groups+=("$key"); done < <(awk -F'\t' '$1 == "run" { print $2 }' <<<"$listing" | sort -u)
fi

staged=false
if [[ ${#groups[@]} -gt 1 || "$excluding" == true || ${#case_globs[@]} -gt 0 || ${#tags[@]} -gt 0 ]]; then staged=true; fi
aggregate=0
spent=0
invocations="${json%.json}.invocations.jsonl"
: >"$invocations"
traces_dir="${json%.json}.traces"
traces="${json%.json}.traces.jsonl"
: >"$traces"
parts=()
for i in "${!groups[@]}"; do
  key="${groups[$i]}"
  target="$bundle"
  out="$json"
  if [[ "$staged" == true ]]; then
    target="${json%.json}.groups/$i/$(basename "$bundle")"
    out="${json%.json}.group-$i.json"
    rm -rf "$target"
    mkdir -p "$(dirname "$target")"
    cp -R "$bundle" "$target"
    rm -rf "${target:?}/$eval_dir/results"
    while IFS= read -r dir; do
      if [[ "$dir" != . ]]; then rm -rf "${target:?}/$eval_dir/${dir:?}"; fi
    done < <(awk -F'\t' -v k="$key" -v src="$grant_source" '$1 != "run" || (src == "cases" && $2 != k) { print $3 }' <<<"$listing")
  fi
  # The group's cases with their own run counts. Under the user's grant, every selected case.
  wanted="$(awk -F'\t' -v k="$key" -v src="$grant_source" '$1 == "run" && (src == "user" || $2 == k) { print $4 "\t" $5 "\t" $6 }' <<<"$listing" \
    | jq -Rsc 'split("\n") | map(select(. != "") | split("\t")
               | {name: .[0], runs: (.[1] | tonumber? // null), scaffold: (.[2] == "scaffold")})')"
  scaffold_skipped="$(jq -nc --argjson wanted "$wanted" --arg mode "$scaffold" \
    'if $mode == "on" then [] else [$wanted[] | select(.scaffold) | .name] end')"
  grant=()
  [[ -z "$key" ]] || { IFS=, read -r -a tools_list <<<"$key"; grant=(--allow-tools "${tools_list[@]}"); }
  cap=()
  if [[ -n "$budget" ]]; then
    left="$(jq -n --argjson b "$budget" --argjson s "$spent" '($b - $s) * 10000 | floor / 10000')"
    if jq -e -n --argjson l "$left" '$l <= 0' >/dev/null; then
      echo "eval-local: budget spent; group [${key:-no gated tools}] not run" >&2
      jq -nc --arg tools "$key" --argjson wanted "$wanted" \
        '{grant: ($tools | split(",") | map(select(. != ""))), cases: ($wanted | map(.name)),
          skipped: "budget", partial: true, incomplete_cases: ($wanted | map(.name) | unique)}' >>"$invocations"
      aggregate=2
      continue
    fi
    cap=(--max-cost-usd "$left")
  fi
  command=(claude plugin eval "$target" --no-publish --keep-temp --json "$out" "${args[@]+"${args[@]}"}" "${grant[@]+"${grant[@]}"}" "${cap[@]+"${cap[@]}"}")
  printf -v cmdline '%q ' "${command[@]}"
  echo "eval-local: group $((i + 1))/${#groups[@]}: grant [${key:-none}]" >&2
  set +e
  "${runner[@]+"${runner[@]}"}" "${command[@]}"
  status=$?
  set -e
  if (( status > aggregate )); then aggregate=$status; fi
  cost=0
  partial=true
  if [[ -s "$out" ]]; then
    parts+=("$out")
    while IFS=$'\t' read -r dir name arm n from; do
      to=
      if [[ -n "$from" && -f "$from" ]]; then
        to="$traces_dir/$dir/$arm-$n.jsonl"
        mkdir -p "$(dirname "$to")"
        cp "$from" "$to"
      fi
      jq -nc --arg dir "$dir" --arg name "$name" --arg arm "$arm" --argjson run "$n" --arg from "$from" --arg to "$to" \
        '{dir: $dir, name: $name, arm: $arm, run: $run, hostPath: $from, copy: (if $to == "" then null else $to end)}' >>"$traces"
    done < <(jq -r '.cases[]? | (.dir // .name) as $d | .name as $c | (.arms // {}) | to_entries[] | .key as $a
                    | .value | to_entries[] | [$d, $c, $a, (.key + 1), (.value.tracePath // "")] | @tsv' "$out")
    cost="$(jq '.costUsd // 0' "$out")"
    partial="$(jq '.partial == true' "$out")"
    spent="$(jq -n --argjson a "$spent" --argjson b "$cost" '$a + $b')"
  fi
  # Cases with fewer runs on an arm than were asked for (--runs, else the case's runs, else the
  # host's default of 3), or absent from the result. The without arm counts unless --ablation none.
  incomplete="$(jq -c --argjson wanted "$wanted" --arg runs "$runs" --arg ablation "$ablation" '
    (.cases // []) as $got
      | [$wanted | group_by(.name)[] | .[0].name as $n | [$got[] | select(.name == $n)] as $g
         | select(($g | length) < length or any(range(0; $g | length) as $i
             | (if $runs != "" then ($runs | tonumber) else (.[$i].runs // 3) end) as $r
             | (($g[$i].arms.with // []) | length) < $r
               or ($ablation != "none" and (($g[$i].arms.without // []) | length) < $r); .))
         | $n]' "$(if [[ -s "$out" ]]; then echo "$out"; else echo /dev/null; fi)")"
  [[ -n "$incomplete" ]] || incomplete="$(jq -nc --argjson wanted "$wanted" '$wanted | map(.name) | unique')"
  # The host's own partial flag does not cover a case it never ran, so the comparison decides too.
  # A group that ran none of its cases is an error: the host exits 1 for it, the script exits 2.
  error=null
  got="$(if [[ -s "$out" ]]; then jq '.cases // [] | length' "$out"; else echo 0; fi)"
  if [[ "$got" == 0 ]]; then
    error='"nothing run"'
    echo "eval-local: group [${key:-no gated tools}] ran none of its $(jq length <<<"$wanted") case(s)" >&2
    if (( aggregate < 2 )); then aggregate=2; fi
  elif [[ "$incomplete" != "[]" ]]; then
    echo "eval-local: group [${key:-no gated tools}] left case(s) short: $(jq -r 'join(", ")' <<<"$incomplete")" >&2
  fi
  [[ "$incomplete" == "[]" ]] || partial=true
  target_sha="$(cd "$target" && find . -type f ! -path "./$eval_dir/results/*" -print0 | LC_ALL=C sort -z \
    | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
  jq -nc --arg tools "$key" --arg command "${cmdline% }" --argjson status "$status" --argjson cost "$cost" \
    --argjson partial "$partial" --arg bundle "$target" --arg sha "$target_sha" --arg out "$out" \
    --argjson wanted "$wanted" --argjson incomplete "$incomplete" --argjson scaffold_skipped "$scaffold_skipped" \
    --argjson error "$error" \
    '{grant: ($tools | split(",") | map(select(. != ""))), cases: ($wanted | map(.name)),
      bundle: $bundle, bundleSha256: $sha, command: $command, exitStatus: $status, costUsd: $cost, partial: $partial,
      incomplete_cases: $incomplete, error: $error, scaffoldSkipped: $scaffold_skipped, result: $out}' >>"$invocations"
done
status=$aggregate
[[ ${#parts[@]} -gt 0 ]] || { echo "eval-local: no result at $json" >&2; exit "$status"; }
if [[ ${#groups[@]} -gt 1 ]]; then
  # The host's overall figures are per invocation; the merged ones are unweighted means over cases.
  jq -s '{cases: [.[].cases[]], costUsd: (map(.costUsd // 0) | add),
          durationSeconds: (map(.durationSeconds // 0) | add), partial: any(.[]; .partial == true),
          aggregates: {overallScore: ([.[].cases[].aggregates.score | numbers] | if length > 0 then add / length else null end),
                       meanDelta: ([.[].cases[].aggregates.delta | numbers] | if length > 0 then add / length else null end)},
          merged: length}' "${parts[@]}" >"$json"
elif [[ "$staged" == true ]]; then
  cp "${parts[0]}" "$json"
fi

# Per case and arm: n runs, passes (a run passes when every grader that counts toward the score
# passed; with-only graders do not count toward the score), the rate with its 95% Wilson interval,
# and the fired count on the with arm. The graders that count are read from the runs, where the
# host marks with-only ones; the case-level definitions carry no such mark. A run the host cut
# short for budget carries skippedPaidGraders and each skipped grader as failed with the
# explanation "skipped: cost ceiling" (research/evals/2026-09-28-a1-rerun/budget-skipped-run.json);
# those verdicts are missing, not negative, so the run is ungraded unless a scored grader failed. A run fired when every with-only `tool_used` grader on the
# Skill tool passed; the case's grader definitions in the result name them. Other with-only graders,
# such as a negative's check that the workflow was not carried out, are not firing. A case with no
# such grader has fired null.
# shellcheck disable=SC2094 # reads $json, writes $receipt: two files
jq --arg revision "$revision" --argjson dirty "$dirty" --arg bundle "$bundle" \
   --arg bundle_sha "$bundle_sha" --argjson fresh "$fresh" --arg install "$install" \
   --argjson donors "$donors" --arg host "$host_version" --arg isolation "$isolation" \
   --arg host_git "$host_git" --arg host_git_source "$host_git_source" \
   --argjson status "$status" --arg json "$json" --arg grant_source "$grant_source" \
   --slurpfile invocations "$invocations" --slurpfile traces "$traces" --arg scaffold "$scaffold" \
   --argjson exclusions "$exclusions" --argjson budget "${budget:-null}" \
   --args '
  def wilson($k; $n): if $n == 0 then {lo: 0, hi: 1} else
      ($k / $n) as $p | 3.8416 as $z2
      | (($p + $z2 / (2 * $n)) / (1 + $z2 / $n)) as $c
      | ((1.96 * ((($p * (1 - $p)) / $n + $z2 / (4 * $n * $n)) | sqrt)) / (1 + $z2 / $n)) as $h
      | {lo: ([0, $c - $h] | max), hi: ([1, $c + $h] | min)} end;
  def verdicts($run; $expected): [$expected[] as $name
      | [$run.graders[]? | select(.name == $name)
         | if $run.skippedPaidGraders == true and ((.explanation // "") | startswith("skipped:")) then null else .passed end]
        | first];
  def graded($run; $expected): ($expected | length) > 0
      and (verdicts($run; $expected) | any(. == false) or all(type == "boolean"));
  def passed($run; $expected): ($expected | length) > 0
      and (verdicts($run; $expected) | all(. == true));
  def arm($runs; $expected): ($runs | length) as $n
      | ([$runs[] | select(graded(.; $expected))] | length) as $g
      | ([$runs[] | select(passed(.; $expected))] | length) as $k
      | {n: $n, graded: $g, ungraded: (if ($expected | length) == 0 then 0 else $n - $g end), passes: $k,
         rate: (if $g == 0 then null else $k / $g end), wilson95: wilson($k; $g)};
  def fired($runs; $skill): [$runs[] | [.graders[]? | select(.withOnly and (.name | IN($skill[]))) | .passed]]
      | if (map(length) | add // 0) == 0 then null
        else {n: length, fired: map(select(length > 0 and all)) | length} end;
  def skill_graders: [.graders[]? | select(.type == "tool_used" and .config.tool == "Skill") | .name];
  def score_graders: [(.arms // {})[][]?.graders[]? | select(.withOnly | not) | .name] | unique;
  (.costUsd | if type == "number" then . * 10000 | round / 10000 else . end) as $cost
  | [.cases[] | score_graders as $expected
                | arm(.arms.with // []; $expected) as $with | arm(.arms.without // []; $expected) as $without
                | ($with.ungraded + $without.ungraded == 0) as $complete
                | {name, dir, with: $with, without: $without, fired: fired(.arms.with // []; skill_graders),
                   score: (if $complete then .aggregates.score else null end),
                   scoreWithout: (if $complete then .aggregates.scoreWithout else null end),
                   delta: (if $complete then .aggregates.delta else null end)}] as $cases
  | ([$cases[] | .with.ungraded + .without.ungraded] | add // 0) as $ungraded
  | {
    measured: {revision: $revision, dirty: $dirty},
    bundle: {path: $bundle, sha256: $bundle_sha, freshAgainstSources: $fresh},
    install: $install,
    donorsPresent: $donors,
    host: $host,
    tooling: {git: {path: $host_git, source: $host_git_source}},
    isolation: {method: ("host-sandbox+" + $isolation), envPassed: (if $isolation == "inherited-env" then "all" else $ARGS.positional end)},
    grants: {source: $grant_source, union: ([$invocations[].grant[]] | unique)},
    scaffold: $scaffold,
    exclusions: $exclusions,
    invocations: $invocations,
    exitStatus: $status,
    result: $json,
    cases: $cases,
    overall: {score: (if $ungraded == 0 then .aggregates.overallScore else null end),
              meanDelta: (if $ungraded == 0 then .aggregates.meanDelta else null end),
              ungraded: $ungraded, mergedFrom: (.merged // 1)},
    traces: $traces,
    costUsd: $cost, durationSeconds: .durationSeconds,
    budget: $budget, over_budget: ($budget != null and $cost > $budget),
    partial: (.partial or any($invocations[]; .partial))
  }' "${passed[@]+"${passed[@]}"}" <"$json" >"$receipt" \
  || echo "eval-local: could not write the receipt for $json" >&2
# The host checks its cap as runs start, so runs already in flight can finish past it. Nothing is
# stopped here; the overshoot is warned about and recorded.
jq -r 'select(.over_budget) | "eval-local: spent $\(.costUsd) against a cap of $\(.budget); runs already in flight when the cap was reached finished past it"' \
  "$receipt" >&2 2>/dev/null || true

echo
jq -r '
  def n: if type == "number" then (. * 1000 | round / 1000 | tostring) else "-" end;
  def ci: "\(.passes)/\(.graded) [\(.wilson95.lo | n),\(.wilson95.hi | n)]\(if .ungraded > 0 then " + \(.ungraded) ungraded" else "" end)";
  (["case", "with", "without", "delta", "fired"] | @tsv),
  (.cases[] | [.name[0:60], (.with | ci), (.without | ci), (.delta | n),
               (if .fired then "\(.fired.fired)/\(.fired.n)" else "-" end)] | @tsv),
  (["overall", (.overall.score | n), "-", (.overall.meanDelta | n), "-"] | @tsv),
  "cost $\(.costUsd | n)  \(.durationSeconds | n)s  partial=\(.partial)\(if .over_budget then "  over budget (cap $\(.budget))" else "" end)",
  (if (.exclusions.cases | length) > 0
   then "excluded \(.exclusions.cases | length) case(s) tagged \(.exclusions.tags | join(", "))" else empty end)
' "$receipt" | column -t -s $'\t' || echo "eval-local: could not summarise $receipt" >&2
jq -r '"eval-local: measured \(.bundle.path) (sha256 \(.bundle.sha256[0:12]), fresh=\(.bundle.freshAgainstSources))",
       "eval-local: tree \(.measured.revision)\(if .measured.dirty then " (dirty)" else "" end)  .donors=\(.donorsPresent)  install=\(.install)",
       "eval-local: host \(.host)  isolation \(.isolation.method)  git=\(.tooling.git.path) (on the sandbox PATH; unverified in the live sandbox)"' "$receipt" 2>/dev/null || true
echo "eval-local: full result in $json"
echo "eval-local: receipt in $receipt"
exit "$status"
