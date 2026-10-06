# claude-code-5 — permission gaps

**Fact as stated** (`C:L136`): a deny rule for `git push` doesn't match `git -C . push`. Read and
Edit deny rules don't cover a subprocess that opens files itself. The sandbox covers Bash and its
children.

**Instrument:** claude 2.1.288 (sha256 `0298068b…640c`), docs fetched 2026-10-03, live session 1.

**Verdict:** verified, all three clauses. The sandbox clause holds only when the sandbox is on.

## Evidence

Docs, `permissions` page, "What a Bash rule doesn't match":

| Rule | Stops | Doesn't stop |
|---|---|---|
| `Bash(git push *)` | `git push origin main` | `git -C . push origin main`, `git -c push.default=current push origin main`, `git 'push' origin main` |

and, in the same section, "a deny or ask rule covers the invocation Claude usually produces and isn't
a security boundary around the program."

Docs, `permissions` page, "Read and Edit", warning: the rules cover the built-in file tools, the file
commands Claude Code recognizes in Bash such as `cat`, `head`, `tail`, `sed` and `tee`, and
redirection targets. "They don't apply to a command that reads files without naming them … or to
arbitrary subprocesses that read or write files indirectly, like a Python or Node script that opens
files itself."

Docs, `sandboxing` page: "the limits apply to Bash, PowerShell, and Monitor commands and the
processes they start", and "The sandbox covers shell commands only. Claude's file tools, MCP servers,
and hooks run outside it."

Installed binary. A prefix rule matches only when the normalized command equals the prefix or starts
with the prefix and a space; a wildcard rule compiles to `^git push( .*)?$`. Normalization strips
environment assignments and a fixed table of wrappers (`env`, `sudo`, `timeout`, `nice`, `nohup` and
others) and has no entry that strips git's global options. The table of Bash commands whose path
arguments are checked against Read rules covers `cat`, `head`, `tail`, `sed`, `grep`, `jq` and similar,
and has no interpreter. The sandbox wraps commands in `bwrap` with `--unshare-pid`, `--unshare-net`
and `--die-with-parent`.

Live session 1 (`probes/claude-code/probe-a.out.txt`), with allow rules for `echo`, `git`,
`python3` and `cat`, deny rules `Bash(git push *)` and `Read(./secret.txt)`:

| Command | Executed |
|---|---|
| `git push origin main` | no, in `permission_denials` |
| `git -C . push origin main` | yes; the local bare remote then had `main` |
| `cat secret.txt` | no, in `permission_denials` |
| `python3 -c "print(open('secret.txt').read())"` | yes |

## Nuances

- The changelog entry for `2.1.0` says "`git -C /path log` now correctly matches `Bash(git log:*)`
  rules". That described an earlier prefix-extraction mechanism; on 2.1.288 the live probe and the
  docs agree that `-C` escapes the rule.
- The sandbox is off by default. On Linux it needs `bwrap` and `socat`; this machine has `bwrap`
  0.9.0 and no `socat`, so the sandbox clause was verified from docs and binary, not live.

## What this changes

A deny rule is feedback in front of the boundary, never the boundary. The guard parses git's global
options before the subcommand, as `child-guard.sh` already does, and the bypass fixtures in the M1
plan carry `git -C . push` and an interpreter opening a protected file. Hard constraints on files rest
on the sandbox, file permissions or CI, not on Read and Edit rules.

## Re-derive

As for claude-code-1. The `check` step prints the denials and whether the remote has `main`.
