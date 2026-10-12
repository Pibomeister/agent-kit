/**
 * `ak learn memory <verb>`: the memory loop from the command line.
 *
 * `tick` is the scheduled entry and stays stat-only. Every other verb runs in
 * the foreground on the user's behalf, so it may resolve a linked worktree
 * with git. `rollback` restores the wiki layer (memory.md, lessons) only; the
 * raw episodes and runs are append-only and never reverted.
 */
import { rmSync } from "node:fs";
import { basename } from "node:path";
import { unknownSelector } from "../../util/suggest.ts";
import type { LearnArea, LearnArgs, LearnContext } from "../core/context.ts";
import { flag } from "../core/context.ts";
import { Ledger } from "../core/ledger.ts";
import { mainRepoRoot, projectFolderName, tickLogPath } from "../core/paths.ts";
import { appendJsonl, nowIso, readJsonl, readText } from "../core/store.ts";
import { generations } from "../core/trace.ts";
import { UNDONE_RUNS_FILE } from "./episodes.ts";
import { ensureMemoryLedger, memoryDir, readState, saveState } from "./ledger.ts";
import { logRegistryWarnings, readRegistry, registerRoot, unknownRepo } from "./registry.ts";
import { sessionRoot } from "./session-context.ts";
import { type Job, JOBS, tick } from "./tick.ts";

/** The paths `rollback` restores. Everything else in the ledger is raw or state. */
export const WIKI_PATHS = ["memory.md", "lessons.md", "lessons"];

function rootFor(args: LearnArgs, ctx: LearnContext): string | null {
  const repo = flag(args, "repo");
  const root = sessionRoot(repo ?? ctx.cwd);
  if (root === null) notARepo(ctx, repo);
  return root;
}

function notARepo(ctx: LearnContext, repo: string | undefined): void {
  ctx.io.err(
    `ak learn memory: not inside a git repository${repo === undefined ? "" : `: ${unknownRepo(ctx.config, repo)}`}`,
  );
}

function jobFlag(args: LearnArgs, ctx: LearnContext): Job | "all" | null {
  const job = flag(args, "job") ?? "all";
  if (job === "all" || (JOBS as readonly string[]).includes(job)) return job as Job | "all";
  ctx.io.err(`ak learn memory: --job: ${unknownSelector("job", job, [...JOBS, "all"])}`);
  return null;
}

/** Hold the memory ledger's lock around `body`; a held lock exits quietly with status 0. */
function locked(ctx: LearnContext, ledger: Ledger, body: () => number): number {
  const release = ledger.tryLock();
  if (release === null) {
    ctx.io.err("ak learn memory: another run holds the memory ledger lock");
    return 0;
  }
  try {
    return body();
  } catch (error) {
    ctx.io.err(`ak learn memory: ${(error as Error).message}`);
    return 1;
  } finally {
    release();
  }
}

function setMuted(args: LearnArgs, ctx: LearnContext, muted: boolean): number {
  const root = rootFor(args, ctx);
  if (root === null) return 1;
  const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
  return locked(ctx, ledger, () => {
    saveState(ledger, { ...readState(ledger), muted });
    ledger.commit(muted ? "mute" : "unmute");
    ctx.io.out(
      muted
        ? `memory muted for ${root}: no session-start memory and no scheduled jobs (\`ak learn memory run\` still works)`
        : `memory unmuted for ${root}`,
    );
    return 0;
  });
}

/**
 * Restore the wiki paths to their state at `to`, or to just before the last
 * commit that touched them. All or nothing: a target that is not an ancestor
 * of HEAD, or uncommitted changes under the wiki paths, refuse before anything
 * is touched, and a path that fails to restore puts every path back to HEAD.
 * The restore is one new commit, so it can itself be rolled back. Every
 * nightly run committed after the target is recorded as undone in that same
 * commit, so the episodes it consolidated become eligible again.
 */
