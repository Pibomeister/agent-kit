# Integration guide: the self-learning stack

For an agent with no prior context that has to (a) install this stack on a machine it has never
seen, (b) onboard a repo, and (c) put the stack into a shared skills repository so other machines
can install it. `SETUP.md` in this directory is the step-by-step runbook; this file explains what
the pieces are, what broke while building it, and how to distribute it. Read both.

Shorthand used throughout:

```sh
S=~/.claude/skills/stack-setup/scripts/install.py
SK=~/.claude/skills
CFG=${CLAUDE_CONFIG_DIR:-~/.claude}
```

---

## 1. What this is

A loop that turns what happened in coding sessions into instructions the next session reads.
claude-mem records every session into a SQLite database. review-learn ingests review findings
(GitHub PR threads, claude-mem observations, claude-reflect corrections) into a per-repo pattern
ledger and compiles recurring patterns into guardrails. skill-index injects a roster of available
skills and proposes new ones from repeating workflows. dreamd consolidates sessions on a schedule
into a memory block and typed lessons. All three inject at SessionStart, in Claude Code and Codex.

```
claude-mem observations ─┐
GitHub PR review threads ─┼→ review-learn ingest → findings → maintain → patterns → propose → guardrails ─┐
claude-reflect corrections ┘                                                                              │
                                                                                                          ├→ SessionStart
claude-mem sessions + tool use → dreamd episodes → reflect → memory.md ─┐                                 │
                                                  nightly → lessons.md ─┼─────────────────────────────────┘
                                                  weekly  → pruning ────┘
```

### The three layers

The ledgers follow the Raw / Wiki / Skills split from the WikiSkill paper: raw evidence is
append-only, the wiki layer is a rewritten synthesis with provenance back to raw, and the skills
layer is what an agent actually executes. Everything below lives under
`$CFG/projects/<repo-folder>/` and nothing is ever written inside a repo.

| Layer | Files | Written by | Rewritten? |
|---|---|---|---|
| Raw | `review-patterns/raw/review-events.jsonl`, `dream/episodes.jsonl`, the claude-mem database | ingest, episodes job, claude-mem | never, append only |
| Wiki | `review-patterns/patterns/rp-NNN.md`, `review-patterns/index.md`, `dream/memory.md`, `dream/lessons/ls-NNN.md`, `dream/lessons.md` | maintain, reflect, nightly, weekly | yes, every run |
| Skills | `review-patterns/guardrails.md`, the skill roster, `<index>/candidates/` | propose, `skill_index.py roster`, `skill_learn.py` | yes, on promotion or retirement |

Both ledgers (`review-patterns/`, `dream/`) are git repositories and every job commits. Rollback
is asymmetric on purpose: `git revert` undoes one job's rewrite of the wiki or skills layer, while
raw evidence and the claude-mem database are untouched, so the next run re-derives from the same
facts. See SETUP.md §6 for the two rollback commands.

---

## 2. Components and ownership

| Component | Kind | Source | Our relationship to it |
|---|---|---|---|
| claude-mem | Claude Code plugin | `claude-mem@thedotmack` marketplace | Source of truth. We read its SQLite database and add one mode file. We never write to its database. |
| claude-reflect | Claude Code plugin | `claude-reflect@claude-reflect-marketplace` | Optional. Its correction queue is one ingest source. Unmodified. |
| review-learn | skill, ours | `skills/review-learn/` in the bundle | Findings → patterns → guardrails. |
| skill-index | skill, ours | `skills/skill-index/` in the bundle | Roster injection, skill candidates. |
| dreamd | skill, ours | `skills/dreamd/` in the bundle | Scheduled consolidation. |
| stack-setup | skill, ours | `skills/stack-setup/` in the bundle | The installer and these docs. |

`install.py doctor` classifies requirements. Hard: `claude` CLI, `git`, python ≥ 3.9, the
claude-mem database. Soft: the claude-mem worker script, `gh` authenticated, the claude-reflect
plugin, `node` or `bun`. A soft miss degrades quality, not correctness (SETUP.md §1).

---

## 3. Install on a fresh machine

Order matters: claude-mem must have recorded at least one session before `doctor` passes, because
the database is a hard requirement and only claude-mem creates it.

```sh
# 1. plugins (both are marketplace installs; the marketplace is added first)
claude plugin marketplace add thedotmack/claude-mem
claude plugin install claude-mem@thedotmack
claude plugin marketplace add bayramannakov/claude-reflect             # optional
claude plugin install claude-reflect@claude-reflect-marketplace         # optional

# 2. run one real Claude Code session in any repo so claude-mem creates ~/.claude-mem/claude-mem.db

# 3. the stack
unzip claude-learning-stack.zip -d stack
python3 stack/skills/stack-setup/scripts/install.py doctor
python3 stack/skills/stack-setup/scripts/install.py apply --from stack
python3 $S wire
python3 $S schedule --load
python3 $S seed --repo /path/to/repo --pr <N> --pr <M>
python3 $S verify --repo /path/to/repo
```

