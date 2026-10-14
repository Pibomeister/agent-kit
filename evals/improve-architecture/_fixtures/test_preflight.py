"""Regression controls for source identity, not skill behavioral acceptance."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from preflight import git, source_identity


FIXTURES = Path(__file__).resolve().parent


class ReconstructionTests(unittest.TestCase):
    def run_preflight(self, directory, script=FIXTURES / "preflight.py", matrix=None, environment=None):
        command = [sys.executable, str(script), "--evidence-directory", str(directory)]
        if matrix is not None:
            command.extend(["--matrix", str(matrix)])
        result = subprocess.run(command, capture_output=True, text=True, env=environment)
        receipt = json.loads((directory / "preflight.json").read_text())
        return result, receipt

    def test_final_scaffolds_reproduce_all_sixteen_pins(self):
        with tempfile.TemporaryDirectory(prefix="architecture-preflight-") as temporary:
            result, receipt = self.run_preflight(Path(temporary) / "evidence")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(receipt["receipts"]), 16)
            self.assertTrue(receipt["passed"])

    def test_isolated_eval_directory_reproduces_all_sixteen_pins(self):
        with tempfile.TemporaryDirectory(prefix="architecture-preflight-") as temporary:
            root = Path(temporary)
            replica = root / "evals/improve-architecture"
            shutil.copytree(FIXTURES.parent, replica)
            result, receipt = self.run_preflight(root / "evidence", replica / "_fixtures/preflight.py")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(receipt["receipts"]), 16)
            self.assertTrue(receipt["passed"])

    def test_inherited_repository_pointers_do_not_redirect_identity_reads(self):
        with tempfile.TemporaryDirectory(prefix="architecture-preflight-") as temporary:
            root = Path(temporary)
            nonexistent = str(root / "nonexistent")
            environment = dict(os.environ, GIT_DIR=nonexistent, GIT_WORK_TREE=nonexistent,
                               GIT_INDEX_FILE=nonexistent, GIT_OBJECT_DIRECTORY=nonexistent,
                               GIT_ALTERNATE_OBJECT_DIRECTORIES=nonexistent)
            result, receipt = self.run_preflight(root / "evidence", environment=environment)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(receipt["receipts"]), 16)
            self.assertTrue(receipt["passed"])

    def test_stale_revision_tree_and_content_pins_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="architecture-preflight-") as temporary:
            root = Path(temporary)
            matrix = json.loads((FIXTURES / "matrix.json").read_text())
            for case, key in zip(matrix["cases"],
                                 ("source_revision", "source_tree", "source_content_hash")):
                case[key] = "deliberately stale identity"
            altered = root / "matrix.json"
            altered.write_text(json.dumps(matrix))
            result, receipt = self.run_preflight(root / "evidence", matrix=altered)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertFalse(receipt["passed"])
            self.assertEqual([item["id"] for item in receipt["receipts"] if not item["matched"]],
                             ["M-1", "M-2", "M-3"])

    def test_missing_external_config_pointer_does_not_break_scaffolds(self):
        with tempfile.TemporaryDirectory(prefix="architecture-preflight-") as temporary:
            root = Path(temporary)
            target = root / "missing-parent/config"
            environment = dict(os.environ, GIT_CONFIG=str(target))
            result, receipt = self.run_preflight(root / "evidence", environment=environment)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(receipt["receipts"]), 16)
            self.assertTrue(receipt["passed"])
            self.assertFalse(target.parent.exists())

    def test_existing_external_config_sentinel_is_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="architecture-preflight-") as temporary:
            root = Path(temporary)
            target = root / "caller-config"
            sentinel = b"[caller]\n sentinel = keep\n"
            target.write_bytes(sentinel)
            original_mode = target.stat().st_mode
            environment = dict(os.environ, GIT_CONFIG=str(target))
            result, receipt = self.run_preflight(root / "evidence", environment=environment)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(receipt["receipts"]), 16)
            self.assertTrue(receipt["passed"])
            self.assertEqual(target.read_bytes(), sentinel)
            self.assertEqual(target.stat().st_mode, original_mode)

    def test_direct_scaffolds_isolate_external_config_pointers(self):
        cases = json.loads((FIXTURES / "matrix.json").read_text())["cases"]
        for case in cases:
            for existing in (False, True):
                with self.subTest(case=case["id"], existing=existing), \
                        tempfile.TemporaryDirectory(prefix="architecture-scaffold-") as temporary:
                    root = Path(temporary)
                    workspace = root / "workspace"
                    workspace.mkdir()
                    target = root / "caller/config"
                    sentinel = b"[caller]\n sentinel = keep\n"
                    if existing:
                        target.parent.mkdir()
                        target.write_bytes(sentinel)
                        original_mode = target.stat().st_mode
                    environment = dict(os.environ, GIT_CONFIG=str(target))
                    result = subprocess.run(
                        ["bash", str(FIXTURES.parent / case["case"] / "scaffold.sh")],
                        cwd=workspace, capture_output=True, text=True, env=environment)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    if existing:
                        self.assertEqual(target.read_bytes(), sentinel)
                        self.assertEqual(target.stat().st_mode, original_mode)
                    else:
                        self.assertFalse(target.parent.exists())
                    identity, _ = source_identity(workspace)
                    self.assertEqual(identity, {key: case[key] for key in identity})
                    for key, value in (("user.email", "eval-fixture@agent-kit.local"),
                                       ("user.name", "agent-kit eval fixture"),
                                       ("commit.gpgsign", "false"),
                                       ("core.hooksPath", "/dev/null")):
                        self.assertEqual(git(workspace, "config", "--local", "--get", key).decode().strip(),
                                         value)

    def test_changed_source_is_rejected_without_repinning(self):
        with tempfile.TemporaryDirectory(prefix="architecture-preflight-") as temporary:
            root = Path(temporary)
            replica = root / "source/evals/improve-architecture"
            shutil.copytree(FIXTURES.parent, replica)
            source = replica / "_fixtures/repos/local/README.md"
            source.write_text(source.read_text() + "\nRegression control mutation.\n")
            result, receipt = self.run_preflight(root / "evidence", replica / "_fixtures/preflight.py")
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertFalse(receipt["passed"])
            self.assertEqual([item["id"] for item in receipt["receipts"] if item["matched"]], ["M-9"])


if __name__ == "__main__":
    unittest.main()
