#!/usr/bin/env bash
# Probe B -- fact 4b: with Project instructions set to claude-md-and-agents-md through --settings, AGENTS.md
# loads beside CLAUDE.md. Run on 2026-10-03 against claude 2.1.288, after probe-c.sh setup/run, in its project
# (CLAUDE.md carries ROOT-TOKEN-omega4 after probe C's sed; AGENTS.md carries AGENTS-TOKEN-bravo3).
# The InstructionsLoaded logger shows which files the memory loader reported; AGENTS.md arrives through the
# built-in agents-md plugin instead, which the debug log names.
set -euo pipefail
P="${PROBE_ROOT:-$(cd "$(dirname "$0")" && pwd)/C}"
mkdir -p "$P/cfgB" && cp "$HOME/.claude/.credentials.json" "$P/cfgB/" && : > "$P/ilB.log"
printf '#!/bin/bash\njq -c '"'"'{t: now, load_reason, memory_type, file_path}'"'"' >> "$PROBE/ilB.log"\n' > "$P/ilB.sh"; chmod +x "$P/ilB.sh"
cat > "$P/settingsB.json" <<JSON
{"pluginConfigs":{"agents-md@builtin":{"options":{"instructionFiles":"claude-md-and-agents-md"}}},
 "hooks":{"InstructionsLoaded":[{"hooks":[{"type":"command","command":"$P/ilB.sh"}]}]}}
JSON
cd "$P/proj"
env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8 TERM=dumb PROBE="$P" CLAUDE_CONFIG_DIR="$P/cfgB" timeout 300 \
  claude -p 'Without using tools, list every token in your context that matches ROOT-TOKEN-* or AGENTS-TOKEN-*. One per line, nothing else.' \
  --tools "" --settings "$P/settingsB.json" --output-format json --debug-file "$P/debugB.log" < /dev/null > "$P/streamB.json"
jq -r '.result' "$P/streamB.json"; cat "$P/ilB.log"; grep -F 'cc-plugin-agents-md): AGENTS.md' "$P/debugB.log"
