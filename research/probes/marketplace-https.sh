#!/usr/bin/env bash
# Exercise the marketplace's Git source with SSH disabled. A local Git mirror
# replaces only the HTTPS network endpoint; Claude Code reads the real manifest.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
bun run ak build >/dev/null

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git init -q --bare "$WORK/remote.git"
git init -q "$WORK/release"
cp -R dist "$WORK/release/dist"
git -C "$WORK/release" add dist
git -C "$WORK/release" -c user.name=probe -c user.email=probe@example.invalid commit -qm publish
git -C "$WORK/release" push -q "$WORK/remote.git" HEAD:refs/heads/published

git config -f "$WORK/gitconfig" "url.file://$WORK/remote.git.insteadOf" https://github.com/Pibomeister/agent-kit.git

install_from() {
  local label="$1" url="$2"
  mkdir -p "$WORK/$label-market/.claude-plugin" "$WORK/$label-home"
  node - "$ROOT/.claude-plugin/marketplace.json" "$WORK/$label-market/.claude-plugin/marketplace.json" "$url" <<'JS'
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
manifest.plugins.find((plugin) => plugin.name === "ak").source.url = process.argv[4];
fs.writeFileSync(process.argv[3], JSON.stringify(manifest));
JS
  CLAUDE_CONFIG_DIR="$WORK/$label-home" GIT_CONFIG_GLOBAL="$WORK/gitconfig" GIT_SSH_COMMAND=false \
    claude plugin marketplace add "$WORK/$label-market" >"$WORK/$label-add.log" 2>&1
  set +e
  CLAUDE_CONFIG_DIR="$WORK/$label-home" GIT_CONFIG_GLOBAL="$WORK/gitconfig" GIT_SSH_COMMAND=false \
    claude plugin install ak@agent-kit >"$WORK/$label-install.log" 2>&1
  local rc=$?
  set -e
  printf '%s install exit=%s: ' "$label" "$rc"
  sed '/^[[:space:]]*$/d' "$WORK/$label-install.log" | tail -1
  return "$rc"
}

if install_from shorthand Pibomeister/agent-kit; then
  echo "FAIL: SSH shorthand unexpectedly installed without SSH" >&2
  exit 1
fi
install_from https https://github.com/Pibomeister/agent-kit.git
CLAUDE_CONFIG_DIR="$WORK/https-home" claude plugin list --json > "$WORK/installed.json"
node - "$WORK/installed.json" <<'JS'
const rows = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (!rows.some((row) => row.id === "ak@agent-kit" && row.enabled)) process.exit(1);
JS
echo "PASS: HTTPS source installs ak while SSH is disabled; shorthand is the negative control"
