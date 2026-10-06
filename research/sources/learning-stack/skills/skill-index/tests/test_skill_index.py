import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import skill_index as SI  # noqa: E402

FOLDED = """---
name: lead-review
description: >-
  Review a pushed PR using lead-calibrated severity.
  Use for “lead review” or “would the lead approve”.
allowed-tools: Read
---
# body
"""
QUOTED = """---
name: kill-slop
description: "Stop AI coding agents from shipping sloppy code. Use when the user mentions slop."
---
"""


class FrontmatterTest(unittest.TestCase):
    def test_folded_multiline_description(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "SKILL.md"; p.write_text(FOLDED)
            fm = SI.frontmatter(p)
        self.assertEqual(fm["name"], "lead-review")
        self.assertEqual(fm["description"], "Review a pushed PR using lead-calibrated severity. Use for “lead review” or “would the lead approve”.")
        self.assertEqual(fm["allowed-tools"], "Read")

    def test_build_index_groups_candidates_and_counts(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "kill-slop").mkdir(); (root / "kill-slop" / "SKILL.md").write_text(QUOTED)
            (root / "candidates" / "auto-thing").mkdir(parents=True)
            (root / "candidates" / "auto-thing" / "SKILL.md").write_text("---\nname: auto-thing\ndescription: Does X. Use when Y.\n---\n")
            n = SI.build_index(root, "test")
            idx = (root / "INDEX.md").read_text()
        self.assertEqual(n, 2)
        self.assertIn("## skills\n\n- **kill-slop** — Stop AI coding agents from shipping sloppy code. Use when the user mentions slop.", idx)
        self.assertIn("## candidates\n\n- **auto-thing** — Does X. Use when Y.", idx)
        self.assertIn("candidates/auto-thing/SKILL.md`", idx)

    def test_roster_uses_dir_names_and_clips(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "deslop-voice").mkdir(); (root / "deslop-voice" / "SKILL.md").write_text("---\nname: deslop\ndescription: Strips assistant-voice padding out of responses - no preamble, no restating the question, no hedging.\n---\n")
            (root / "candidates" / "auto-thing").mkdir(parents=True); (root / "candidates" / "auto-thing" / "SKILL.md").write_text("---\nname: auto-thing\ndescription: Does X.\n---\n")
            with mock.patch.object(SI, "levels", lambda cwd=None: [("global", root / "none", root)]):
                text = SI.roster(width=40)
        lines = text.splitlines()
        self.assertTrue(lines[0].startswith("skill-index (global, not installed;"))
        self.assertEqual(lines[1], "- auto-thing [candidate]: Does X.")
        self.assertEqual(lines[2], "- deslop-voice: Strips assistant-voice padding out of re")


if __name__ == "__main__":
    unittest.main()
