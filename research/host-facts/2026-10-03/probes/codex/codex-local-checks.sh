#!/usr/bin/env bash
# Local Codex checks that call no model. Every codex process runs with a fresh HOME and CODEX_HOME.
# Needs: codex-cli 0.153.4 on PATH, python3, git; for M1-M3 also docker with an image that can run a
# static musl binary (redis:7-alpine was the one present) and CODEX_BIN pointing at the native binary.
set -euo pipefail
W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/codex-local.XXXXXX")" && pwd -P)
CODEX_BIN=${CODEX_BIN:-$(dirname "$(readlink -f "$(command -v codex)")")/../node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex}
IMAGE=${IMAGE:-redis:7-alpine}
iso() { mkdir -p "$1/home" "$1/codex-home"; }
quiet() { grep -v '^WARNING: proceeding' || true; }

echo "### L1 AGENTS.md chain and a skill hidden by allow_implicit_invocation"
R=$W/l1/repo; iso "$W/l1"
mkdir -p "$R/sub/deeper/child" "$R/sibling" "$R/.agents/skills/manual-skill/agents" "$R/.agents/skills/visible-skill"
git -C "$R" init -q
echo "Marker ROOT-AGENTS-L1." > "$R/AGENTS.md"; echo "Marker SUB-AGENTS-L1." > "$R/sub/AGENTS.md"
echo "Marker SIBLING-AGENTS-L1." > "$R/sibling/AGENTS.md"; echo "Marker BELOW-CWD-AGENTS-L1." > "$R/sub/deeper/child/AGENTS.md"
printf -- '---\nname: manual-skill\ndescription: Probe skill that must stay hidden from implicit invocation.\n---\nReply MANUAL-SKILL-TOKEN.\n' > "$R/.agents/skills/manual-skill/SKILL.md"
printf 'policy:\n  allow_implicit_invocation: false\n' > "$R/.agents/skills/manual-skill/agents/openai.yaml"
printf -- '---\nname: visible-skill\ndescription: Probe skill with default metadata.\n---\nReply VISIBLE-SKILL-TOKEN.\n' > "$R/.agents/skills/visible-skill/SKILL.md"
( cd "$R/sub/deeper" && HOME=$W/l1/home CODEX_HOME=$W/l1/codex-home codex -c 'projects."'"$R"'".trust_level="trusted"' debug prompt-input 'hello' 2>/dev/null ) > "$W/l1/prompt.json"
for m in ROOT-AGENTS-L1 SUB-AGENTS-L1 SIBLING-AGENTS-L1 BELOW-CWD-AGENTS-L1; do
  printf '%-22s %s\n' "$m" "$(grep -c "$m" "$W/l1/prompt.json" | sed 's/^0$/absent/;s/^[1-9][0-9]*$/present/')"; done
for s in manual-skill visible-skill; do
  printf '%-22s %s\n' "skill:$s" "$(grep -c "$s" "$W/l1/prompt.json" | sed 's/^0$/absent from prompt/;s/^[1-9][0-9]*$/listed in prompt/')"; done
( cd "$R/sub/deeper" && HOME=$W/l1/home CODEX_HOME=$W/l1/codex-home codex -c 'projects."'"$R"'".trust_level="trusted"' debug prompt-input '$manual-skill hello' 2>/dev/null ) > "$W/l1/prompt-explicit.json"
printf '%-22s %s\n' 'explicit $manual-skill' "SKILL.md body in debug prompt-input: $(grep -c 'MANUAL-SKILL-TOKEN' "$W/l1/prompt-explicit.json" | sed 's/^0$/no (prompt-input renders the mention as plain user text)/;s/^[1-9][0-9]*$/yes/')"

hooks_list() { # $1=root dir holding home/ codex-home/ proj/
python3 - "$1" <<'EOF'
import json,subprocess,sys,os
P=sys.argv[1]
env=dict(os.environ,HOME=P+'/home',CODEX_HOME=P+'/codex-home')
p=subprocess.Popen(['codex','app-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,text=True,cwd=P+'/proj')
def send(o): p.stdin.write(json.dumps(o)+'\n'); p.stdin.flush()
def recv(i):
    while True:
        l=p.stdout.readline()
        if not l: return None
        try: m=json.loads(l)
        except ValueError: continue
        if m.get('id')==i: return m
send({"id":0,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"0"}}}); recv(0)
send({"method":"initialized"})
send({"id":1,"method":"hooks/list","params":{"cwds":[P+'/proj']}}); r=recv(1)
p.stdin.close(); p.terminate()
for e in r['result']['data']:
    if not e.get('hooks'): print('  (no hooks listed)')
    for h in e.get('hooks',[]): print('  source=%s trust=%s managed=%s hash=%s' % (h.get('source'),h.get('trustStatus'),h.get('isManaged'),(h.get('currentHash') or '')[:19]))
EOF
}

