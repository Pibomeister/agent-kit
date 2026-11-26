/**
 * The git facts `ak review scope` compares (ADR-0018): the pull request at a
 * head, and the pull request at a new head against the one at the last
 * reviewed head.
 *
 * Every diff here has no context lines, so a change beside the pull request's
 * lines on the base branch is not a change to the pull request. Renames are
 * not detected, user diff drivers do not run, gitlinks are not ignored, and the
 * algorithm is fixed, so two machines read the same patch from the same commits.
 * Empty is the raw tree: the same path, mode and blob at both heads, no novel
 * non-merge commit in previous..head excluding base, and no two-parent merge
 * whose tree is not the isolated merge-tree of its parents. A commit is novel
 * unless it is empty or its patch is a reviewed own commit's or the reviewed
 * pull request's. The changed-line patch id is only for rewritten-commit
 * matching.
 *
 * This file changes no work tree, index or ref of the author's repository.
 * Merge-tree runs in a throwaway GIT_DIR. It needs git 2.38 or later.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gitProcess,
  isolatedGitArgv,
  isolatedGitEnv,
  resolveRunnerGit,
  withThrowawayObjectStore,
  type RunnerGitContext,
} from "../runner/snapshot.ts";
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

/**
 * `--full-index` fills patch `index` lines; `--no-abbrev` keeps `--raw` blob
 * ids full. `-z` is what keeps paths unquoted: `core.quotePath=false` still
 * quotes `"`, `\\` and newline.
 */
const RAW = [
  "--raw",
  "-z",
  "--no-renames",
  "--no-ext-diff",
  "--full-index",
  "--no-abbrev",
  "--ignore-submodules=none",
] as const;
const RAW_ROW = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/;

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

/**
 * NUL-separated `--raw -z` records: header, path, and a dest path for rename or copy.
 * `-z` replaces the tab-separated path, it does not keep it.
 */
function parseRaw(text: string): RawRow[] {
  const rows: RawRow[] = [];
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec === undefined || rec === "") continue;
    const match = RAW_ROW.exec(rec);
    if (match === null) continue;
    const [, srcMode, dstMode, srcSha, dstSha, status] = match;
    i += 1;
    const path = parts[i];
    if (
      srcMode === undefined ||
      dstMode === undefined ||
      srcSha === undefined ||
      dstSha === undefined ||
      status === undefined ||
      path === undefined ||
      path === ""
    )
      continue;
    let result = path;
    if (status.startsWith("R") || status.startsWith("C")) {
      i += 1;
      const dest = parts[i];
      if (dest !== undefined && dest !== "") result = dest;
    }
    rows.push({ srcMode, dstMode, srcSha, dstSha, status, path: result });
  }
  return rows;
}

function rawRows(repo: string, from: string, to: string): RawRow[] {
  return parseRaw(git(repo, ["diff", ...RAW, from, to]).out);
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
  const context = resolveRunnerGit(repo);
  const run = spawnSync(
    context.binary,
    ["--no-replace-objects", "-C", repo, ...isolatedGitArgv(repo, ["-c", "core.quotePath=false", ...args])],
    {
      cwd: repo,
      env: isolatedGitEnv(context.path, context.home),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    },
  );
  if (run.error !== undefined) throw new Error(`git ${args[0] ?? ""} did not run: ${run.error.message}`);
  if (run.status === null || !statuses.includes(run.status))
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr.trim()}`);
  return { status: run.status, out: run.stdout };
}

/** The full id of the commit `revision` names. `role` says what the revision is, for the error. */
export function resolveCommit(repo: string, revision: string, role: string): string {
  const run = git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`], [0, 1]);
  const id = run.out.trim();
  if (run.status !== 0 || id === "") throw new Error(`${role} ${revision} is not a commit in this repository`);
  return id;
}

