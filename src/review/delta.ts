/**
 * The git facts `ak review scope` compares (ADR-0018): the pull request at a
 * head, and the pull request at a new head against the one at the last
 * reviewed head.
 *
 * Every diff here has no context lines, so a change beside the pull request's
 * lines on the base branch is not a change to the pull request. Renames are
 * not detected, user diff drivers do not run and the algorithm is fixed, so two
 * machines read the same patch from the same commits.
 *
 * This file changes no work tree, index or ref. `git merge-tree` writes the
 * objects of each merge it repeats into the object store, as unreachable
 * objects. It needs git 2.38 or later.
 */

import { spawnSync } from "node:child_process";

import { linesNotIn, linesRewritten, readPatch, type DeltaFacts, type OwnCommit, type Patch } from "./scope.ts";

const DIFF = [
  "-U0",
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--full-index",
  "--diff-algorithm=myers",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/** Run git in `repo` and return what it printed. A status outside `statuses` is an error. */
function git(repo: string, args: readonly string[], statuses: readonly number[] = [0]) {
  const run = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (run.error !== undefined) throw new Error(`git ${args[0] ?? ""} did not run: ${run.error.message}`);
  if (run.status === null || !statuses.includes(run.status))
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr.trim()}`);
  return { status: run.status, out: run.stdout };
}

/** The full id of the commit `revision` names. `role` says what the revision is, for the error. */
export function resolveCommit(repo: string, revision: string, role: string): string {
  const run = git(repo, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], [0, 1]);
  const id = run.out.trim();
  if (run.status !== 0 || id === "") throw new Error(`${role} ${revision} is not a commit in this repository`);
  return id;
}

function mergeBase(repo: string, base: string, head: string): string {
  const run = git(repo, ["merge-base", base, head], [0, 1]);
  const id = run.out.trim().split("\n")[0] ?? "";
  if (run.status !== 0 || id === "") throw new Error(`${base} and ${head} share no commit`);
  return id;
}

/** The pull request at one head: what its commits change against the merge base with the base branch. */
export interface HeadReading {
  head: string;
  merge_base: string;
  patch_id: string;
  /** Changed lines of the pull request. */
  lines: number;
}

interface HeadPatch {
  reading: HeadReading;
  patch: Patch;
}

function headPatch(repo: string, base: string, head: string): HeadPatch {
  const from = mergeBase(repo, base, head);
  const patch = readPatch(git(repo, ["diff", ...DIFF, from, head]).out);
  return { reading: { head, merge_base: from, patch_id: patch.id, lines: patch.lines }, patch };
}

/** Read the pull request at `head`. `base` and `head` are full commit ids. */
export function readHead(repo: string, base: string, head: string): HeadReading {
  return headPatch(repo, base, head).reading;
}

/** Each own commit of a head: every commit after the merge base that is not a merge. */
function ownCommits(repo: string, from: string, head: string): OwnCommit[] {
  const log = git(repo, ["log", "--no-merges", "--format=%x00%s", "-p", ...DIFF, `${from}..${head}`]).out;
  return log
    .split("\0")
    .slice(1)
    .map((entry) => {
      const end = entry.indexOf("\n");
      return { subject: entry.slice(0, end), patch: readPatch(entry.slice(end + 1)) };
    });
}

/**
 * Paths in which a merge that is new at `head` had a conflict.
 *
 * A merge is new when `head` reaches it and neither the last reviewed head nor
 * the base branch does. So the pull request's own history made it, and a path
 * that conflicts in it is one the pull request's commits changed. Each merge is
 * repeated from its two parents. A merge of more than two parents is skipped:
 * git makes one only where nothing conflicts.
 */
function conflictPaths(repo: string, base: string, previous: string, head: string): string[] {
  const merges = git(repo, ["rev-list", "--merges", head, `^${previous}`, `^${base}`]).out.split("\n");
  const conflicted = new Set<string>();
  for (const merge of merges) {
    if (merge === "") continue;
    const parents = git(repo, ["rev-list", "--parents", "-n", "1", merge]).out.trim().split(" ").slice(1);
    const [ours, theirs] = parents;
    if (parents.length !== 2 || ours === undefined || theirs === undefined) continue;
    const run = git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs], [0, 1]);
    if (run.status === 0) continue;
    // The first field is the tree. The rest are the conflicted paths.
    for (const path of run.out.split("\0").slice(1)) if (path !== "") conflicted.add(path);
  }
  return [...conflicted].toSorted();
}

export interface DeltaReading {
  now: HeadReading;
  previous: HeadReading;
  delta: DeltaFacts;
}

/**
 * Compare the pull request at `head` with the pull request at `previous`, the
 * last reviewed head. All three revisions are full commit ids.
 */
export function readDelta(repo: string, base: string, previous: string, head: string): DeltaReading {
  const before = headPatch(repo, base, previous);
  const now = headPatch(repo, base, head);
  // An own commit of the last reviewed head is rewritten when no own commit of the new head has its patch.
  const older = ownCommits(repo, before.reading.merge_base, previous);
  const newer = ownCommits(repo, now.reading.merge_base, head);
  const kept = new Set(newer.map((commit) => commit.patch.id));
  const held = new Set(older.map((commit) => commit.patch.id));
  const rewritten = older.filter((commit) => !kept.has(commit.patch.id));
  const rewrites = newer.filter((commit) => !held.has(commit.patch.id));
  return {
    now: now.reading,
    previous: before.reading,
    delta: {
      empty: before.patch.id === now.patch.id,
      pr_lines: before.patch.lines,
      added_lines: linesNotIn(now.patch, before.patch),
      removed_lines: linesNotIn(before.patch, now.patch),
      rewritten_lines: linesRewritten(rewritten, rewrites),
      conflict_paths: conflictPaths(repo, base, previous, head),
    },
  };
}
