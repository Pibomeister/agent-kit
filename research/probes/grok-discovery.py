"""Validate, install and inspect a bundle without starting a model session."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    root = Path(__file__).resolve().parents[2]
    bundle = Path(sys.argv[1]).resolve()
    evidence = Path(sys.argv[2]).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    bundle_files = {str(path.relative_to(bundle)): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in sorted(bundle.rglob("*")) if path.is_file()}
    commands = []
    work = root / ".work"
    work.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="grok-discovery-", dir=work) as temporary:
        scratch = Path(temporary)
        home = scratch / "home"
        grok_home = scratch / "grok-home"
        home.mkdir()
        grok_home.mkdir()
        env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG") if key in os.environ}
        env.update(HOME=str(home), GROK_HOME=str(grok_home), GROK_DISABLE_AUTOUPDATER="1", GROK_MEMORY="0")
        for vendor in ("CLAUDE", "CURSOR"):
            for cell in ("SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS"):
                env[f"GROK_{vendor}_{cell}_ENABLED"] = "false"

        def run(label, args):
            result = subprocess.run(["grok", *args], cwd=home, env=env, capture_output=True, text=True, timeout=60)
            (evidence / f"{label}.stdout").write_text(result.stdout)
            (evidence / f"{label}.stderr").write_text(result.stderr)
            commands.append({"argv": ["grok", *args], "exitCode": result.returncode,
                             "stdoutSha256": hashlib.sha256(result.stdout.encode()).hexdigest()})
            print(f"{label}: exit {result.returncode}")
            result.check_returncode()
            return result.stdout

        version = run("version", ["--version"]).strip()
        run("validate", ["plugin", "validate", str(bundle)])
        run("install", ["plugin", "install", str(bundle), "--trust"])
        inspected = json.loads(run("inspect", ["inspect", "--json"]))
        plugins = [plugin for plugin in inspected["plugins"] if plugin["name"] == "ak" and plugin["enabled"]]
        if len(plugins) != 1:
            raise RuntimeError("expected exactly one enabled ak installation")
        installed = Path(plugins[0]["path"]).resolve()
        if not installed.is_relative_to(grok_home):
            raise RuntimeError("installation escaped the isolated home")
        skills = [skill for skill in inspected["skills"] if Path(skill["source"]["path"]).resolve().is_relative_to(installed)]
        expected = sorted(path.parent.name for path in (bundle / "skills").glob("*/SKILL.md"))
        if not expected or sorted(skill["name"] for skill in skills) != expected:
            raise RuntimeError("registered skill set differs from the bundle")
        if not all(skill["userInvocable"] is True for skill in skills):
            raise RuntimeError("a packaged skill is hidden")
        selected = []
        for name in ("super-align", "super-scout"):
            skill = next(skill for skill in skills if skill["name"] == name)
            selected.append({
                "name": skill["name"],
                "description": skill["description"],
                "source": {"type": skill["source"]["type"], "plugin_name": skill["source"]["plugin_name"]},
                "userInvocable": skill["userInvocable"],
            })
        fixture = {
            "version": version,
            "skillCount": len(skills),
            "skills": selected,
            "limits": "Normalized inspect registration only; no expanded human turn or model behavior observed.",
        }
        (evidence / "discovery.json").write_text(json.dumps(fixture, indent=2) + "\n")
        (evidence / "receipt.json").write_text(json.dumps({
            "sourceRevision": revision, "bundleFiles": bundle_files, "commands": commands,
            "instrument": "Working-tree bundle; content digests identify the exact installed artifact.",
        }, indent=2) + "\n")


if __name__ == "__main__":
    main()
