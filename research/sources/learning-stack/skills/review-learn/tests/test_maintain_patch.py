import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import common  # noqa: E402
import maintain  # noqa: E402

PAGE = """---
id: rp-001
title: Vacuous assertion
status: candidate
count: 1
sources: [github]
prs: [1873]
promoted_to: 
---

## Problem
Test asserts a value computed the same way as the implementation.

## Fix
Take expected values from a spec literal or fixture.

## Evidence
- https://example/a (greptile P2 pr 1873)
"""


class PatchTest(unittest.TestCase):
    def test_parse_and_render_roundtrip(self):
        meta, body = common.parse_page(PAGE)
        self.assertEqual(meta["count"], 1)
        self.assertEqual(meta["prs"], ["1873"])
        self.assertEqual(meta["promoted_to"], "")
        self.assertEqual(common.render_page(meta, body), PAGE)

    def test_append_replace_insert_after(self):
        _, body = common.parse_page(PAGE)
        b = common.patch_body(body, "append", None, "- https://example/b (example-reviewer pr 1874)")
        self.assertTrue(b.endswith("- https://example/a (greptile P2 pr 1873)\n- https://example/b (example-reviewer pr 1874)\n"))
        b = common.patch_body(b, "replace", "Take expected values from a spec literal or fixture.",
                              "Take expected values from a spec literal, fixture, or user example.")
        self.assertIn("## Fix\nTake expected values from a spec literal, fixture, or user example.\n", b)
        b = common.patch_body(b, "insert_after", "## Problem", "Also covers identity asserts.")
        self.assertIn("## Problem\nAlso covers identity asserts.\nTest asserts", b)
        with self.assertRaises(ValueError):
            common.patch_body(b, "replace", "not present", "x")

    def test_add_evidence_activates_on_second_distinct_pr(self):
        meta, body = common.parse_page(PAGE)
        event = {"source": "github", "pr": 1874, "author": "example-reviewer", "ts": "2026-09-16T10:00:00Z",
                 "url": "https://example/b", "hash": "h2", "severity": "P2"}
        meta, body = maintain.add_evidence(meta, body, event)
        self.assertEqual(meta["count"], 2)
        self.assertEqual(meta["status"], "active")
        self.assertEqual(meta["last_seen"], "2026-09-16")
        self.assertEqual(meta["prs"], ["1873", "1874"])
        self.assertIn("- https://example/b (example-reviewer P2 pr 1874 2026-09-16)", body)

    def test_same_pr_same_source_stays_candidate(self):
        meta, body = common.parse_page(PAGE)
        event = {"source": "github", "pr": 1873, "author": "x", "ts": "2026-09-16", "url": "https://example/c", "hash": "h3"}
        meta, _ = maintain.add_evidence(meta, body, event)
        self.assertEqual((meta["count"], meta["status"]), (2, "candidate"))


if __name__ == "__main__":
    unittest.main()
