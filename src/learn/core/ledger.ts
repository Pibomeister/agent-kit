/**
 * A git-versioned ledger directory: one commit per completed job, one lock per
 * ledger. A failed or rejected reflect, and a failed nightly, commit nothing;
 * the rows they record ride in the next commit.
 *
 * Raw layers are append-only and are never reverted. Wiki layers (pattern
 * pages, memory, lessons, guardrails) are revertible through git. That
 * asymmetry is the point: a rolled-back guardrail stays on record as having
 * been tried.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./proc.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "ak learn",
  GIT_AUTHOR_EMAIL: "ak-learn@local",
  GIT_COMMITTER_NAME: "ak learn",
  GIT_COMMITTER_EMAIL: "ak-learn@local",
};

export class Ledger {
  constructor(readonly dir: string) {}

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  git(args: readonly string[], timeoutMs = 60_000) {
    return run(["git", ...args], { cwd: this.dir, timeoutMs, env: { ...process.env, ...GIT_ENV } });
  }

  get initialized(): boolean {
    return existsSync(join(this.dir, ".git"));
  }

  /**
   * Create the directory, the git repository and any missing seed files, then
   * commit. Existing files are never overwritten, so this is safe on every run.
   */
  ensure(seed: Readonly<Record<string, string>>, message = "init ledger"): this {
    mkdirSync(this.dir, { recursive: true });
    const fresh = !this.initialized;
    if (fresh) this.git(["init", "-q"]);
    for (const [name, text] of Object.entries(seed)) {
      const target = join(this.dir, name);
      if (existsSync(target)) continue;
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, text);
    }
    if (fresh) this.commit(message);
    return this;
  }

  /**
   * Stage everything except lock files and commit. Returns the new HEAD sha, or
   * null when there was nothing to commit. Lock files are excluded here as well as
   * in `.gitignore`, because ledgers seeded before `.lock*` was ignored still list
   * only `.lock`, and a competing process's transient lock file must never be staged.
   * The review pipeline log's rotated generation is excluded for the same reason:
   * ledgers seeded before it existed do not ignore it.
   */
  commit(message: string): string | null {
    this.git(["add", "-A", "--", ".", ":(exclude).lock*", ":(exclude)raw/.pipeline.1.log"]);
    const result = this.git(["commit", "-q", "--no-gpg-sign", "-m", message]);
    if (result.code !== 0) return null;
    return this.head();
  }

  head(): string | null {
    const result = this.git(["rev-parse", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  /**
   * What a `--to` that names no commit is told. A revision has no "nearest"
   * spelling worth computing, so the candidates are the commits a rollback
   * most often wants: the latest three, newest first.
   */
  unknownRevision(rev: string): string {
    const recent = this.git(["log", "-3", "--format=%h %s"])
      .stdout.split("\n")
      .filter((line) => line.trim() !== "");
    return `unknown revision ${rev}; ${recent.length === 0 ? "the ledger has no commits" : `latest: ${recent.join("; ")}`}`;
  }

  /** `git revert --no-edit <sha>`. Returns false on conflict, after aborting the revert. */
  revert(sha: string): boolean {
    const result = this.git(["revert", "--no-edit", "--no-gpg-sign", sha]);
    if (result.code === 0) return true;
    this.git(["revert", "--abort"]);
    return false;
  }

  /**
   * Take the ledger's exclusive lock without waiting. Returns a release
   * function, or null when another live run holds it; the loser exits quietly.
   *
   * The lock file carries the holder's pid. A lock whose pid is no longer alive
   * is stale and is taken over, which is what a crashed job leaves behind.
   */
  tryLock(name = ".lock"): (() => void) | null {
    mkdirSync(this.dir, { recursive: true });
    return acquireLock(join(this.dir, name));
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** An unparseable lock younger than this may still be settling; older, it is stale. */
const UNPARSEABLE_GRACE_MS = 30_000;

function readLock(path: string): { text: string; mtimeMs: number } | null {
  try {
    return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Take the lock at `path`, or return null when someone else holds it.
 *
 * The pid is written to a private file first and then hard-linked into place,
 * so the lock path never exists empty: a crash or a full disk leaves at most a
 * stray private file, never a lock nobody can read. A lock whose holder is dead,
 * or whose contents are not a pid and are older than a grace period (left by an
 * older version), is stale and is taken over.
 */
export function acquireLock(path: string): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const own = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let linked = false;
    try {
      writeFileSync(own, String(process.pid));
      linkSync(own, path);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        rmSync(own, { force: true });
        throw error;
      }
    } finally {
      rmSync(own, { force: true });
    }
    if (linked) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(path, { force: true });
      };
    }

    const seen = readLock(path);
    // Vanished between our link and our read: try again.
    if (seen === null) continue;
    const holder = /^\d+$/.test(seen.text.trim()) ? Number.parseInt(seen.text.trim(), 10) : null;
    if (holder !== null && alive(holder)) return null;
    if (holder === null && Date.now() - seen.mtimeMs < UNPARSEABLE_GRACE_MS) return null;
    // Take the stale lock over by renaming it aside, never by deleting the path:
    // two processes that both judged it stale would otherwise each delete
    // whatever lock is there, including the one the other just created.
    const aside = `${path}.stale-${process.pid}-${Date.now()}`;
    try {
      renameSync(path, aside);
    } catch {
      return null;
    }
    const moved = readLock(aside);
    if (moved === null || moved.text !== seen.text || moved.mtimeMs !== seen.mtimeMs) {
      // What was moved is not the lock judged stale: put it back and stand down.
      try {
        linkSync(aside, path);
      } catch {
        // Someone holds the path again; theirs stands.
      }
      rmSync(aside, { force: true });
      return null;
    }
    rmSync(aside, { force: true });
  }
  return null;
}