The plugin commands above were checked against `claude plugin --help` and
`claude plugin marketplace list` on 2026-09-24. Re-check before relying on them; the CLI changes.

What each stack step does is in SETUP.md: `apply` §2, `wire` §3, `schedule` §3.4, `seed` §4,
`verify` §5. `apply --from` accepts a directory as well as a zip, so a git clone of the shared
skills repo works without unzipping anything.

After `wire`, confirm the claude-mem settings took: `~/.claude-mem/settings.json` must contain
`CLAUDE_MEM_MODE` = `code--review-learning` and `CLAUDE_MEM_CONTEXT_OBSERVATIONS` = `25`, and
the worker must have been restarted (quirk 6 below explains why the marketplace copy of the
worker script cannot do that).

---

## 4. Onboard a repo

```sh
python3 $S seed --repo /path/to/repo --since 2026-06-01 --pr 1874 --pr 1882
```

`--pr` repeats. Pick recently merged PRs that had real human review discussion; the first patterns
then rest on human findings rather than on observations alone. `--since` bounds the claude-mem
sweep. Both are optional.

There is no registration step. The dreamd SessionStart hook registers the repo root on every
session, and the tick also discovers repos from claude-mem tool use. A linked git worktree
resolves to the main repo's ledger through `git rev-parse --git-common-dir`
(`review-learn/scripts/common.py`, `main_repo_root`), so worktrees share one ledger.

A repo with little claude-mem history produces a thin `memory.md` and few lessons. That is
correct. The first reflect starts from the newest observations that fit its input cap and never
replays older history (quirk 10).

---

## 5. Quirks that cost days

Each entry is symptom → cause → fix. All were hit on the build machine between 2026-09-07 and
2026-09-21.

### 5.1 Skills root is fixed; the config dir is not

Symptom: after moving the skills anywhere but `~/.claude/skills`, every hook fails with an import
error.
Cause: the skills import each other through the literal path `~/.claude/skills/<name>/scripts`
(`SKILLS_ROOT` in `install.py`; grep `claude/skills` in the skill scripts).
Fix: leave them there. `CLAUDE_CONFIG_DIR` may point anywhere. On the build machine it is
`~/.claude/.omc-launch`, and that directory's `projects/` and `skills/` are symlinked back into
`~/.claude`, which is why both `~/.claude/projects/` and `$CFG/projects/` show the same folders.

### 5.2 `CLAUDE_CONFIG_DIR` must reach the scheduler AND the claude-mem worker

Symptom A: ledgers appear under `~/.claude/projects/` while sessions read `$CFG/projects/`;
memory stays empty with no error.
Cause A: the scheduler unit did not carry the variable. `.zshrc` exports are invisible to launchd
and systemd.
Fix A: `install.py schedule` writes it into the unit's own environment. Do not remove it.

Symptom B: claude-mem stops recording; its log shows `OAuth session expired` and then
`NOT NULL constraint failed: observations.memory_session_id`.
Cause B: the claude-mem worker daemon was lazily spawned by some other tool (Cursor, a Codex hook)
without the variable, so its `claude` subprocess used the logged-out default `~/.claude` profile.
Fix B on macOS: a `launchctl setenv` LaunchAgent plus an export in `~/.zshenv`, then kill the
daemon and let a hook from a real session respawn it. The build machine's plist:

```xml
<key>ProgramArguments</key><array>
  <string>/bin/launchctl</string><string>setenv</string>
  <string>CLAUDE_CONFIG_DIR</string><string>/Users/<you>/.claude/.omc-launch</string>
</array>
<key>RunAtLoad</key><true/>
```

Diagnose with `ps eww $(pgrep -f 'worker-service.cjs --daemon') | tr ' ' '\n' | grep CLAUDE_CONFIG_DIR`.
Empty output means the daemon has the wrong environment. GUI apps must be relaunched to pick up a
fresh `launchctl setenv`.

### 5.3 launchd plus `~/Documents` hangs forever

Symptom: `tick.log` stops mid-run; `launchctl print` shows the job running for hours.
Cause: a launchd job that opens a file under `~/Documents` blocks in `open$NOCANCEL` waiting for
the macOS Files-and-Folders consent prompt, which never appears because the job has no UI.
`subprocess.run(timeout=...)` does not fire; SIGKILL cannot interrupt that state. `stat` on the
same paths does not block; only `open` does, and `git rev-parse` opens files.
Fix: the tick never spawns git and never opens a repo file. Repo roots are registered from the
SessionStart hook (`dreamd/scripts/dcommon.py`, `register_root`), which runs in a user session
that already has consent. Any future background job here must treat repo paths as opaque strings.

