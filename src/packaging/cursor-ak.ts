/** Bun pin Cursor install and the overlay launcher both require. Same as .github/workflows/ci.yml. */
export const CURSOR_BUN_PIN = "1.3.14";

/**
 * POSIX launcher for `.cursor/bin/ak`. Cloud Agent tool shells are not login
 * shells and often have no bun on PATH. This file is executable by path: it
 * picks bun 1.3.14 from PATH if that bun is the pin, otherwise
 * `$HOME/.bun/bin/bun`, then execs the sibling `ak.js`. It never uses sudo.
 * A bun that is not the pin is not used; the launcher exits 127 and names the pin.
 */
export function cursorAkLauncher(pin: string = CURSOR_BUN_PIN): string {
  return `#!/bin/sh
pin=${pin}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$here/ak.js"
home_bun="\${HOME}/.bun/bin/bun"

is_pin() {
  [ -x "$1" ] || return 1
  ver=$("$1" --version 2>/dev/null) || return 1
  [ "$ver" = "$pin" ]
}

path_bun=$(command -v bun 2>/dev/null || true)
if [ -n "$path_bun" ] && is_pin "$path_bun"; then
  pick=$path_bun
elif is_pin "$home_bun"; then
  pick=$home_bun
else
  echo "ak: need bun $pin on PATH or at $home_bun" >&2
  exit 127
fi

exec "$pick" "$script" "$@"
`;
}
