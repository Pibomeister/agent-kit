---
name: dreamd
description: Scheduled "dreaming" layer over claude-mem and review-learn - observational memory (memory.md rewritten by a Reflector), nightly consolidation of sessions into typed lessons, weekly pruning/compaction - injected at SessionStart within a 2.5k-token cap. Use for "/dreamd", "dream status", "what does dreamd remember", "mute dreamd", "rollback memory", "run the nightly consolidation", "why is memory.md saying X".
---

# dreamd

Downstream consumer of claude-mem (`~/.claude-mem/claude-mem.db`, read-only), the review-learn ledger and skill-learn.
Runs away from the foreground loop: a launchd job ticks every 15 min (`com.$USER.dreamd`); nothing here fires from a Stop hook.

Per-project ledger (git-versioned, private): `$CLAUDE_CONFIG_DIR/projects/<repo-folder>/dream/`

| File | What | Who writes |
|---|---|---|
| `memory.md` | organized working memory; the only thing injected (plus confirmed lessons) | `reflect.py` (1 model call, then deterministic gates) |
| `episodes.jsonl` | one record per completed claude-mem session + priority score | `episodes.py` (no model) |
| `lessons/ls-NNN.md`, `lessons.md` | typed lessons: statement, scope, status (hypothesis → confirmed when evidence spans ≥2 sessions; superseded/stale/conflict), confidence, evidence | `consolidate.py` (nightly), `deep.py` (weekly) |
| `runs.jsonl`, `log.md`, `.state.json` | run ledger, log, watermarks (`last_obs_id_reflected`, `last_nightly`, `last_weekly`, `muted`) | all |

Registry of projects: `$CLAUDE_CONFIG_DIR/dreamd/projects.json`, written three ways - the tick auto-discovers repos from claude-mem `tool_uses.cwd` (last 14 days, root found by walking up for a `.git` directory with stat only), the SessionStart hook registers the repo of every Claude/Codex session (this is what covers linked worktrees, whose `.git` is a file), and `tick.py --project` registers one explicitly. Tick log: `$CLAUDE_CONFIG_DIR/dreamd/tick.log`.

Three behaviours worth knowing. The first reflect on a cold ledger reads the NEWEST observations that fit its input cap and sets the watermark past everything older, so memory starts from the present rather than replaying months of history; there is no backfill of older observations into memory.md by design. Next, a project's claude-mem name is assumed to be the repo folder basename (true for every project here), and a tick prints `no claude-mem observations under project '<name>'` when that assumption fails. A lesson's `last_seen` is set at creation and refreshed only by a weekly merge, so the 90-day decay means 90 days since creation or last merge, not since the lesson was last independently observed.

macOS gotcha: under launchd, opening a file inside `~/Documents` blocks uninterruptibly on the Files-and-Folders (TCC) prompt (`open$NOCANCEL`, immune to subprocess timeouts). The tick therefore never spawns git and never reads a file inside a repo; `root_of()` uses stat only, which is why a linked worktree resolves from its session rather than from the tick.

Invariant enforced in code, not by a model: a bullet or lesson survives only if it cites an `obs:NNN` / `S<session>` id that was in the model's input (or already cited in the previous memory). `runs.jsonl` records `dropped_by_provenance` per reflect - a rising count means the prompt is inventing evidence.

Known ceiling of that gate: it checks that the id exists, not that it supports the sentence. A model could attach an id carried over from the previous memory to a new claim and pass. The gate catches invented ids, not misattributed ones; `/dreamd rollback` is the remedy when a bullet reads wrong.

## Commands

`S=~/.claude/skills/dreamd/scripts`; `DREAM=$(python3 -c 'import sys,os;sys.path.insert(0,os.path.expanduser("~/.claude/skills/dreamd/scripts"));import dcommon as D;print(D.dream_dir(D.C.main_repo_root(os.getcwd())))')`