### 5.4 Model calls: `--settings '{"disableAllHooks":true}'`, never `--bare`

Symptom: a hook-launched maintain call hangs, or claude-mem records the maintainer's own prompt as
an observation.
Cause: `claude -p` inside a hook fires the hooks again, and claude-mem observes the call.
Fix: every model call is `claude -p --settings '{"disableAllHooks":true}' --output-format json`
(`claude_json` in `review-learn/scripts/common.py`). `--bare` looked
equivalent and broke OAuth on the build machine. Do not use it.

### 5.5 Two folder-name conventions

Symptom: two project folders on disk, `...-sample-frontend` and `...-sample_frontend`,
and a source that finds nothing under one of them.
Cause: Claude Code replaces every non-alphanumeric with `-`; claude-reflect keeps underscores.
Fix: `common.py` has both, `project_folder_name` and `reflect_folder_name`. Use the right one per
source. The ledgers use the Claude Code convention.

### 5.6 The claude-mem mode file is copied by hand

Symptom: claude-mem's `mode-creator/scripts/install-mode.mjs` rejects the bundled
`code--review-learning` mode (its parent `code` mode has ids with underscores such as
`security_alert`, and the installer wants kebab-case).
Fix: `install.py apply` copies `claude-mem/modes/code--review-learning.json` straight into
`~/.claude-mem/modes/`, and `wire` sets `CLAUDE_MEM_MODE`, then restarts the worker with the
newest `plugins/cache/*/claude-mem/*/scripts/worker-service.cjs restart`. The copy of that script
under `plugins/marketplaces/` fails with a missing-module error; the installer only looks under
`plugins/cache/`. To change the mode later, edit the file and restart the worker; do not retry
`install-mode.mjs`.

### 5.7 claude-mem "allowance exhausted" is usually stale

Symptom: the SessionStart banner says the inference allowance is exhausted and that restarting
will not help.
Cause: the long-lived worker cached a utilization value (97.0% for four days on the build
machine) and re-arms its cooldown from that stale number. The cooldown is also reloaded from
`~/.claude-mem/quota-cooldown.json` at startup, so a plain restart re-arms it.
Fix: delete `~/.claude-mem/quota-cooldown.json`, `kill -TERM` the pid in
`~/.claude-mem/worker.pid`, delete the file again (shutdown can rewrite it), let a hook respawn
the daemon. Verify in `~/.claude-mem/observer-health.json`: `consecutiveFailures` 0,
`quotaCooldown` null. The tell is `grep -ohE "utilization [0-9.]+%" ~/.claude-mem/logs/*.log`
returning the same decimal for days.

### 5.8 The 50 → 25 observation budget is a trade, not a default

`wire` sets `CLAUDE_MEM_CONTEXT_OBSERVATIONS` to 25. The tokens freed pay for dreamd's injected
block, capped at 2,500 tokens by `DREAMD_MEMORY_TOKENS`. Raising the budget back without lowering
the cap grows resident context on every session.

### 5.9 The Stop hook fires every turn; manual runs race it

The review-learn Stop hook fires at every turn end, not only when a session ends, and debounces
10 minutes. A manual `maintain.py` during an active session can collide with a hook-launched one.
Both take the ledger lock at `review-patterns/raw/.lock`; the loser exits cleanly and does
nothing. Check `ps` for a running `stop_hook.py` before a manual run, or expect a silent no-op.

### 5.10 dreamd assumptions

- A project's claude-mem name is assumed to equal the repo folder basename (`register_root`
  stores `mem_project: root.name`). When that fails the tick prints
  `no claude-mem observations under project '<name>'`.
- The first reflect on a cold ledger reads the newest observations that fit its input cap and
  sets the watermark past everything older. There is no backfill by design. A written plan for a
  one-shot backfill exists on the build machine at `$CFG/dreamd/backfill-plan.md`; it is not part
  of the bundle and nothing from it is built.
- A lesson's `last_seen` is set at creation and refreshed only by a weekly merge, so the 90-day
  decay means 90 days since creation or last merge.

### 5.11 Skill roster: move with the script, never `mv`

`skill_index.py move|restore|build|status|roster` (`skill-index/scripts/skill_index.py`) is the
only way to move a skill between `~/.claude/skills` and the index. It repoints the symlinks in
`~/.codex/skills` and `~/.agents/skills`; a bare `mv` leaves them dangling. On the build machine
`~/.claude/skills/synced` and `~/.claude/skills/omc-learned` are managed by Claude and OMC
respectively; the roster tooling was never pointed at them and they must not be moved.

The `skill_index.py roster` SessionStart hook is what makes the index route. In the trigger eval
a pull-only index routed 5 of 14 cases; with the roster hook it routed 12 of 14, level with
installed skills. Without the hook the index is dead weight.

