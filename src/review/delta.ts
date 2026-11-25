/**
 * The git facts `ak review scope` compares (ADR-0018): the pull request at a
 * head, and the pull request at a new head against the one at the last
 * reviewed head.
 *
 * Every diff here has no context lines, so a change beside the pull request's
 * lines on the base branch is not a change to the pull request. Renames are
 * not detected, user diff drivers do not run, gitlinks are not ignored, and the
 * algorithm is fixed, so two machines read the same patch from the same commits.
 * Empty is the raw tree: the same path, mode and blob at both heads. The
 * changed-line patch id is only for rewritten-commit matching.
 *
 * This file changes no work tree, index or ref. `git merge-tree` writes the
 * objects of each merge it repeats into the object store, as unreachable
 * objects. It needs git 2.38 or later.
 */

import { spawnSync } from "node:child_process";

import { isolatedGitEnv } from "../runner/snapshot.ts";
import { linesNotIn, readPatch, type DeltaFacts, type Patch } from "./scope.ts";

const DIFF = [
  "-U0",
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--full-index",
  "--ignore-submodules=none",
  "--submodule=short",
  "--diff-algorithm=myers",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

const RAW = ["--raw", "--no-renames", "--no-ext-diff", "--full-index", "--ignore-submodules=none"] as const;
const RAW_ROW = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)\t(.*)$/;

interface TreeEntry {
  mode: string;
  sha: string;
}

interface RawRow {
  srcMode: string;
  dstMode: string;
  srcSha: string;
  dstSha: string;
  status: string;
  path: string;
}

function rawRows(repo: string, from: string, to: string): RawRow[] {
  const rows: RawRow[] = [];
  for (const line of git(repo, ["diff", ...RAW, from, to]).out.split("\n")) {
    if (line === "") continue;
    const match = RAW_ROW.exec(line);
    if (match === null) continue;
    const [, srcMode, dstMode, srcSha, dstSha, status, path] = match;
    if (
      srcMode === undefined ||
      dstMode === undefined ||
      srcSha === undefined ||
      dstSha === undefined ||
      status === undefined ||
      path === undefined
    )
      continue;
    rows.push({ srcMode, dstMode, srcSha, dstSha, status, path });
  }
  return rows;
}

/** The resulting path, mode and blob of a pull request diff. Deleted paths are absent. */
function treeOf(rows: readonly RawRow[]): Map<string, TreeEntry> {
  const tree = new Map<string, TreeEntry>();
  for (const row of rows) {
    if (row.status.startsWith("D")) tree.delete(row.path);
    else tree.set(row.path, { mode: row.dstMode, sha: row.dstSha });
  }
  return tree;
}

function sameTree(left: Map<string, TreeEntry>, right: Map<string, TreeEntry>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, entry] of left) {
    const other = right.get(path);
    if (other === undefined || other.mode !== entry.mode || other.sha !== entry.sha) return false;
  }
  return true;
}

/** Paths that changed as a gitlink, or as a same-blob add and delete, between two result trees. */
function pathIdentity(before: Map<string, TreeEntry>, now: Map<string, TreeEntry>): string[] {
  const paths = new Set([...before.keys(), ...now.keys()]);
  const hits = new Set<string>();
  for (const path of paths) {
    const left = before.get(path);
    const right = now.get(path);
    const gitlink = left?.mode === "160000" || right?.mode === "160000";
    if (gitlink && (left?.mode !== right?.mode || left?.sha !== right?.sha)) hits.add(path);
  }
  const gone = [...before.entries()].filter(([path]) => !now.has(path));
  const came = [...now.entries()].filter(([path]) => !before.has(path));
  for (const [from, left] of gone) {
    if (left.sha === "0".repeat(left.sha.length)) continue;
    for (const [to, right] of came) {
      if (left.sha === right.sha) {
        hits.add(from);
        hits.add(to);
      }
    }
  }
  return [...hits].toSorted();
}

/** Run git in `repo` and return what it printed. A status outside `statuses` is an error. */
function git(repo: string, args: readonly string[], statuses: readonly number[] = [0]) {
  const run = spawnSync("git", ["--no-replace-objects", "-C", repo, "-c", "core.quotePath=false", ...args], {
    cwd: repo,
    env: isolatedGitEnv(),
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

/** Each own commit of a head, oldest first: every commit after the merge base that is not a merge. */
function ownCommits(repo: string, from: string, head: string): { commit: string; patch: Patch }[] {
  const log = git(repo, ["log", "--reverse", "--no-merges", "--format=%x00%H", "-p", ...DIFF, `${from}..${head}`]).out;
  return log
    .split("\0")
    .slice(1)
    .map((entry) => {
      const end = entry.indexOf("\n");
      return { commit: entry.slice(0, end), patch: readPatch(entry.slice(end + 1)) };
    });
}

/**
 * Changed lines that a rewrite changed, as `DeltaFacts.rewritten_lines` states.
 *
 * A commit of the new head is reviewed work when a reviewed commit has its
 * patch, or when the pull request at the last reviewed head holds at least
 * half of its changed lines. The pull request is read again at the last such
 * commit, the cut, from the cut's own merge base, and compared with the
 * reviewed one as a whole, so a line added and removed again nets to nothing
 * and a squash or a reword moves no line. With no reviewed work at the new
 * head, the pull request at the cut is empty.
 */
function linesRewritten(repo: string, base: string, reviewed: HeadPatch, now: HeadReading, head: string): number {
  const older = ownCommits(repo, reviewed.reading.merge_base, reviewed.reading.head);
  const newer = ownCommits(repo, now.merge_base, head);
  const kept = new Set(newer.map(({ patch }) => patch.id));
  if (older.every(({ patch }) => kept.has(patch.id))) return 0;
  const held = new Set(older.map(({ patch }) => patch.id));
  const old = reviewed.patch;
  const work = newer.filter(
    ({ patch }) => held.has(patch.id) || (patch.lines > 0 && 2 * (patch.lines - linesNotIn(patch, old)) >= patch.lines),
  );
  const cut = work.at(-1)?.commit;
  const atCut = cut === undefined ? readPatch("") : headPatch(repo, base, cut).patch;
  return Math.max(linesNotIn(old, atCut), linesNotIn(atCut, old));
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
  if (previous !== head) {
    const fromPrevious = mergeBase(repo, base, previous);
    const fromHead = mergeBase(repo, base, head);
    if (fromPrevious === previous && fromHead === head)
      throw new Error(
        `base ${base} is reachable from ${previous} and from ${head}: it is not a comparison base of this pull request`,
      );
  }
  const before = headPatch(repo, base, previous);
  const now = headPatch(repo, base, head);
  const beforeTree = treeOf(rawRows(repo, before.reading.merge_base, previous));
  const nowTree = treeOf(rawRows(repo, now.reading.merge_base, head));
  return {
    now: now.reading,
    previous: before.reading,
    delta: {
      empty: sameTree(beforeTree, nowTree),
      pr_lines: before.patch.lines,
      added_lines: linesNotIn(now.patch, before.patch),
      removed_lines: linesNotIn(before.patch, now.patch),
      rewritten_lines: linesRewritten(repo, base, before, now.reading, head),
      conflict_paths: conflictPaths(repo, base, previous, head),
      path_identity: pathIdentity(beforeTree, nowTree),
    },
  };
}
