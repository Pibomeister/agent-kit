#!/usr/bin/env python3
"""Rebuild every source fixture and reject stale pins before operator setup/trials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def git_environment():
    # Resolve only the prepared cwd repository, not the caller's Git context.
    environment = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
                 "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                 "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_DEFAULT_HASH", "GIT_DEFAULT_REF_FORMAT"):
        environment.pop(name, None)
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                       GIT_CONFIG_COUNT="0", GIT_ATTR_NOSYSTEM="1")
    return environment


def git(repository, *arguments):
    return subprocess.check_output(["git", *arguments], cwd=repository, env=git_environment())


def source_identity(repository):
    # Raw worktree bytes, tracked paths and Git modes; no .git/operator state.
    entries = []
    for record in git(repository, "ls-files", "--stage", "-z").split(b"\0"):
        if not record:
            continue
        metadata, path_bytes = record.split(b"\t", 1)
        mode, _, stage = metadata.decode("ascii").split()
        if stage != "0" or mode not in ("100644", "100755", "120000"):
            raise ValueError("fixture has an unsupported or unresolved index entry")
        path = path_bytes.decode("utf-8")
        target = repository / path
        content = os.fsencode(os.readlink(target)) if mode == "120000" else target.read_bytes()
        entries.append({"path": path, "mode": mode,
                        "sha256": hashlib.sha256(content).hexdigest()})
    canonical = (json.dumps(sorted(entries, key=lambda item: item["path"]),
                            ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    return {
        "source_revision": git(repository, "rev-parse", "HEAD").decode().strip(),
        "source_tree": git(repository, "rev-parse", "HEAD^{tree}").decode().strip(),
        "source_content_hash": "sha256:" + hashlib.sha256(canonical).hexdigest(),
    }, canonical


def main():
    fixtures = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=Path, default=fixtures / "matrix.json")
    parser.add_argument("--evidence-directory", type=Path, required=True)
    args = parser.parse_args()
    evidence = args.evidence_directory.resolve()
    if evidence == fixtures.parent or fixtures.parent in evidence.parents:
        parser.error("evidence must be outside the trial assets")
    evidence.mkdir(parents=True, exist_ok=False)
    matrix_bytes = args.matrix.read_bytes()
    cases = json.loads(matrix_bytes)["cases"]
    if [case["id"] for case in cases] != [f"M-{number}" for number in range(1, 17)]:
        parser.error("matrix must contain M-1 through M-16 once, in order")
    receipts = []
    for case in cases:
        workspace = evidence / case["id"]
        workspace.mkdir()
        command = ["bash", str(fixtures.parent / case["case"] / "scaffold.sh")]
        result = subprocess.run(command, cwd=workspace, capture_output=True, env=git_environment())
        (evidence / f"{case['id']}-scaffold.log").write_bytes(result.stdout + result.stderr)
        receipt = {"id": case["id"], "command": command, "scaffold_exit": result.returncode,
                   "expected": {key: case[key] for key in
                                ("source_revision", "source_tree", "source_content_hash")}}
        if result.returncode == 0:
            actual, canonical = source_identity(workspace)
            (evidence / f"{case['id']}-source-content.json").write_bytes(canonical)
            receipt.update(actual=actual, matched=actual == receipt["expected"])
        else:
            receipt["matched"] = False
        receipts.append(receipt)
        print(f"{case['id']}: {'match' if receipt['matched'] else 'MISMATCH'}")
    passed = all(receipt["matched"] for receipt in receipts)
    (evidence / "preflight.json").write_text(json.dumps({
        "kind": "source reconstruction only; not behavioral acceptance",
        "matrix_sha256": hashlib.sha256(matrix_bytes).hexdigest(),
        "passed": passed, "receipts": receipts,
    }, indent=2) + "\n")
    raise SystemExit(0 if passed else 1)


if __name__ == "__main__":
    main()