echo "### L2 hook trust: untrusted, trusted by hash, modified, script edit"
H=$W/l2; iso "$H"; mkdir -p "$H/proj" "$H/hooks"; git -C "$H/proj" init -q
printf '#!/bin/sh\nexit 0\n' > "$H/hooks/pre.sh"
write_cfg() { printf '[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "sh %s"\ntimeout = %s\n%s' "$H/hooks/pre.sh" "$1" "${2:-}" > "$H/codex-home/config.toml"; }
write_cfg 5; echo "fresh user hook:"; hooks_list "$H" | tee "$H/a.txt"
HASH=$(grep -o 'hash=sha256:[0-9a-f]*' "$H/a.txt" | head -1 | cut -d= -f2)
KEY="$H/codex-home/config.toml:pre_tool_use:0:0"
FULL=$(HOME=$H/home CODEX_HOME=$H/codex-home python3 - "$H" <<'EOF'
import json,subprocess,sys,os
P=sys.argv[1]
p=subprocess.Popen(['codex','app-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,cwd=P+'/proj')
w=lambda o:(p.stdin.write(json.dumps(o)+'\n'),p.stdin.flush())
def r(i):
    while True:
        l=p.stdout.readline()
        try: m=json.loads(l)
        except ValueError: continue
        if m.get('id')==i: return m
w({"id":0,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"0"}}}); r(0); w({"method":"initialized"})
w({"id":1,"method":"hooks/list","params":{"cwds":[P+'/proj']}}); m=r(1); p.terminate()
print(m['result']['data'][0]['hooks'][0]['currentHash'])
EOF
)
write_cfg 5 "$(printf '\n[hooks.state."%s"]\ntrusted_hash = "%s"\n' "$KEY" "$FULL")"; echo "after recording trusted_hash:"; hooks_list "$H"
printf '#!/bin/sh\necho edited >&2\nexit 0\n' > "$H/hooks/pre.sh"; echo "after editing the script body only:"; hooks_list "$H"
write_cfg 7 "$(printf '\n[hooks.state."%s"]\ntrusted_hash = "%s"\n' "$KEY" "$FULL")"; echo "after changing timeout 5 -> 7:"; hooks_list "$H"

if command -v docker >/dev/null 2>&1 && [ -x "$CODEX_BIN" ]; then
echo "### M managed hooks from /etc/codex/requirements.toml (container, --network none)"
M=$W/m; mkdir -p "$M/home" "$M/codex-home" "$M/proj"
printf '[features]\nhooks = false\n' > "$M/codex-home/config.toml"
REQ_HOOK='[hooks]\nmanaged_dir = "/enterprise/hooks"\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "python3 /enterprise/hooks/policy.py"\ntimeout = 30\n'
printf "[features]\nhooks = true\n$REQ_HOOK" > "$M/req-pinned.toml"
printf "$REQ_HOOK" > "$M/req-unpinned.toml"
for req in req-pinned req-unpinned; do
  echo "$req (user config sets features.hooks = false; /enterprise/hooks does not exist in the container):"
  python3 - "$M" "$req.toml" "$CODEX_BIN" "$IMAGE" <<'EOF'
import json,subprocess,sys
D,req,B,img=sys.argv[1:5]
cmd=['docker','run','--rm','-i','--network','none','--user','%d:%d'%(__import__('os').getuid(),__import__('os').getgid()),'--entrypoint','/codex',
 '-v',B+':/codex:ro','-v',D+'/'+req+':/etc/codex/requirements.toml:ro','-v',D+'/home:/home/probe',
 '-v',D+'/codex-home:/home/probe/.codex-probe','-v',D+'/proj:/proj','-e','HOME=/home/probe','-e','CODEX_HOME=/home/probe/.codex-probe','-w','/proj',img,'app-server']
p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
w=lambda o:(p.stdin.write(json.dumps(o)+'\n'),p.stdin.flush())
def r(i):
    while True:
        l=p.stdout.readline()
        if not l: return None
        try: m=json.loads(l)
        except ValueError: continue
        if m.get('id')==i: return m
w({"id":0,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"0"}}}); r(0); w({"method":"initialized"})
w({"id":1,"method":"hooks/list","params":{"cwds":["/proj"]}}); m=r(1); p.stdin.close(); p.wait(timeout=30)
for e in m['result']['data']:
    if not e['hooks']: print('  (no hooks listed)')
    for h in e['hooks']: print('  source=%s trust=%s managed=%s'%(h.get('source'),h.get('trustStatus'),h.get('isManaged')))
    for x in e.get('errors',[]): print('  ERR',x)
EOF
done
else echo "### M skipped: docker or the native binary is unavailable"; fi
echo "### features"; HOME=$W/l1/home CODEX_HOME=$W/l1/codex-home codex features list 2>/dev/null | grep -E '^hooks '
rm -rf "$W"
