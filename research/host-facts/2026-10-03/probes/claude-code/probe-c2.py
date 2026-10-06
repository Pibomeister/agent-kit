#!/usr/bin/env python3
"""Probe C2 -- fact 7 only: does the project-root CLAUDE.md get re-read from disk after /compact?
One claude -p process with stream-json input; each message is sent only after the previous result arrives."""
import json, os, subprocess, sys, shutil
S = os.path.dirname(os.path.abspath(__file__))
P = os.path.join(S, "C2")
shutil.rmtree(P, ignore_errors=True)
os.makedirs(os.path.join(P, "proj"), exist_ok=True); os.makedirs(os.path.join(P, "cfg"))
shutil.copy(os.path.expanduser("~/.claude/.credentials.json"), os.path.join(P, "cfg"))
proj = os.path.join(P, "proj")
subprocess.run(["git", "init", "-q", "-b", "main"], cwd=proj, check=True)
open(os.path.join(proj, "CLAUDE.md"), "w").write("Project marker: ROOT-TOKEN-alpha7.\n")
il = os.path.join(P, "il.sh")
open(il, "w").write('#!/bin/bash\njq -c \'{t: now, load_reason, memory_type, file_path}\' >> "$PROBE/il.log"\n')
os.chmod(il, 0o755)
settings = {"permissions": {"allow": ["Bash(sed *)"]},
            "hooks": {"InstructionsLoaded": [{"hooks": [{"type": "command", "command": il}]}]}}
json.dump(settings, open(os.path.join(P, "settings.json"), "w"))
env = {"HOME": os.environ["HOME"], "PATH": os.environ["PATH"], "LANG": "C.UTF-8", "TERM": "dumb",
       "PROBE": P, "CLAUDE_CONFIG_DIR": os.path.join(P, "cfg")}
cmd = ["timeout", "900", "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
       "--settings", os.path.join(P, "settings.json"), "--tools", "Bash", "--permission-mode", "manual",
       "--permission-prompts", "none", "--debug-file", os.path.join(P, "debug.log"), "--max-budget-usd", "5"]
proc = subprocess.Popen(cmd, cwd=proj, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
out = open(os.path.join(P, "stream.jsonl"), "w")
msgs = ["Run exactly one Bash command and nothing else: sed -i s/alpha7/omega4/ CLAUDE.md . Then reply DONE.",
        "/compact",
        "Without using any tools, quote every token in your loaded project instructions that matches ROOT-TOKEN-*."]
def wait_result():
    for line in proc.stdout:
        out.write(line); out.flush()
        try: ev = json.loads(line)
        except ValueError: continue
        if ev.get("type") == "result": return ev
    return None
for m in msgs:
    proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": m}}) + "\n"); proc.stdin.flush()
    r = wait_result()
    print("SENT", m[:40], "->", None if r is None else {k: r.get(k) for k in ("subtype", "is_error", "num_turns")})
    if r is None: break
proc.stdin.close(); proc.wait(timeout=120)
print("exit", proc.returncode)
