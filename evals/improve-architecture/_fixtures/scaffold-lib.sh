#!/usr/bin/env bash
# Source from the case-local scaffold; prepare only the evaluator's disposable workspace.
ARCHITECTURE_FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ARCHITECTURE_FIXTURES/../../super-build/_fixtures/scaffold-lib.sh"

architecture_scaffold() {
  local overlay
  if (shopt -s dotglob nullglob; task_entries=(*); ((${#task_entries[@]} > 0))); then
    scaffold_die "workspace must be empty"
  fi
  # Ignore operator Git configuration/templates and checkout conversions.
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  unset GIT_CONFIG_PARAMETERS GIT_DEFAULT_HASH GIT_DEFAULT_REF_FORMAT
  export GIT_CONFIG_COUNT=0 GIT_TEMPLATE_DIR=
  export GIT_AUTHOR_NAME="agent-kit eval fixture" GIT_AUTHOR_EMAIL="eval-fixture@agent-kit.local"
  export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
  repo_init
  git config core.hooksPath /dev/null
  cp -R "$ARCHITECTURE_FIXTURES/repos/local/." .
  for overlay in "$@"; do
    [[ -d "$ARCHITECTURE_FIXTURES/overlays/$overlay" ]] || scaffold_die "unknown source variant"
    if [[ "$overlay" == "non-js" ]]; then
      rm -rf src test
    fi
    cp -R "$ARCHITECTURE_FIXTURES/overlays/$overlay/." .
  done
  commit_all "Keep the order fixture reconstructible for architecture trials

Constraint: The evaluator supplies tooling and knowledgebase facilities separately
Tested: Source fixture preparation only; no survey trial is asserted" "2026-10-12T06:00:00+00:00"
  echo "scaffold source_revision=$(head_sha) tree=$(git rev-parse HEAD^{tree})"
}