export function rollbackWiki(ledger: Ledger, to?: string): string {
  let target = to;
  if (target === undefined) {
    const last = ledger.git(["log", "-1", "--format=%H", "--", ...WIKI_PATHS]).stdout.trim();
    if (last === "") return "nothing to roll back";
    target = `${last}~1`;
  }
  const resolved = ledger.git(["rev-parse", "--verify", "--quiet", `${target}^{commit}`]).stdout.trim();
  if (resolved === "") return to === undefined ? "nothing to roll back" : ledger.unknownRevision(to);
  if (ledger.git(["merge-base", "--is-ancestor", resolved, "HEAD"]).code !== 0)
    return `${to ?? target} is not an ancestor of the ledger's HEAD`;
  const dirty = ledger
    .git(["status", "--porcelain", "--", ...WIKI_PATHS])
    .stdout.split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
  if (dirty.length > 0) return `the wiki has uncommitted changes (${dirty.join(", ")}); nothing was changed`;
  const changed = ledger
    .git(["diff", "--name-only", resolved, "HEAD", "--", ...WIKI_PATHS])
    .stdout.split("\n")
    .filter((line) => line !== "");
  if (changed.length === 0) return "nothing to roll back";
  const undone = ledger
    .git(["log", "--format=%s", `${resolved}..HEAD`])
    .stdout.split("\n")
    // A nightly run id is its span id (16 hex); runs recorded before spans carry `nightly-<date>-<n>`.
    .map((subject) => /^nightly (nightly-[\w-]+|[0-9a-f]{16}):/.exec(subject)?.[1])
    .filter((run): run is string => run !== undefined);
  const failure = restorePaths(ledger, resolved, changed);
  if (failure !== null) {
    restorePaths(ledger, "HEAD", changed);
    return `rollback failed on ${failure}; nothing was changed`;
  }
  appendJsonl(
    ledger.path(UNDONE_RUNS_FILE),
    undone.map((run) => ({ run, rollback: resolved, ts: nowIso() })),
  );
  ledger.commit(`rollback to ${resolved.slice(0, 12)}`);
  return `rolled back ${changed.length} file${changed.length === 1 ? "" : "s"} to ${resolved.slice(0, 12)}`;
}

/** Put each path back to its content at `rev`, removing it where `rev` has none. Returns the first path that failed, or null. */
function restorePaths(ledger: Ledger, rev: string, paths: readonly string[]): string | null {
  for (const path of paths) {
    if (ledger.git(["cat-file", "-e", `${rev}:${path}`]).code === 0) {
      if (ledger.git(["checkout", rev, "--", path]).code !== 0) return path;
    } else {
      rmSync(ledger.path(path), { force: true });
    }
  }
  return null;
}

function status(args: LearnArgs, ctx: LearnContext): number {
  const root = rootFor(args, ctx);
  if (root === null) return 1;
  const entry = readRegistry(ctx.config)[projectFolderName(root)];
  const ledger = new Ledger(memoryDir(ctx.config, root));
  ctx.io.out(`root: ${root}`);
  ctx.io.out(
    entry === undefined
      ? "registry: not registered"
      : `registry: claude-mem project ${entry.mem_project}, last seen ${new Date(entry.last_seen).toISOString()}`,
  );
  ctx.io.out(`ledger: ${ledger.dir}${ledger.initialized ? "" : " (not created yet)"}`);
  if (!ledger.initialized) return 0;
  ctx.io.out(`state: ${JSON.stringify(readState(ledger))}`);
  ctx.io.out("");
  ctx.io.out("## Last runs");
  const runs = readJsonl<Record<string, unknown>>(ledger.path("runs.jsonl")).slice(-5);
  for (const run of runs) ctx.io.out(JSON.stringify(run));
  if (runs.length === 0) ctx.io.out("(none)");
  const name = entry?.mem_project || basename(root);
  // The tick log is capped with one previous generation; read it first so a fresh rotation hides nothing.
  const ticks = generations(tickLogPath(ctx.config))
    .flatMap((path) => readText(path).split("\n"))
    .filter((line) => line.startsWith(`${name}: `))
    .slice(-20);
  ctx.io.out("");
  ctx.io.out("## Tick log");
  for (const line of ticks) ctx.io.out(line);
  if (ticks.length === 0) ctx.io.out("(none)");
  return 0;
}