function mergeBase(repo: string, base: string, head: string): string {
  const run = git(repo, ["merge-base", base, head], [0, 1]);
  const id = run.out.trim().split("\n")[0] ?? "";
  if (run.status !== 0 || id === "") throw new Error("refusing to merge unrelated histories");
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

/** Patch of a non-merge commit against its parent. A missing parent is a novel commit. */
function commitPatch(repo: string, commit: string): Patch | null {
  const run = git(repo, ["diff", ...DIFF, `${commit}^`, commit], [0, 1, 128]);
  if (run.status === 128) return null;
  return readPatch(run.out);
}

interface NovelInspection {
  novel: boolean;
  paths: string[];
  lines: number;
}

/**
 * Whether `head` has a non-merge commit that is not on `base`, is not an
 * ancestor of `previous`, and is neither empty nor a patch a reviewed own
 * commit or the reviewed pull request already had. Carry is then false even
 * if the result trees match. `paths` and `lines` are that commit versus its
 * parent, so a closure seat still sees the hidden work.
 */
function novelNonMerge(
  repo: string,
  base: string,
  previous: string,
  head: string,
  reviewedFrom: string,
  reviewedPatchId: string,
): NovelInspection {
  const known = new Set(ownCommits(repo, reviewedFrom, previous).map(({ patch }) => patch.id));
  known.add(reviewedPatchId);
  const paths = new Set<string>();
  let lines = 0;
  let novel = false;
  for (const commit of git(repo, ["rev-list", "--no-merges", `${previous}..${head}`, "--not", base]).out.split("\n")) {
    if (commit === "") continue;
    const patch = commitPatch(repo, commit);
    if (patch === null) {
      novel = true;
      continue;
    }
    if (patch.lines === 0) continue;
    if (!known.has(patch.id)) {
      novel = true;
      for (const path of changedPaths(repo, `${commit}^`, commit)) paths.add(path);
      lines += patch.lines;
    }
  }
  return { novel, paths: [...paths].toSorted(), lines };
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
 * Paths in which a merge that is new at `head` had a conflict, and whether a
 * two-parent merge recorded a tree that is not the isolated merge-tree of its
 * parents.
 *
 * A merge is new when `head` reaches it and neither the last reviewed head nor
 * the base branch does. So the pull request's own history made it, and a path
 * that conflicts in it is one the pull request's commits changed. Each merge is
 * repeated from its two parents. A merge of more than two parents is treated as
 * conflicted even when its tree equals the first parent. A two-parent merge
 * whose tree is not merge-tree's is novel: the dirty tree is only on the merge.
 */
interface PathLines {
  path: string;
  lines: number;
  mode: string;
  sha: string;
}

function blobKey(mode: string, sha: string): string {
  return `${mode} ${sha}`;
}

interface MergeInspection {
  conflict_paths: string[];
  novel_merge: boolean;
  novel_paths: string[];
  novel_path_lines: PathLines[];
}

interface ThrowawayDiff {
  paths: string[];
  path_lines: PathLines[];
}

function decode(stdout: Uint8Array): string {
  return new TextDecoder().decode(stdout);
}

function isZeroOid(sha: string): boolean {
  return sha === "" || /^0+$/.test(sha);
}

/** Prefer the recorded (`from`) side of a `--raw` row. */
function recordedBlob(row: RawRow) {
  if (!isZeroOid(row.srcSha)) return { mode: row.srcMode, sha: row.srcSha };
  return { mode: row.dstMode, sha: row.dstSha };
}

function emptyBlob(context: RunnerGitContext, repo: string, extraEnv: NodeJS.ProcessEnv): string {
  const run = gitProcess(
    context,
    repo,
    ["hash-object", "-w", "-t", "blob", "--stdin"],
    10_000,
    new Uint8Array(),
    extraEnv,
  );
  if (run.code !== 0 || run.text === "") throw new Error(`git hash-object failed: ${run.stderr}`);
  return run.text;
}

const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
type ObjectKind = "zero" | "missing" | "blob" | "tree" | "commit" | "tag";

function parseBatchCheck(text: string): Map<string, ObjectKind> {
  const types = new Map<string, ObjectKind>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.endsWith(" missing")) {
      const sha = line.slice(0, -" missing".length);
      if (sha !== "") types.set(sha, "missing");
      continue;
    }
    const [sha, type] = line.split(" ");
    if (sha === undefined || type === undefined) continue;
    if (type === "blob" || type === "tree" || type === "commit" || type === "tag") types.set(sha, type);
  }
  return types;
}

