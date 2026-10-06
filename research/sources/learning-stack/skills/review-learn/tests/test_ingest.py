import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import ingest  # noqa: E402

# Literal shapes copied from `gh api repos/.../pulls/1885/comments` on 2026-09-17, with the
# repository and logins replaced by fictional stand-ins.
GREPTILE = {
    "id": 4031224434, "in_reply_to_id": None, "path": "packages/api/src/services/appointments/postOutcomeHooks.ts",
    "line": None, "original_line": 262, "created_at": "2026-09-16T22:10:00Z",
    "user": {"login": "greptile-apps[bot]"},
    "html_url": "https://github.com/example-org/sample_frontend/pull/1885#discussion_r4031224434",
    "body": '<a href="#"><img alt="P1" src="https://greptile-static-assets.s3.amazonaws.com/badges/p1.svg?v=9" align="top"></a> **Escalation Can Overwrite Settlement**\n\nThe fail-safe checks `stillOpen`',
}
REPLY = {
    "id": 4031244764, "in_reply_to_id": 4031224434, "path": GREPTILE["path"], "line": None, "original_line": 262,
    "created_at": "2026-09-16T23:00:00Z", "user": {"login": "example-reviewer"},
    "html_url": "https://github.com/example-org/sample_frontend/pull/1885#discussion_r4031244764",
    "body": "Fixed in a8e01de9e",
}


class IngestTest(unittest.TestCase):
    def test_greptile_badge_severity_author_and_stable_hash(self):
        e = ingest.github_comment_event(GREPTILE, {GREPTILE["id"]: GREPTILE}, 1885, "122fc42b", "example-author", "sample_frontend")
        self.assertEqual(e["severity"], "P1")
        self.assertEqual(e["author"], "greptile-apps[bot]")
        self.assertEqual((e["source"], e["kind"]), ("github", "finding"))
        self.assertEqual(e["line"], 262)
        self.assertTrue(e["text"].startswith("**Escalation Can Overwrite Settlement**"))
        self.assertEqual(e["hash"], "1b1bdcede55a01d2")

    def test_reply_by_pr_author_is_resolution_linked_to_parent(self):
        e = ingest.github_comment_event(REPLY, {GREPTILE["id"]: GREPTILE}, 1885, "122fc42b", "example-reviewer", "sample_frontend")
        self.assertEqual((e["source"], e["kind"]), ("author-reply", "resolution"))
        self.assertEqual(e["in_reply_to"], "1b1bdcede55a01d2")
        self.assertIsNone(e["severity"])

    def test_reply_by_third_party_is_github_reply(self):
        e = ingest.github_comment_event(REPLY, {}, 1885, "x", "example-author", "sample_frontend")
        self.assertEqual(e["source"], "github-reply")

    def test_severity_text_fallback_and_none(self):
        self.assertEqual(ingest.parse_severity("P2: unguarded read"), "P2")
        self.assertIsNone(ingest.parse_severity("looks good"))


if __name__ == "__main__":
    unittest.main()
