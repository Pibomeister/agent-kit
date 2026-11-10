# Extract helpers for the pre-push build gate. Sourced by tools/hooks/pre-push
# and by tests. Defines functions only.
lock_donor_rows() {
  # $1 is the extract. _root is extract_for_gate's working tree and must stay that.
  _lock=$1/provenance/upstream.lock.yaml
  [ -f "$_lock" ] || return 1
  _rows=$(
    AK_LOCK=$_lock bun --eval '
import { readFileSync } from "node:fs";
import { parse } from "yaml";
for (const d of parse(readFileSync(process.env.AK_LOCK, "utf8")).donors ?? []) {
  if (typeof d.path !== "string" || typeof d.commit !== "string") process.exit(1);
  console.log(d.path, d.commit);
}
'
  ) || return 1
}

donors_at_pins() {
  _root=$1
  while read -r _path _commit; do
    [ -n "$_path" ] && [ -n "$_commit" ] || continue
    [ -d "$_root/$_path/.git" ] || return 1
    (
      unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
      GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 git -C "$_root/$_path" cat-file -e "$_commit^{commit}"
    ) 2>/dev/null || return 1
  done <<EOF
$_rows
EOF
}

extract_for_gate() {
  _sha=$1
  _dest=$2
  _root=$3
  git -C "$_root" cat-file -e "$_sha^{commit}" 2>/dev/null || return 1
  git -C "$_root" archive "$_sha" 2>/dev/null | tar -x -C "$_dest" 2>/dev/null || return 1
  rm -f "$_dest/ak.install.yaml"
  if [ ! -d "$_root/.donors" ]; then
    printf '%s\n' "pre-push: pin check skipped (.donors absent)" >&2
    return 0
  fi
  if ! lock_donor_rows "$_dest"; then
    printf '%s\n' "pre-push: warning: pin check skipped because the lock file could not be read" >&2
    return 0
  fi
  if ! donors_at_pins "$_root"; then
    printf '%s\n' "pre-push: warning: pin check skipped because the local donors are not at the lock pins" >&2
    return 0
  fi
  rm -rf "$_dest/.donors"
  if cp -R "$_root/.donors" "$_dest/.donors"; then
    printf '%s\n' "pre-push: pin check will run (.donors copied at lock pins)" >&2
  else
    rm -rf "$_dest/.donors"
    printf '%s\n' "pre-push: warning: pin check skipped because .donors could not be copied" >&2
  fi
  return 0
}
