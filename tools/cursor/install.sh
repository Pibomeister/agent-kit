#!/usr/bin/env bash
# Cloud Agent install: pin Bun to the version CI uses, then frozen-lockfile deps.
# Same pin as .github/workflows/ci.yml oven-sh/setup-bun bun-version.
set -euo pipefail
PIN=1.3.14
export PATH="/usr/local/bin:${HOME}/.bun/bin:${PATH}"

if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "$PIN" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${PIN}"
fi

if [ -x "${HOME}/.bun/bin/bun" ]; then
  sudo ln -sf "${HOME}/.bun/bin/bun" /usr/local/bin/bun
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not on PATH after install" >&2
  exit 1
fi

if [ "$(bun --version)" != "$PIN" ]; then
  echo "bun $(bun --version) is not the pinned ${PIN}" >&2
  exit 1
fi

bun install --frozen-lockfile
