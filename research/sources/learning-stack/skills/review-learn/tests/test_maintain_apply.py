"""Bookkeeping the model must not be able to inflate: counts, statuses, repeat/new, processed map, evidence-once."""
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import common as C  # noqa: E402
import maintain as M  # noqa: E402

EXISTING = """---
id: rp-001
title: Vacuous assertion
status: candidate
count: 1
first_seen: 2026-09-01
last_seen: 2026-09-01
sources: [github]
prs: [1800]
reviewers: [greptile-apps[bot]]
promoted_to: 
team_target: 
---

## Problem
Assertion cannot fail.

## Root cause
Expected computed like the implementation.

## Fix
Take expected values from a spec literal.

## Evidence
- https://x/old (greptile-apps[bot] P2 pr 1800 2026-09-01)
"""
E1 = {"hash": "h1", "source": "github", "kind": "finding", "pr": 1873, "author": "example-reviewer", "severity": None, "ts": "2026-09-10T00:00:00Z", "url": "https://x/1", "text": "toBeNull on a value that is always null"}
E2 = {"hash": "h2", "source": "github", "kind": "finding", "pr": 1873, "author": "greptile-apps[bot]", "severity": "P2", "ts": "2026-09-10T00:00:00Z", "url": "https://x/2", "text": "teardown leaves org rows"}
E3 = {"hash": "h3", "source": "author-reply", "kind": "resolution", "pr": 1873, "author": "example-author", "severity": None, "ts": "2026-09-10T00:00:00Z", "url": "https://x/3", "text": "fixed in abc", "in_reply_to": "h2"}
E4 = {"hash": "h4", "source": "github", "kind": "finding", "pr": 1873, "author": "example-reviewer", "severity": None, "ts": "2026-09-10T00:00:00Z", "url": "https://x/4", "text": "unrelated nit the model ignores"}
RESP = {
    "create_patterns": [{"tmp_id": "new-1", "title": "Teardown leaks fixtures", "problem": "Teardown removes some rows, leaves others.", "root_cause": "No dependency-ordered cleanup.", "fix": "Delete every created record leaf-first.", "team_target": None, "event_hashes": ["h2"]},
                        {"tmp_id": "new-2", "title": "incomplete", "problem": "", "root_cause": "x", "fix": "y", "event_hashes": ["h4"]}],
    "update_patterns": [{"id": "rp-001", "op": "insert_after", "target": "## Problem", "text": "Also identity asserts."},
                        {"id": "rp-001", "op": "replace", "target": "text that is not there", "text": "ignored"}],
    "event_matches": [{"hash": "h1", "pattern_ids": ["rp-001"]}, {"hash": "h2", "pattern_ids": ["new-1"]}, {"hash": "h3", "pattern_ids": []}, {"hash": "h4", "pattern_ids": ["rp-999"]}],
    "append_log": "one repeat, one new",
}


class ApplyResponseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ledger = Path(self.tmp.name)
        (self.ledger / "patterns").mkdir()
        (self.ledger / "log.md").write_text("")
        (self.ledger / "patterns" / "rp-001.md").write_text(EXISTING)
        self.patterns = C.load_patterns(self.ledger)
        self.matched, self.processed, self.new_ids = Counter(), {}, set()
        M.LOG_NOTES.clear()
        M.apply_response(self.ledger, self.patterns, [E1, E2, E3, E4], RESP, self.matched, self.processed, self.new_ids)

    def tearDown(self):
        self.tmp.cleanup()

    def test_repeat_new_total_exclude_resolutions_and_unmatched(self):
        self.assertEqual(self.matched["total"], 3)   # h1, h2, h4 are findings; h3 is a resolution
        self.assertEqual(self.matched["repeat"], 1)  # h1 matched a pre-existing pattern
        self.assertEqual(self.matched["new"], 1)     # h2 matched only a pattern created this run

    def test_existing_pattern_becomes_active_on_second_pr(self):
        meta, body, _ = self.patterns["rp-001"]
        self.assertEqual(meta["count"], 2)
        self.assertEqual(meta["status"], "active")
        self.assertEqual(meta["prs"], ["1800", "1873"])
        self.assertEqual(meta["last_seen"], "2026-09-10")
        self.assertEqual(body.count("- https://x/1 (example-reviewer pr 1873 2026-09-10)"), 1)
        self.assertIn("## Problem\nAlso identity asserts.\nAssertion cannot fail.", body)

    def test_new_pattern_gets_next_id_and_stays_candidate(self):
        self.assertEqual(self.new_ids, {"rp-002"})  # the incomplete spec (empty problem) was dropped
        meta, body, path = self.patterns["rp-002"]
        self.assertEqual((meta["status"], meta["count"], meta["prs"]), ("candidate", 1, ["1873"]))
        self.assertEqual(path.name, "rp-002.md")
        self.assertIn("- https://x/2 (greptile-apps[bot] P2 pr 1873 2026-09-10)", body)

    def test_processed_map_and_unknown_ids(self):
        self.assertEqual(self.processed, {"h1": ["rp-001"], "h2": ["rp-002"], "h3": [], "h4": []})

    def test_bad_patch_is_logged_not_fatal(self):
        self.assertIn("skipped patch on rp-001", (self.ledger / "log.md").read_text())


if __name__ == "__main__":
    unittest.main()
