# Shared helpers for the case-local scaffold.sh scripts that build on the
# fixtures in this directory. Sourced, never run directly:
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/../../super-build/_fixtures/scaffold-lib.sh"
#
# Every helper acts on the current directory, which the eval runner sets to
# the run's throwaway workspace. Nothing here touches the network, installs a
# package or calls `gh`.
#
# Commits carry a fixed identity and fixed dates, so the same scaffold yields
# the same commit SHAs on every machine and a figure quoted from one run can
# be re-derived from another.

FIXTURES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DATE="${FIXTURE_DATE:-2026-09-14T09:00:00+00:00}"

scaffold_die() {
  echo "scaffold: $*" >&2
  exit 1
}

# fixture_copy <name>: copy one fixture's contents into the workspace.
fixture_copy() {
  local src="$FIXTURES_DIR/$1"
  [[ -d "$src" ]] || scaffold_die "fixture directory not found at $src"
  cp -R "$src"/. .
}

# repo_init: an empty repository on main with the fixture identity.
repo_init() {
  git init -q -b main .
  git config user.email "eval-fixture@agent-kit.local"
  git config user.name "agent-kit eval fixture"
  git config commit.gpgsign false
}

# commit_all <message> [date]: stage everything and commit at a fixed date.
commit_all() {
  local date="${2:-$FIXTURE_DATE}"
  git add -A
  GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" git commit -q --no-verify -m "$1"
}

# head_sha: the full SHA of HEAD, for records that bind to the current head.
head_sha() {
  git rev-parse HEAD
}

# file_sha256 <path>: hex SHA-256 of one file.
file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

# lifecycle_gate <args>...: run the lifecycle gate the super-* skills record
# and check -- bin/ak-gate.mjs in a built bundle, src/lifecycle/gate.ts in a
# source checkout (node strips its types). Both sit three directories above
# this file's directory.
lifecycle_gate() {
  local root
  root="$(cd "$FIXTURES_DIR/../../.." && pwd)"
  if [[ -f "$root/bin/ak-gate.mjs" ]]; then
    node "$root/bin/ak-gate.mjs" "$@"
  elif [[ -f "$root/src/lifecycle/gate.ts" ]]; then
    node "$root/src/lifecycle/gate.ts" "$@"
  else
    scaffold_die "lifecycle gate not found under $root"
  fi
}

# receipt <file> <ac-id> <ticket> <pattern>: run one ticket verification
# command now, at HEAD, and write what happened as a receipt. The command is
# the ticket's own; the exit status and output digest are whatever it gave.
receipt() {
  local file="$1" ac="$2" ticket="$3" pattern="$4" out status
  out="$(mktemp)"
  set +e
  npm run -s check -- "--test-name-pattern=$pattern" >"$out" 2>&1
  status=$?
  set -e
  cat >"$file" <<JSON
{
  "kind": "command",
  "command": { "argv": ["npm", "run", "check", "--", "--test-name-pattern=$pattern"], "cwd": "." },
  "exit_status": $status,
  "output_digest": "sha256:$(file_sha256 "$out")",
  "source_revision": { "revision": "$(head_sha)" },
  "environment": { "runtime": "node $(node --version)", "os": "$(uname -s | tr '[:upper:]' '[:lower:]')", "credentials": "none" },
  "ticket": "$ticket",
  "supports": ["$ac"]
}
JSON
  rm -f "$out"
}

# tickets_copy <id>...: copy ticket exports from tiny-service-tickets into
# the workspace's tickets/ directory.
tickets_copy() {
  mkdir -p tickets
  local id
  for id in "$@"; do
    [[ -f "$FIXTURES_DIR/tiny-service-tickets/$id.md" ]] || scaffold_die "no ticket export $id"
    cp "$FIXTURES_DIR/tiny-service-tickets/$id.md" "tickets/$id.md"
  done
}

# service_repo_baseline <message>: the tiny-service-repo fixture, committed
# as the first commit on main. Callers that need case-specific file contents
# in the baseline overwrite them between fixture_copy and commit_all instead.
service_repo_baseline() {
  fixture_copy tiny-service-repo
  repo_init
  commit_all "${1:-baseline: tiny-service}"
}

# line_of <file> <text>: the line number of the first line containing text.
line_of() {
  local n
  n="$(grep -nF -- "$2" "$1" | head -1 | cut -d: -f1)"
  [[ -n "$n" ]] || scaffold_die "'$2' not found in $1"
  echo "$n"
}

# pr812_branch [date]: branch AK-812-org-cache off the current HEAD with the
# pr-812-org-cache overlay committed as the pull request's first commit.
pr812_branch() {
  git checkout -q -b AK-812-org-cache
  fixture_copy pr-812-org-cache
  commit_all "AK-812: cache organisation lookups in resolveTenant" "${1:-2026-09-21T10:00:00+00:00}"
}

# pr812_pull <dir> <head-sha>: the pull request record for PR 812, as the
# code host's API returns it, written to <dir>/pull.json.
pr812_pull() {
  mkdir -p "$1"
  cat >"$1/pull.json" <<JSON
{
  "number": 812,
  "title": "AK-812: cache organisation lookups in resolveTenant",
  "state": "open",
  "draft": false,
  "author": { "login": "priya-n" },
  "base": { "ref": "main", "sha": "$(git rev-parse main)" },
  "head": { "ref": "AK-812-org-cache", "sha": "$2" },
  "body": "resolveTenant hits the organisations table on every request. This adds a process-wide cache in front of it (60s TTL, bounded) and keeps the 401/403 behaviour unchanged.",
  "files": $(git diff --name-only main.."$2" | sed 's/.*/"&"/' | paste -sd, - | sed 's/^/[/;s/$/]/')
}
JSON
}