| Command | Do |
|---|---|
| `/dreamd status` | `cat $CLAUDE_CONFIG_DIR/dreamd/projects.json; cat $DREAM/.state.json; tail -5 $DREAM/runs.jsonl; tail -20 $CLAUDE_CONFIG_DIR/dreamd/tick.log` |
| `/dreamd tick` | `python3 $S/tick.py` (all active projects, only due jobs) |
| `/dreamd run <reflect\|nightly\|weekly\|all> [--force]` | `python3 $S/tick.py --project <repo root> --job <job> [--force]` |
| `/dreamd report` | `cat $DREAM/memory.md $DREAM/lessons.md; tail -5 $DREAM/runs.jsonl` |
| `/dreamd run <job> --force` | forcing runs the job even on a muted project, and `--force` with no `--job` means all three |
| `/dreamd mute` / `unmute` | `python3 -c 'import sys,os;sys.path.insert(0,os.path.expanduser("~/.claude/skills/dreamd/scripts"));import dcommon as D;d=D.dream_dir(D.C.main_repo_root(os.getcwd()));s=D.state(d);s["muted"]=True;D.save_state(d,s)'` (`False` to unmute) - injection stops immediately, episodes keep accruing |
| `/dreamd rollback` | `git -C $DREAM revert --no-edit HEAD` (each reflect/nightly/weekly is one commit). To undo only the memory after later jobs have committed, a revert conflicts on `runs.jsonl`; use `git -C $DREAM checkout <reflect-commit>~1 -- memory.md` instead |
| dry run | `DREAMD_DRY_RUN=1 python3 $S/tick.py --project <root> --job all --force` prints decisions and prompts, writes nothing |

## Schedule (tick.py, `decide()`)

- `episodes`: every tick, every registered project active in the last 7 days.
- `reflect`: idle ≥ `DREAMD_IDLE_S` and new discovery tokens ≥ `DREAMD_REFLECT_TOKENS`, or ≥6h since last reflect with any new observation.
- `nightly`: episodes that do not fit the 80k-character prompt stay pending for the next run; only what the model actually read is marked consolidated and only its ids pass the gate. Contrastive pairing and the successful-repeat stratum need file lists, and claude-mem fills `files_modified` on about 4% of observations, so both are largely inert until that improves; dreamd supplements the list from `tool_uses` edits. Trigger: local hour ≥ `DREAMD_NIGHTLY_HOUR`, not yet today, ≥1 unconsolidated episode; or ≥25 unconsolidated when idle. Stratified 40/40/20 (failures+corrections / successful repeats / novelty), failures paired with the later completed episode on the same files. Also forwards review events to review-learn `raw/review-events.jsonl` (`source=dreamd`); review-learn classifies them on its own next run.
- `weekly`: ≥7 days since last, idle. Rolls up review-patterns evidence older than 30 days per month (its own commit `dreamd: compact evidence` in that ledger), marks 90-day-unseen confirmed lessons `stale`, lists never-used skill-learn candidates in `log.md`, one model call for merge/contradiction pairs (`conflict` blocks injection).

## Env

| Var | Default |
|---|---|
| `DREAMD_MODEL` | `sonnet` |
| `DREAMD_IDLE_S` | `300` |
| `DREAMD_REFLECT_TOKENS` | `25000` |
| `DREAMD_MEMORY_TOKENS` | `2500` (cap for memory.md and the injected block) |
| `DREAMD_NIGHTLY_HOUR` | `2` |
| `DREAMD_BATCH` | `24` |
| `DREAMD_LEDGER` | scratch ledger override (tests/evals) |

## Wired

- SessionStart (Claude `$CLAUDE_CONFIG_DIR/settings.json`, Codex `~/.codex/hooks.json`): `session_context.py` prints memory.md + up to 8 confirmed lessons trimmed to the cap, then `dreamd: reflected <age> ago · N lessons (k confirmed) · next nightly <date> · /dreamd report`.
- Budget trade: `~/.claude-mem/settings.json` `CLAUDE_MEM_CONTEXT_OBSERVATIONS=25` (was 50) pays for the injected block.
- launchd `~/Library/LaunchAgents/com.$USER.dreamd.plist`, `StartInterval 900`. `launchctl list | grep dreamd`; reload with `launchctl bootout gui/$(id -u)/com.$USER.dreamd; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.$USER.dreamd.plist`.

## Testing

```
python3 -m unittest discover ~/.claude/skills/dreamd/tests          # episodes+priority literals, provenance gate, reflect guards, consolidate apply, evidence compaction, scheduler decisions, lock
cd <repo> && python3 ~/.claude/skills/dreamd/evals/reflect_eval.py  # 1 model call: Reflector over the last 40 real observations into a scratch ledger; cap, sections, provenance asserted; prints the memory
```