function objectKind(sha: string, types: Map<string, ObjectKind>): ObjectKind {
  if (isZeroOid(sha)) return "zero";
  return types.get(sha) ?? "missing";
}

function isGitlinkKind(kind: ObjectKind): boolean {
  return kind === "commit" || kind === "tree";
}

/** One `cat-file --batch-check` for every non-zero id in `rows`. */
function objectTypes(
  context: RunnerGitContext,
  repo: string,
  extraEnv: NodeJS.ProcessEnv,
  rows: readonly RawRow[],
): Map<string, ObjectKind> {
  const ids = [
    ...new Set(rows.flatMap((row) => [row.srcSha, row.dstSha]).filter((sha) => !isZeroOid(sha) && OBJECT_ID.test(sha))),
  ];
  if (ids.length === 0) return new Map();
  const run = gitProcess(
    context,
    repo,
    ["cat-file", "--batch-check"],
    10_000,
    new TextEncoder().encode(`${ids.join("\n")}\n`),
    extraEnv,
  );
  if (run.code !== 0) throw new Error(`git cat-file failed: ${run.stderr}`);
  return parseBatchCheck(decode(run.stdout));
}

/**
 * Changed lines of two blob object ids. The argv is only those two ids, so a
 * parsed path cannot become a pathspec.
 */
function diffBlobPair(
  context: RunnerGitContext,
  repo: string,
  extraEnv: NodeJS.ProcessEnv,
  from: string,
  to: string,
): number {
  if (!OBJECT_ID.test(from) || !OBJECT_ID.test(to)) throw new Error("git diff of blobs needs two object ids");
  const patch = gitProcess(
    context,
    repo,
    ["-c", "diff.ignoreSubmodules=all", "diff", ...DIFF, "--end-of-options", from, to],
    10_000,
    undefined,
    extraEnv,
  );
  if (patch.code !== 0 && patch.code !== 1) throw new Error(`git diff failed: ${patch.stderr}`);
  return readPatch(decode(patch.stdout)).lines;
}

/**
 * Changed lines of one `--raw` row from the objects' real types. The parsed
 * path is display-only. A commit or tree (a real gitlink) counts as one line,
 * including a gitlink to a missing commit. A missing blob throws. A hunkless
 * empty add or delete counts as one line. Equal blob ids with different modes
 * count as one line.
 */
function blobPairLines(
  context: RunnerGitContext,
  repo: string,
  extraEnv: NodeJS.ProcessEnv,
  empty: string,
  types: Map<string, ObjectKind>,
  row: RawRow,
): number {
  const srcKind = objectKind(row.srcSha, types);
  const dstKind = objectKind(row.dstSha, types);
  if (srcKind === "missing" || dstKind === "missing") {
    if (srcKind === "blob" || dstKind === "blob") {
      const sha = srcKind === "missing" ? row.srcSha : row.dstSha;
      throw new Error(`missing blob ${sha}`);
    }
    return 1;
  }
  if (isGitlinkKind(srcKind) || isGitlinkKind(dstKind) || srcKind === "tag" || dstKind === "tag") return 1;
  const from = srcKind === "zero" ? empty : row.srcSha;
  const to = dstKind === "zero" ? empty : row.dstSha;
  if (from === to) return srcKind === "zero" || dstKind === "zero" || row.srcMode !== row.dstMode ? 1 : 0;
  if (row.status.startsWith("T")) {
    const recorded = recordedBlob(row);
    if (isZeroOid(recorded.sha)) return 1;
    return diffBlobPair(context, repo, extraEnv, empty, recorded.sha);
  }
  return diffBlobPair(context, repo, extraEnv, from, to);
}

