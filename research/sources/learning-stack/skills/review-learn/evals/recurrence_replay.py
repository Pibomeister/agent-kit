#!/usr/bin/env python3
"""Replay the recurrence metric on a scratch ledger: PRs 1873+1874 first, then 1882+1885. One reviewer raised the same
classes across these, so the second run's repeat rate must be > 0. GitHub-only (no claude-mem) for isolation.
    cd sample_frontend && python3 ~/.claude/skills/review-learn/evals/recurrence_replay.py"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

S = Path(__file__).resolve().parent.parent / "scripts"


def run(*args, env):
    r = subprocess.run([sys.executable, *args], capture_output=True, text=True, env=env)
    print(r.stdout.strip() or r.stderr.strip()[-400:])
    return r


def main():
    with tempfile.TemporaryDirectory() as d:
        env = {**os.environ, "REVIEW_LEARN_LEDGER": str(Path(d) / "ledger")}
        for prs in (["1873", "1874"], ["1882", "1885"]):
            run(S / "ingest.py", "--no-mem", *sum((["--pr", p] for p in prs), []), env=env)
            run(S / "maintain.py", env=env)
        rows = [ln for ln in (Path(d) / "ledger" / "index.md").read_text().splitlines() if ln.startswith("| 20")]
        print("\n".join(rows))
        second = rows[1].split("|") if len(rows) > 1 else []
        repeats = int(second[4]) if second else -1
        print("PASS: second run recorded repeats" if repeats > 0 else "FAIL: second run recorded 0 repeats")
        sys.exit(0 if repeats > 0 else 1)


if __name__ == "__main__":
    main()
