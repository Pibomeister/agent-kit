#!/usr/bin/env bash
# Probe what reaches a host eval child from the machine that launches it.
#
#   scripts/eval-isolation-probe.sh on    # eval-local.sh as it runs by default
#   scripts/eval-isolation-probe.sh off   # eval-local.sh --inherit-env, the control
#
# It writes a throwaway bundle (one plugin, one case, no skills) to a temp directory, plants three
# canaries with fresh random values in the launching environment, and runs scripts/eval-local.sh
# against that bundle with one run per arm:
#
#   CLAUDE_CODE_AKPROBE_CANARY, EVAL_AKPROBE_CANARY  prefixes the host passes through to its child
#   AKPROBE_PLAIN_CANARY                             a prefix the host is not meant to pass
#
# The host's init event in each trace is the structural half of the answer: the plugins, MCP
# servers, skills, agents and memory paths the child actually loaded. The case also asks the agent
# to quote any instruction or memory context it was given and to print its environment. The verdict
# per arm is read from the traces: which canary values appear, and whether any marker of the
# operator's own setup does (global CLAUDE.md, claude-mem, OMC, RTK). None of those markers is in
# the prompt, so a hit can only have come from the child's context. Run from inside an agent
# session, it also checks whether that session's id and messaging socket reached the child.
#
# Spend: two short agent runs (about $0.30 in total on 2026-09-25) and a free regex grader. Extra arguments go to eval-local.sh.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-on}"
shift || true
case "$mode" in
  on) flag=() ;;
  off) flag=(--inherit-env) ;;
  *) echo "eval-isolation-probe: mode is on or off, not $mode" >&2; exit 2 ;;
esac

work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/ak-isolation-probe.XXXXXX")" && pwd -P)"
bundle="$work/ak-probe"
mkdir -p "$bundle/.claude-plugin" "$bundle/evals/isolation/context-and-env"
cat >"$bundle/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "ak-probe",
  "version": "0.0.0",
  "description": "Throwaway bundle for the eval isolation probe.",
  "skills": [],
  "experimental": { "evals": "evals" }
}
JSON
cat >"$bundle/evals/isolation/context-and-env/case.yaml" <<'YAML'
schema_version: "1.1"
name: context-and-env
tags: [isolation-probe]
runs: 1
execution:
  prompt: >-
    This is an environment diagnostic; answer it literally and do nothing else. Step 1: for every
    block of instructions, memory or injected context you were given before this message (a user
    or project instruction file, memory, session-start context, reminders), quote its first two
    lines verbatim, each prefixed with "CTX: ". Leave out the built-in tool and harness
    instructions. If there are none, write "CTX: none". Step 2: run `printenv | grep -E 'AKPROBE|SESSION_ID|MESSAGING_SOCKET'`
    with Bash and copy each output line prefixed with "ENV: ", or write "ENV: none". Step 3: run
    `printenv | cut -d= -f1 | sort | tr '\n' ' '` and copy the output prefixed with "NAMES: ".
    Finish with the line PROBE_DONE.
  max_turns: 6
  allowed_tools: [Bash]
graders:
  - name: probe-completed
    type: regex
    weight: 1
    pattern: "PROBE_DONE"
YAML

token() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
cc="cc-$(token)"
ev="ev-$(token)"
plain="pl-$(token)"
json="$work/result.json"

set +e
CLAUDE_CODE_AKPROBE_CANARY="$cc" EVAL_AKPROBE_CANARY="$ev" AKPROBE_PLAIN_CANARY="$plain" \
  AK_EVAL_BUNDLE="$bundle" AK_EVAL_JSON="$json" \
  "$root/scripts/eval-local.sh" "${flag[@]+"${flag[@]}"}" --trust-plugin --keep-temp --allow-tools Bash --runs 1 "$@"
status=$?
set -e
[[ -s "$json" ]] || { echo "eval-isolation-probe: no result at $json" >&2; exit "$status"; }

# The run record holds no transcript, only a trace path. eval-local.sh copies each trace beside the
# result and removes the scaffold the host kept, so the probe reads the copies its receipt lists.
markers='Rust Token Killer|oh-my-claudecode|claude-mem|project-memory-context|lavish|no-mistakes|firstmate|OMC'
verdicts=()
while IFS=$'\t' read -r arm trace; do
  if [[ ! -s "$trace" ]]; then
    verdicts+=("$(jq -n --arg arm "$arm" --arg trace "$trace" '{arm: $arm, error: "no trace at \($trace)"}')")
    continue
  fi
  verdicts+=("$(jq -Rs --arg arm "$arm" --arg session "${CLAUDE_CODE_SESSION_ID:-unset-session}" \
    --arg socket "${CLAUDE_CODE_MESSAGING_SOCKET:-unset-socket}" --arg cc "$cc" --arg ev "$ev" \
    --arg plain "$plain" --arg markers "$markers" '{
      arm: $arm,
      completed: contains("PROBE_DONE"),
      claudeCodeCanary: contains($cc),
      evalCanary: contains($ev),
      plainCanary: contains($plain),
      operatorMarkers: ([scan($markers)] | unique),
      launcherSessionId: contains($session),
      launcherMessagingSocket: contains($socket),
      init: (split("\n") | map(fromjson? // empty | select(.type == "system" and .subtype == "init"))
             | first | if . then {plugins: [.plugins[]?.source], mcpServers: [.mcp_servers[]?.name],
                                  skills, agents, memoryPaths: .memory_paths} else null end)
    }' "$trace")")
  cp "$trace" "$work/trace-$arm.jsonl"
done < <(jq -r '.traces[] | [.arm, (.copy // .hostPath)] | @tsv' "${json%.json}.receipt.json")
printf '%s\n' "${verdicts[@]}" | jq -s --arg mode "$mode" '{mode: $mode, arms: .}' | tee "$work/verdict.json"
echo "eval-isolation-probe: result $json, receipt ${json%.json}.receipt.json, verdict $work/verdict.json, traces $work/trace-*.jsonl"
exit "$status"