/**
 * Paths and changed lines of `from` versus `to` inside the throwaway object store.
 * The store is bare, so `.gitmodules ignore=all` is not read. `-c
 * diff.ignoreSubmodules=all` is that setting; `--ignore-submodules=none` is the
 * override that still lists a gitlink. Line counts come from each object's
 * real type, not from the mode bits.
 */
function throwawayDiff(
  context: RunnerGitContext,
  repo: string,
  extraEnv: NodeJS.ProcessEnv,
  from: string,
  to: string,
): ThrowawayDiff {
  const raw = gitProcess(
    context,
    repo,
    ["-c", "core.quotePath=false", "-c", "diff.ignoreSubmodules=all", "diff", ...RAW, "--end-of-options", from, to],
    10_000,
    undefined,
    extraEnv,
  );
  if (raw.code !== 0 && raw.code !== 1) throw new Error(`git diff failed: ${raw.stderr}`);
  const rows = parseRaw(decode(raw.stdout));
  const empty = emptyBlob(context, repo, extraEnv);
  const types = objectTypes(context, repo, extraEnv, rows);
  const paths = rows.map((row) => row.path);
  const path_lines: PathLines[] = [];
  for (const row of rows) {
    const { mode, sha } = recordedBlob(row);
    path_lines.push({
      path: row.path,
      lines: blobPairLines(context, repo, extraEnv, empty, types, row),
      mode,
      sha,
    });
  }
  return { paths, path_lines };
}

