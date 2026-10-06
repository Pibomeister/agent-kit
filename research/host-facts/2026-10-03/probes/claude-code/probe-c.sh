#!/usr/bin/env bash
# Probe C -- path-scoped rule triggers, compaction re-read of project-root CLAUDE.md, default AGENTS.md skip.
# Settles facts 3, 7 and 4a in ONE `claude -p` process (stream-json input: task turn, /compact, question turn).
# Probe B (fact 4b) reuses this project in a second, tool-less session.
# Run on 2026-10-03 against claude 2.1.288: bash probe-c.sh setup && bash probe-c.sh run && bash probe-c.sh check. The queued `/compact` did not compact before the final question, so fact 7 was settled by probe-c2.py; fact 4b by probe-b.sh, not by the runB branch below.
set -euo pipefail
P="${PROBE_ROOT:-$(cd "$(dirname "$0")" && pwd)/C}"
case "${1:-}" in
setup)
  rm -rf "$P"; mkdir -p "$P/proj/.claude/rules" "$P/proj/src/read" "$P/proj/src/bash" "$P/proj/src/write" "$P/cfg"
  [ -f "$HOME/.claude/.credentials.json" ] && cp "$HOME/.claude/.credentials.json" "$P/cfg/" || echo "no credentials file copied; export ANTHROPIC_API_KEY"
  cd "$P/proj"; git init -q -b main
  echo "Project marker: ROOT-TOKEN-alpha7." > CLAUDE.md
  echo "Agents marker: AGENTS-TOKEN-bravo3." > AGENTS.md
  printf -- '---\npaths:\n  - "src/read/**"\n---\nRule marker: READRULE-charlie5.\n'  > .claude/rules/read-scope.md
  printf -- '---\npaths:\n  - "src/write/**"\n---\nRule marker: WRITERULE-delta2.\n' > .claude/rules/write-scope.md
  printf -- '---\npaths:\n  - "src/bash/**"\n---\nRule marker: BASHRULE-echo9.\n'   > .claude/rules/bash-scope.md
  echo "export const a = 1; // x" > src/read/a.ts
  echo "export const b = 2; // x" > src/bash/b.ts
  cat > "$P/il.sh" <<'EOF'
#!/bin/bash
jq -c '{t: now, load_reason, memory_type, file_path, trigger_file_path, globs}' >> "$PROBE/il.log"
EOF
  chmod +x "$P/il.sh"
  cat > "$P/settings.json" <<EOF
{
  "permissions": { "allow": ["Bash(cat *)", "Bash(sed *)"] },
  "hooks": { "InstructionsLoaded": [{"hooks": [{"type": "command", "command": "$P/il.sh"}]}] }
}
EOF
  ;;
run)
  cd "$P/proj"
  M1='Do exactly these tool calls in order and nothing else: (1) Bash: cat src/bash/b.ts (2) Grep for the pattern x with path src/bash (3) Read src/read/a.ts (4) Write src/write/new.ts with content: export {} (5) Bash: sed -i s/alpha7/omega4/ CLAUDE.md . Then reply DONE.'
  M3='Without using any tools, list every token in your context that matches ROOT-TOKEN-*, AGENTS-TOKEN-*, or *RULE-*. For each, say whether it appears in loaded instructions/system reminders or only in the conversation summary.'
  { for m in "$M1" "/compact" "$M3"; do jq -nc --arg t "$m" '{type:"user",message:{role:"user",content:$t}}'; done; } | \
  env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8 TERM=dumb PROBE="$P" CLAUDE_CONFIG_DIR="$P/cfg" timeout 900 claude -p --input-format stream-json --output-format stream-json --verbose \
    --settings "$P/settings.json" --permission-mode acceptEdits \
    --debug-file "$P/debug.log" --max-budget-usd 5 > "$P/stream.jsonl"
  ;;
check)
  echo "== InstructionsLoaded log (expect: session_start CLAUDE.md; path_glob_match read-scope after Read; path_glob_match write-scope after Write (2.1.288); NO bash-scope; then compact CLAUDE.md)"
  cat "$P/il.log"
  echo "== final answer (expect ROOT-TOKEN-omega4 as loaded instructions; no AGENTS-TOKEN-bravo3; no BASHRULE-echo9)"
  jq -r 'select(.type=="result") | .result' "$P/stream.jsonl"
  ;;
runB)
  # Probe B: same project, CLAUDE.md present. Expect AGENTS-TOKEN-bravo3 to appear only with the setting.
  cd "$P/proj"
  Q='Without using tools, list every token in your context that matches ROOT-TOKEN-* or AGENTS-TOKEN-*.'
  env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8 TERM=dumb CLAUDE_CONFIG_DIR="$P/cfg" timeout 300 claude -p "$Q" --tools "" \
    --settings '{"pluginConfigs":{"agents-md@builtin":{"options":{"instructionFiles":"claude-md-and-agents-md"}}}}'
  ;;
*) echo "usage: $0 setup|run|check|runB" ;;
esac
