#!/usr/bin/env python3
"""Capture fixture state outside the consuming project; this is no survey evaluator."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

repository = Path(sys.argv[1]).resolve(strict=True)
output = Path(sys.argv[2]).resolve()
if output == repository or repository in output.parents:
    raise SystemExit("state evidence must be outside the consuming project")

entries = []
for directory, directories, files in os.walk(repository, followlinks=False):
    for name in sorted(directories + files):
        path = Path(directory) / name
        relative = path.relative_to(repository).as_posix()
        if path.is_symlink():
            entry = {"path": relative, "kind": "symlink", "target": os.readlink(path)}
        elif path.is_dir():
            entry = {"path": relative, "kind": "directory"}
        elif stat.S_ISREG(path.lstat().st_mode):
            entry = {"path": relative, "kind": "file",
                     "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        else:
            entry = {"path": relative, "kind": "special",
                     "type": stat.S_IFMT(path.lstat().st_mode)}
        entry["mode"] = path.lstat().st_mode & 0o777
        entries.append(entry)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(sorted(entries, key=lambda item: item["path"]),
                             sort_keys=True, separators=(",", ":")) + "\n")
