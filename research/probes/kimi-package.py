#!/usr/bin/env python3
"""Install/list a Kimi bundle in isolated state, without a session or prompt."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("bundle", type=Path)
parser.add_argument("--cli", type=Path, required=True)
parser.add_argument("--scratch", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
bundle = args.bundle.resolve(strict=True)
cli = args.cli.resolve(strict=True)
scratch = args.scratch.resolve()
# A fresh directory makes isolation checkable and avoids overwriting old evidence.
scratch.mkdir(parents=True, exist_ok=False)
home = scratch / "home"
project = scratch / "project"
home.mkdir()
project.mkdir()
args.output.mkdir(parents=True, exist_ok=True)
env = {key: os.environ[key] for key in ("PATH", "LANG", "TMPDIR") if key in os.environ}
env.update(HOME=str(home), KIMI_CODE_HOME=str(home / ".kimi-code"),
           XDG_CONFIG_HOME=str(home / "config"), XDG_CACHE_HOME=str(home / "cache"),
           XDG_DATA_HOME=str(home / "data"))
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
command = [str(cli), "web", "--host", "127.0.0.1", "--port", str(port),
           "--no-open", "--dangerous-bypass-auth"]
base = f"http://127.0.0.1:{port}/api/v1"
responses = []


def request(method, path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(base + path, data=body, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as response:
        value = json.load(response)
    responses.append({"method": method, "path": path, "response": value})
    if value["code"] != 0:
        raise RuntimeError(value)
    return value["data"]


with (args.output / "server.log").open("w") as log:
    process = subprocess.Popen(command, cwd=project, env=env, stdout=log, stderr=log)
    try:
        for attempt in range(60):
            try:
                with urllib.request.urlopen(base + "/healthz", timeout=.5) as response:
                    json.load(response)
                break
            except (OSError, TimeoutError):
                if process.poll() is not None:
                    raise RuntimeError("Kimi server exited; inspect server.log")
                time.sleep(.2)
        else:
            raise RuntimeError("Kimi server did not become ready")
        installed = request("POST", "/plugins", {"source": str(bundle)})
        request("GET", "/plugins")
        workspace = request("POST", "/workspaces", {"root": str(project)})
        listed = request("GET", f'/workspaces/{workspace["id"]}/skills')["skills"]
        source_root = str(Path(installed["root"]) / "skills") + os.sep
        names = sorted(s["name"] for s in listed if s["path"].startswith(source_root))
        expected = sorted(p.parent.name for p in (bundle / "skills").glob("*/SKILL.md"))
        if installed["hasErrors"] or installed["diagnostics"] or names != expected:
            raise RuntimeError("Plugin diagnostics or skill membership mismatch")
        print(f'Installed {installed["id"]}: {len(names)} skills; no diagnostics; no session created')
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        (args.output / "responses.json").write_text(json.dumps(responses, indent=2) + "\n")