function inspectMerges(repo: string, base: string, previous: string, head: string): MergeInspection {
  const merges = git(repo, ["rev-list", "--merges", head, `^${previous}`, `^${base}`]).out.split("\n");
  const conflicted = new Set<string>();
  const novelPaths = new Set<string>();
  const byBlob = new Map<string, PathLines>();
  const pairs: { merge: string; ours: string; theirs: string }[] = [];
  let novel_merge = false;
  for (const merge of merges) {
    if (merge === "") continue;
    const parents = git(repo, ["rev-list", "--parents", "-n", "1", merge]).out.trim().split(" ").slice(1);
    const [ours, theirs] = parents;
    if (parents.length > 2) {
      const before = conflicted.size;
      const first = parents[0];
      if (first !== undefined) {
        const names = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", first, merge]).out;
        for (const path of names.split("\0")) if (path !== "") conflicted.add(path);
      }
      if (conflicted.size === before) conflicted.add(".");
      continue;
    }
    if (parents.length !== 2 || ours === undefined || theirs === undefined) continue;
    pairs.push({ merge, ours, theirs });
  }
  if (pairs.length > 0) {
    const home = mkdtempSync(join(tmpdir(), "ak-review-"));
    try {
      const context = { ...resolveRunnerGit(repo), home };
      for (const { merge, ours, theirs } of pairs) {
        const run = withThrowawayObjectStore(context, repo, (extraEnv) => {
          const result = gitProcess(
            context,
            repo,
            ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs],
            10_000,
            undefined,
            extraEnv,
          );
          if (result.code !== 0 && result.code !== 1) throw new Error(`git merge-tree failed: ${result.stderr}`);
          const out = decode(result.stdout);
          const resultTree = out.split("\0")[0]?.trim() ?? "";
          let extra: ThrowawayDiff = { paths: [], path_lines: [] };
          let novel = false;
          if (result.code === 0) {
            const recordedRun = gitProcess(
              context,
              repo,
              ["rev-parse", "--verify", "--end-of-options", `${merge}^{tree}`],
              10_000,
              undefined,
              extraEnv,
            );
            if (recordedRun.code !== 0) throw new Error(`git rev-parse failed: ${recordedRun.stderr}`);
            const recorded = recordedRun.text;
            if (resultTree === "" || resultTree !== recorded) {
              novel = true;
              if (resultTree !== "" && recorded !== "")
                extra = throwawayDiff(context, repo, extraEnv, recorded, resultTree);
            }
          }
          return { code: result.code, out, novel, extra };
        });
        if (run.novel) {
          novel_merge = true;
          for (const path of run.extra.paths) novelPaths.add(path);
          for (const entry of run.extra.path_lines) {
            if (entry.sha === "" || entry.mode === "") continue;
            const key = blobKey(entry.mode, entry.sha);
            if (!byBlob.has(key)) byBlob.set(key, entry);
          }
        }
        if (run.code === 0) continue;
        // The first field is the tree. The rest are the conflicted paths.
        for (const path of run.out.split("\0").slice(1)) if (path !== "") conflicted.add(path);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  const novel_paths = [...novelPaths].toSorted();
  return {
    conflict_paths: [...conflicted].toSorted(),
    novel_merge,
    novel_paths,
    novel_path_lines: [...byBlob.values()],
  };
}

/** Paths `git diff --name-only` names between two commits, sorted. */
function changedPaths(repo: string, previous: string, head: string): string[] {
  return git(repo, [
    "diff",
    "--name-only",
    "--no-renames",
    "--ignore-submodules=none",
    "-z",
    "--end-of-options",
    `${previous}..${head}`,
  ])
    .out.split("\0")
    .filter((path) => path.length > 0)
    .toSorted();
}

export interface DeltaReading {
  now: HeadReading;
  previous: HeadReading;
  delta: DeltaFacts;
}

/**
 * Compare the pull request at `head` with the pull request at `previous`, the
 * last reviewed head. All three revisions are full commit ids. Every hidden
 * blob a novel merge introduced counts once unless that exact (mode, sha) is in
 * the result tree; empty-file blob sharing, a mode-only chmod, and the same
 * blob at two paths are not special-cased (the path still appears in
 * changed_paths). A same-blob mode or type change counts as one line. Line
 * counts use the objects' real types, not the mode bits. A path parsed from
 * git output is display-only and is never fed back to git.
 */
export function readDelta(repo: string, base: string, previous: string, head: string): DeltaReading {
  if (previous !== base && mergeBase(repo, base, previous) === previous)
    throw new Error(
      `the last reviewed head ${previous} is an ancestor of base ${base}: it is not a comparison base of this pull request`,
    );
  const before = headPatch(repo, base, previous);
  const now = headPatch(repo, base, head);
  const beforeTree = treeOf(rawRows(repo, before.reading.merge_base, previous));
  const nowTree = treeOf(rawRows(repo, now.reading.merge_base, head));
  const identical = sameTree(beforeTree, nowTree);
  const merges = inspectMerges(repo, base, previous, head);
  const nonMerges = novelNonMerge(repo, base, previous, head, before.reading.merge_base, before.patch.id);
  const empty = identical && !merges.novel_merge && !nonMerges.novel;
  const novelPaths = [...new Set([...merges.novel_paths, ...nonMerges.paths])].toSorted();
  const visiblePaths = identical ? [] : changedPaths(repo, previous, head);
  const nowBlobs = new Set([...nowTree.values()].map((entry) => blobKey(entry.mode, entry.sha)));
  const countedBlobs = new Set<string>();
  let hiddenMergeLines = 0;
  for (const { mode, sha, lines } of merges.novel_path_lines) {
    const key = blobKey(mode, sha);
    if (sha === "" || nowBlobs.has(key) || countedBlobs.has(key)) continue;
    countedBlobs.add(key);
    hiddenMergeLines += lines;
  }
  return {
    now: now.reading,
    previous: before.reading,
    delta: {
      empty,
      pr_lines: before.patch.lines,
      added_lines: identical ? (empty ? 0 : hiddenMergeLines) : linesNotIn(now.patch, before.patch) + hiddenMergeLines,
      removed_lines: linesNotIn(before.patch, now.patch),
      rewritten_lines: linesRewritten(repo, base, before, now.reading, head),
      conflict_paths: merges.conflict_paths,
      path_identity: pathIdentity(beforeTree, nowTree),
      changed_paths: empty ? [] : [...new Set([...visiblePaths, ...novelPaths])].toSorted(),
    },
  };
}