### 5.12 Model choice

`REVIEW_LEARN_MODEL` defaults to `sonnet` (`common.py` line 14). In `evals/maintainer_eval.py`
haiku merged two distinct pattern classes (precision 0.67) where sonnet scored 1.00. `DREAMD_MODEL`
and `SKILL_LEARN_MODEL` also default to `sonnet`.

---

## 6. Adding the stack to a shared skills repository

The bundle layout is the repository layout. `install.py apply --from <clone>` already reads it,
because `apply` accepts a directory and looks for `skills/<name>/SKILL.md` under it.

```
skills/
  review-learn/        SKILL.md scripts/ tests/ evals/
  skill-index/         SKILL.md scripts/ tests/ evals/
  dreamd/              SKILL.md scripts/ tests/ evals/
  stack-setup/         SKILL.md scripts/ tests/ references/
claude-mem/
  modes/code--review-learning.json
INSTALL.txt
README.md              (write one; the zip does not carry it)
```

Consumers:

```sh
git clone <skills repo> stack
python3 stack/skills/stack-setup/scripts/install.py doctor
python3 stack/skills/stack-setup/scripts/install.py apply --from stack
# then wire, schedule --load, seed, verify as in §3
```

CI for the repository: the three skill suites plus the installer's own, none of which make model
calls.

```sh
for s in review-learn skill-index dreamd stack-setup; do
  python3 -m unittest discover skills/$s/tests || exit 1
done
```

The evals under `skills/*/evals/` (`maintainer_eval.py`, `recurrence_replay.py`,
`reflect_eval.py`, `trigger_eval.py`, `skill_learn_eval.py`) call the model. Keep them manual.

Regenerating the zip from an installed machine:

```sh
python3 $S bundle --out ~/claude-learning-stack.zip
```

`bundle` reads from `~/.claude/skills`, not from the clone, so install first. It excludes
`__pycache__`, `.pyc`, lock files, `.DS_Store`, `.git/`, `.omc/`, `.context/` experiment output,
and `.bak-*` directories left by `apply`.

---

## 7. Verify and prove it

```sh
python3 $S verify --repo /path/to/repo
```

Phases: `wire` (each hook exactly once, mode file present, budget 25, scheduler loaded), `tests`
(the three skill suites), `seed` (both ledgers exist with commits, `runs.jsonl` has episodes and
reflect rows, watermark set, injected block within cap). Then the three manual checks in
SETUP.md §5: a real session shows all three blocks, one scheduler interval adds a line to
`tick.log`, mute and unmute toggles the block.

What healthy output looks like, taken from the build machine on 2026-09-24:

`$CFG/dreamd/tick.log`, one tick:

```
== 2026-09-24T16:40:19Z tick CLAUDE_CONFIG_DIR=/Users/<you>/.claude/.omc-launch
sample_frontend: episodes +0
sample_frontend: idle 5084s new_tokens 1592 new_obs 1 unconsolidated 1 due none
```

`dream/runs.jsonl`, last two rows:

```
{"ts": "2026-09-24T15:24:10Z", "job": "episodes", "status": "ok", "new": ["9c269615-..."]}
{"ts": "2026-09-24T15:25:15Z", "job": "reflect", "status": "rejected", "reason": "over cap", "dropped_by_provenance": 0, "trigger": "tick", "observations": 1, "sessions": 1}
```

A `rejected` reflect with reason `over cap` means the model's rewrite exceeded 1.3× the memory cap
and was discarded (`degenerate` in `dreamd/scripts/reflect.py`); the previous `memory.md` stays and
the next tick retries. `dropped_by_provenance` should stay near zero.

`review-patterns/guardrails.md`, first lines:

```
- [rp-001] Move the state check into the critical section guarded by the same lock as the action.
- [rp-002] Verify the return value or exception handling before proceeding with dependent work; escalate or block if the operation failed.
- [rp-003] Before commit, verify every factual claim in prose by reading the actual code it names or running the test it cites.
```

`review-patterns/index.md` carries a runs table with a repeat-rate column. That column is the
metric the whole system exists to drive down.

---

## 8. Known ceilings

Design limits, not bugs to chase. Same list as SETUP.md §7.

- The evidence gate checks that a cited observation id exists, not that it supports the
  sentence. `git revert` on the dream ledger is the remedy for a bullet that reads wrong.
- Contrastive failure pairing needs file lists, which claude-mem populates on roughly 4% of
  observations (`files_modified`), so that mechanic is largely inert. dreamd supplements from
  tool use where it can.
- The first reflect on a cold ledger skips history older than its input cap, permanently. A
  backfill pipeline is planned, not built (§5.10).
- `last_seen` on lessons is refreshed only by a merge.
- The Stop hook and a manual `maintain.py` race for the ledger lock; the loser exits silently.