export const memoryArea: LearnArea = {
  summary: "observed host sessions -> working memory and lessons, merged into the session-start block",
  verbs: {
    tick: {
      usage:
        "memory tick [--force] [--job reflect|backfill|nightly|weekly|all]   the scheduled pass over every active project",
      run: (args, ctx) => {
        const job = jobFlag(args, ctx);
        if (job === null) return 2;
        const force = args.flags.has("force");
        return tick(ctx, { job: force || args.flags.has("job") ? job : undefined, force });
      },
    },
    run: {
      usage:
        "memory run [--job reflect|backfill|nightly|weekly|all] [--repo PATH]   run the jobs now for one repo, due or not",
      run: (args, ctx) => {
        const job = jobFlag(args, ctx);
        if (job === null) return 2;
        const repo = flag(args, "repo");
        const root = mainRepoRoot(repo ?? ctx.cwd);
        if (root === null) {
          notARepo(ctx, repo);
          return 1;
        }
        const registration = registerRoot(ctx.config, root);
        logRegistryWarnings(ctx.config, registration.warnings);
        if (registration.refusal !== null) {
          ctx.io.err(`ak learn memory: ${registration.refusal}`);
          return 1;
        }
        return tick(ctx, { only: root, job, force: true });
      },
    },
    status: {
      usage: "memory status [--repo PATH]   registry entry, state, the last runs and tick-log lines",
      run: status,
    },
    show: {
      usage: "memory show [--repo PATH]     memory.md and the lessons index",
      run: (args, ctx) => {
        const root = rootFor(args, ctx);
        if (root === null) return 1;
        const ledger = new Ledger(memoryDir(ctx.config, root));
        const memory = readText(ledger.path("memory.md")).trim();
        const lessons = readText(ledger.path("lessons.md")).trim();
        ctx.io.out(memory === "" ? "(no memory yet)" : memory);
        ctx.io.out("");
        ctx.io.out(lessons === "" ? "(no lessons yet)" : lessons);
        ctx.io.out("");
        ctx.io.out(`ledger: ${ledger.dir}`);
        return 0;
      },
    },
    mute: {
      usage: "memory mute [--repo PATH]     stop session-start memory and scheduled jobs for this repo",
      run: (args, ctx) => setMuted(args, ctx, true),
    },
    unmute: {
      usage: "memory unmute [--repo PATH]   undo mute",
      run: (args, ctx) => setMuted(args, ctx, false),
    },
    rollback: {
      usage:
        "memory rollback [--to SHA] [--repo PATH]   restore memory.md and lessons to before the last change, or to SHA",
      run: (args, ctx) => {
        const root = rootFor(args, ctx);
        if (root === null) return 1;
        const ledger = new Ledger(memoryDir(ctx.config, root));
        if (!ledger.initialized) {
          ctx.io.out("nothing to roll back");
          return 0;
        }
        return locked(ctx, ledger, () => {
          const message = rollbackWiki(ledger, flag(args, "to"));
          ctx.io.out(message);
          return message.startsWith("rolled back") || message === "nothing to roll back" ? 0 : 1;
        });
      },
    },
    projects: {
      usage: "memory projects               the registered repositories",
      run: (_args, ctx) => {
        const entries = Object.values(readRegistry(ctx.config)).sort((a, b) => b.last_seen - a.last_seen);
        for (const entry of entries)
          ctx.io.out(
            `${new Date(entry.last_seen).toISOString().slice(0, 10)}  ${entry.mem_project.padEnd(24)} ${entry.root}`,
          );
        if (entries.length === 0) ctx.io.out("(no registered projects)");
        return 0;
      },
    },
  },
};
