/** Raw runner snapshots avoid worker-configured Git hooks, filters and text conversion. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { GitResult, Snapshot } from "../lifecycle/gate.ts";
import { relativeInsideRoot, workerControlledPath, workerFreePath } from "./path.ts";

export interface RunnerGitContext {
  binary: string;
  path: string;
  workerRoot: string;
  home: string;
  gitDir?: string;
  workTree?: string;
  pinnedGitKind?: "directory" | "file" | "symlink" | "missing";
}

interface RepoLayout {
  gitDir: string;
  workTree: string;
}

const LAYOUT_CHANGED = "git layout changed since start";
const REALPATH_HOPS = 32;

function parseGitFile(filePath: string): string | undefined {
  const pointer = /^gitdir: (.+)$/.exec(readFileSync(filePath, "utf8").trim())?.[1];
  if (pointer === undefined) return undefined;
  return isAbsolute(pointer) ? pointer : resolve(dirname(filePath), pointer);
}

function boundedResolve(path: string): string | undefined {
  let current = path;
  const seen = new Set<string>();
  for (let hop = 0; hop < REALPATH_HOPS; hop++) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return undefined;
    }
    if (!stat.isSymbolicLink()) {
      try {
        return realpathSync(current);
      } catch {
        return undefined;
      }
    }
    const next = readlinkSync(current);
    current = isAbsolute(next) ? next : resolve(dirname(current), next);
  }
  return undefined;
}

function workTreeOf(gitDir: string, foundAt: string, gitfile: boolean): string {
  if (!gitfile) return realpathSync(foundAt);
  try {
    const pointed = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
    if (pointed !== "") {
      const marker = isAbsolute(pointed) ? pointed : resolve(gitDir, pointed);
      return realpathSync(dirname(marker));
    }
  } catch {
    // Linked-worktree git dirs carry gitdir; absorbed modules carry commondir.
  }
  try {
    readFileSync(join(gitDir, "commondir"), "utf8");
    return realpathSync(foundAt);
  } catch {
    if (basename(gitDir) === ".git") return realpathSync(dirname(gitDir));
    return realpathSync(foundAt);
  }
}

function layoutAt(dir: string): RepoLayout | undefined {
  const entryPath = join(dir, ".git");
  let entry;
  try {
    entry = lstatSync(entryPath);
  } catch {
    return undefined;
  }
  if (entry.isFIFO() || entry.isSocket()) return undefined;
  let gitDir: string;
  let gitfile = false;
  if (entry.isSymbolicLink()) {
    const target = boundedResolve(entryPath);
    if (target === undefined) return undefined;
    let dest;
    try {
      dest = lstatSync(target);
    } catch {
      return undefined;
    }
    if (dest.isDirectory()) gitDir = realpathSync(target);
    else if (dest.isFile() && dest.size <= 4096) {
      const pointer = parseGitFile(target);
      if (pointer === undefined) return undefined;
      gitDir = realpathSync(pointer);
      gitfile = true;
    } else return undefined;
  } else if (entry.isDirectory()) gitDir = realpathSync(entryPath);
  else if (entry.isFile() && entry.size <= 4096) {
    const pointer = parseGitFile(entryPath);
    if (pointer === undefined) return undefined;
    gitDir = realpathSync(pointer);
    gitfile = true;
  } else return undefined;
  return { gitDir, workTree: workTreeOf(gitDir, dir, gitfile) };
}

function ownsDirectory(layout: RepoLayout, dir: string): boolean {
  try {
    return layout.workTree === realpathSync(dir);
  } catch {
    return false;
  }
}

function resolveLayout(start: string): RepoLayout | undefined {
  let dir = realpathSync(start);
  for (;;) {
    const layout = layoutAt(dir);
    if (layout !== undefined && ownsDirectory(layout, dir)) return layout;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function repoCommonDir(gitDir: string): string {
  try {
    const text = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (text !== "") return realpathSync(isAbsolute(text) ? text : resolve(gitDir, text));
  } catch {
    // Main git directories have no commondir file.
  }
  return gitDir;
}

function isAbsorbedGitlink(context: RunnerGitContext, gitDir: string): boolean {
  if (context.gitDir === undefined) return false;
  const modules = join(repoCommonDir(context.gitDir), "modules");
  return gitDir === modules || relativeInsideRoot(relative(modules, gitDir));
}

function selectedRepo(
  context: RunnerGitContext,
  project: string,
  extraEnv?: NodeJS.ProcessEnv,
): RepoLayout | undefined {
  if (extraEnv?.GIT_DIR !== undefined && extraEnv.GIT_DIR !== "") return undefined;
  if (context.gitDir === undefined || context.workTree === undefined) return undefined;
  let dir: string;
  try {
    dir = realpathSync(project);
  } catch {
    return undefined;
  }
  const inside = dir === context.workTree || relativeInsideRoot(relative(context.workTree, dir));
  if (!inside) {
    const own = layoutAt(dir);
    if (own !== undefined && ownsDirectory(own, dir)) return own;
    return undefined;
  }
  if (dir !== context.workTree) {
    const own = layoutAt(dir);
    if (own !== undefined && own.gitDir !== context.gitDir) {
      let gitDirectory = false;
      try {
        gitDirectory = lstatSync(join(dir, ".git")).isDirectory();
      } catch {
        gitDirectory = false;
      }
      if (gitDirectory || isAbsorbedGitlink(context, own.gitDir)) return own;
    }
  }
  return { gitDir: context.gitDir, workTree: context.workTree };
}

function repoPin(context: RunnerGitContext, project: string, extraEnv?: NodeJS.ProcessEnv): string[] {
  const repo = selectedRepo(context, project, extraEnv);
  if (repo === undefined) return [];
  return ["--git-dir", repo.gitDir, "--work-tree", repo.workTree];
}

function pinnedGitKind(workTree: string): RunnerGitContext["pinnedGitKind"] {
  try {
    const entry = lstatSync(join(workTree, ".git"));
    if (entry.isSymbolicLink()) return "symlink";
    if (entry.isDirectory()) return "directory";
    if (entry.isFile()) return "file";
    return "missing";
  } catch {
    return "missing";
  }
}

function assertPinnedLayout(context: RunnerGitContext): void {
  if (context.gitDir === undefined || context.workTree === undefined) return;
  const now = layoutAt(context.workerRoot);
  if (now !== undefined && now.gitDir !== context.gitDir) throw new Error(LAYOUT_CHANGED);
  try {
    const entry = lstatSync(join(context.workTree, ".git"));
    if ((entry.isSymbolicLink() || entry.isFile()) && context.pinnedGitKind === "directory")
      throw new Error(LAYOUT_CHANGED);
  } catch (cause) {
    if (cause instanceof Error && cause.message === LAYOUT_CHANGED) throw cause;
  }
}

export function resolveRunnerGit(workerRoot: string): RunnerGitContext {
  const path = workerFreePath(process.env["PATH"], workerRoot);
  const layout = resolveLayout(workerRoot);
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory, "git");
    try {
      accessSync(candidate, constants.X_OK);
      const binary = realpathSync(candidate);
      if (!workerControlledPath(binary, workerRoot))
        return {
          binary,
          path,
          workerRoot,
          home: "/dev/null",
          gitDir: layout?.gitDir,
          workTree: layout?.workTree,
          pinnedGitKind: layout === undefined ? "missing" : pinnedGitKind(layout.workTree),
        };
    } catch {
      // Try the next supervisor-owned PATH entry.
    }
  }
  throw new Error("runner cannot find a trusted git executable outside the worker root");
}

function failedGit(stderr: string): GitResult {
  return { code: -1, stdout: new Uint8Array(), text: "", stderr };
}

function gitEnv(context: RunnerGitContext): NodeJS.ProcessEnv {
  // Residue: a partial or blobless clone may still promisor-fetch through worker
  // core.sshCommand / credential.helper in the repository config. No refusal.
  return {
    PATH: context.path,
    HOME: context.home,
    XDG_CONFIG_HOME: context.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    LC_ALL: "C",
  };
}

function isolationArgs(project: string): string[] {
  return [
    "-c",
    `safe.directory=${realpathSync(project)}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.excludesFile=/dev/null",
    "-c",
    "diff.relative=false",
    "-c",
    "core.commitGraph=false",
    "-c",
    "advice.graftFileDeprecated=false",
    // Defense-in-depth: throwaway GIT_DIR already ignores worker merge config.
    "-c",
    "merge.default=",
    "-c",
    "merge.renormalize=false",
  ];
}

/** Isolated git argv: worker-owned config is ignored, including the commit graph. */
export function isolatedGitArgv(project: string, args: readonly string[]): string[] {
  return [...isolationArgs(project), ...args];
}

const emptyTrees = new Map<string, string>();

function emptyTreeId(context: RunnerGitContext, project: string, timeoutMs: number): GitResult {
  const key = realpathSync(project);
  const cached = emptyTrees.get(key);
  if (cached !== undefined) return { code: 0, stdout: new Uint8Array(), text: cached, stderr: "" };
  const proc = spawnSync(
    context.binary,
    [...repoPin(context, project), ...isolatedGitArgv(project, ["hash-object", "-t", "tree", "--stdin"])],
    {
      cwd: project,
      env: gitEnv(context),
      input: new Uint8Array(),
      maxBuffer: 1 << 30,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  if (proc.error !== undefined) {
    if ("code" in proc.error && proc.error.code === "ETIMEDOUT")
      return failedGit(`runner git timed out after ${timeoutMs / 1000} seconds`);
    return failedGit(`cannot run isolated git: ${proc.error.message}`);
  }
  const stdout = proc.stdout ?? new Uint8Array();
  const text = new TextDecoder().decode(stdout).trim();
  if ((proc.status ?? -1) !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(text))
    return failedGit(`cannot resolve empty tree: ${(proc.stderr ?? "").toString().trim() || text}`);
  emptyTrees.set(key, text);
  return { code: 0, stdout, text, stderr: "" };
}

export function gitProcess(
  context: RunnerGitContext,
  project: string,
  args: readonly string[],
  timeoutMs = 10_000,
  input?: Uint8Array,
  extraEnv?: NodeJS.ProcessEnv,
  attrTree?: string,
): GitResult {
  let tree = attrTree;
  if (tree === undefined) {
    const empty = emptyTreeId(context, project, timeoutMs);
    if (empty.code !== 0) return empty;
    tree = empty.text;
  }
  const proc = spawnSync(
    context.binary,
    [...repoPin(context, project, extraEnv), ...isolatedGitArgv(project, ["-c", `attr.tree=${tree}`, ...args])],
    {
      cwd: project,
      env: { ...gitEnv(context), ...extraEnv },
      input,
      maxBuffer: 1 << 30,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  if (proc.error !== undefined) {
    if ("code" in proc.error && proc.error.code === "ETIMEDOUT")
      return failedGit(`runner git timed out after ${timeoutMs / 1000} seconds`);
    return failedGit(`cannot run isolated git: ${proc.error.message}`);
  }
  const stdout = proc.stdout ?? new Uint8Array();
  return {
    code: proc.status ?? -1,
    stdout,
    text: new TextDecoder().decode(stdout).trim(),
    stderr: (proc.stderr ?? "").toString().trim(),
  };
}

function checkGitControls(context: RunnerGitContext, project: string): GitResult | null {
  const pinned = selectedRepo(context, project);
  const entryPath = join(project, ".git");
  let paths: string[];
  try {
    if (pinned !== undefined) paths = [join(pinned.gitDir, "index"), join(pinned.gitDir, "HEAD")];
    else {
      const entry = lstatSync(entryPath);
      if (entry.isDirectory()) paths = [join(entryPath, "index"), join(entryPath, "HEAD")];
      else if (entry.isFile() && entry.size <= 4096) {
        const pointer = parseGitFile(entryPath);
        if (pointer === undefined) return failedGit("runner git directory pointer is invalid");
        paths = [join(pointer, "index"), join(pointer, "HEAD")];
      } else {
        const controls = gitProcess(
          context,
          project,
          ["rev-parse", "--git-path", "index", "--git-path", "HEAD"],
          2_000,
        );
        if (controls.code !== 0) return controls;
        paths = controls.text.split("\n");
      }
    }
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT")
      return failedGit("runner cannot inspect git directory entry");
    const controls = gitProcess(context, project, ["rev-parse", "--git-path", "index", "--git-path", "HEAD"], 2_000);
    if (controls.code !== 0) return controls;
    paths = controls.text.split("\n");
  }
  if (paths.length !== 2) return failedGit("runner cannot locate git index and HEAD");
  for (const [index, name] of ["index", "HEAD"].entries()) {
    const path = paths[index];
    if (path === undefined) return failedGit(`runner cannot locate git ${name}`);
    try {
      if (!lstatSync(isAbsolute(path) ? path : resolve(project, path)).isFile())
        return failedGit(`runner git ${name} must be a regular file`);
    } catch (cause) {
      if (name === "index" && cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      return failedGit(`runner cannot inspect git ${name}`);
    }
  }
  return null;
}

export function runnerGit(
  context: RunnerGitContext,
  project: string,
  args: readonly string[],
  input?: Uint8Array,
): GitResult {
  const controls = checkGitControls(context, project);
  if (controls !== null) return controls;
  return gitProcess(context, project, args, 10_000, input);
}

/** Stable identity for the complete committed change relative to its current merge base. */
export function patchIdentity(context: RunnerGitContext, project: string, baseRef: string, head: string) {
  assertPinnedLayout(context);
  const base = runnerGit(context, project, ["merge-base", baseRef, head]);
  if (base.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base.text))
    throw new Error(`cannot resolve verdict base: ${base.stderr || base.text}`);
  const diff = runnerGit(context, project, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--binary",
    "--ignore-submodules=none",
    "--submodule=short",
    base.text,
    head,
    "--",
  ]);
  if (diff.code !== 0) throw new Error(`cannot read committed patch: ${diff.stderr}`);
  if (diff.stdout.length === 0) return null;
  const patch = gitProcess(context, project, ["patch-id", "--stable"], 10_000, diff.stdout);
  const patchId = patch.text.split(" ")[0];
  if (patch.code !== 0 || patchId === undefined || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(patchId))
    throw new Error(`cannot compute stable patch-id: ${patch.stderr || patch.text}`);
  return patchId;
}

/** Only trunk-side CI configuration changes invalidate an otherwise identical patch. */
export function ciConfigDrift(context: RunnerGitContext, project: string, oldBase: string, newBase: string): boolean {
  if (oldBase === newBase) return false;
  assertPinnedLayout(context);
  const converterGuard = ["--no-ext-diff", "--no-textconv", "--no-relative"] as const;
  const changed = runnerGit(context, project, [
    "diff",
    ...converterGuard,
    "--ignore-submodules=none",
    "--submodule=short",
    "--no-renames",
    "--name-only",
    "-z",
    oldBase,
    newBase,
    "--",
  ]);
  if (changed.code !== 0) throw new Error(`cannot compare CI configuration: ${changed.stderr}`);
  const converters = runnerGit(context, project, [
    "diff",
    ...converterGuard,
    "--ignore-submodules=none",
    "--submodule=short",
    "--exit-code",
    oldBase,
    newBase,
    "--",
  ]);
  if (converters.code > 1) throw new Error(`cannot compare CI configuration: ${converters.stderr}`);
  const ciRoots = [".github/workflows", ".github/actions", ".circleci", ".buildkite"];
  const ciFiles = [".gitlab-ci.yml", "azure-pipelines.yml", "Jenkinsfile", "bitbucket-pipelines.yml"];
  return new TextDecoder()
    .decode(changed.stdout)
    .split("\0")
    .some(
      (path) =>
        path !== "" &&
        (ciFiles.includes(path) ||
          ciRoots.some((root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`))),
    );
}

export function mergeTreeClean(context: RunnerGitContext, project: string, baseRef: string, head: string): boolean {
  assertPinnedLayout(context);
  const left = resolvedRevision(context, project, baseRef);
  const right = resolvedRevision(context, project, head);
  const mergeBase = runnerGit(context, project, ["merge-base", left, right]);
  if (mergeBase.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(mergeBase.text))
    throw new Error(`cannot inspect merge tree: ${mergeBase.stderr || mergeBase.text}`);
  const attrTree = runnerGit(context, project, ["rev-parse", `${mergeBase.text}^{tree}`]);
  if (attrTree.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(attrTree.text))
    throw new Error(`cannot inspect merge tree: ${attrTree.stderr || attrTree.text}`);
  const objectFormat = runnerGit(context, project, ["rev-parse", "--show-object-format"]);
  if (objectFormat.code !== 0 || (objectFormat.text !== "sha1" && objectFormat.text !== "sha256"))
    throw new Error(`cannot inspect merge tree: ${objectFormat.stderr || objectFormat.text}`);
  const objects = runnerGit(context, project, ["rev-parse", "--git-path", "objects"]);
  if (objects.code !== 0 || objects.text === "")
    throw new Error(`cannot inspect merge tree: ${objects.stderr || objects.text}`);
  let objectDir: string;
  try {
    objectDir = realpathSync(isAbsolute(objects.text) ? objects.text : resolve(project, objects.text));
  } catch {
    throw new Error("cannot inspect merge tree: cannot resolve object directory");
  }
  const scratch = mkdtempSync(join(context.home, "ak-merge-"));
  try {
    const init = spawnSync(
      context.binary,
      [...isolationArgs(scratch), "init", "--bare", "-q", `--object-format=${objectFormat.text}`],
      {
        cwd: scratch,
        env: gitEnv(context),
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
    if (init.error !== undefined) {
      if ("code" in init.error && init.error.code === "ETIMEDOUT")
        throw new Error("cannot inspect merge tree: runner git timed out after 10 seconds");
      throw new Error(`cannot inspect merge tree: ${init.error.message}`);
    }
    if ((init.status ?? -1) !== 0)
      throw new Error(`cannot inspect merge tree: ${(init.stderr ?? "").toString().trim() || "init failed"}`);
    const extraEnv = {
      GIT_DIR: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDir,
    };
    const inspect = (tree?: string) =>
      gitProcess(context, project, ["merge-tree", "--write-tree", left, right], 10_000, undefined, extraEnv, tree);
    const mergeBaseRun = inspect(attrTree.text);
    if (mergeBaseRun.code > 1) throw new Error(`cannot inspect merge tree: ${mergeBaseRun.stderr}`);
    if (mergeBaseRun.code !== 0) return false;
    const emptyRun = inspect();
    if (emptyRun.code > 1) throw new Error(`cannot inspect merge tree: ${emptyRun.stderr}`);
    return emptyRun.code === 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function gitBlobId(bytes: Uint8Array, blob: string): string {
  // In-process: git 2.43 hash-object --stdin-paths has no -z and follows symlinks.
  const algorithm = blob.length === 64 ? "sha256" : "sha1";
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function escapesWorktree(path: string, rel: string): boolean {
  return path === "" || isAbsolute(path) || rel === "" || !relativeInsideRoot(rel);
}

/**
 * Worktree bytes must equal the committed blob bytes. Autocrlf or eol=crlf that
 * rewrites the checkout is dirty. There is no conversion path. Nested gitlinks
 * are inspected the same way after their HEAD matches the gitlink blob.
 * Residues, documented with no behavior change: CRLF/eol/ident/LFS stay
 * fail-closed on raw bytes; ENOENT, sparse-checkout and skip-worktree stay
 * fail-closed (stricter than porcelain); ignored untracked files follow
 * ls-files --exclude-standard, matching main.
 */
export function cleanCommittedTree(context: RunnerGitContext, project: string): boolean {
  assertPinnedLayout(context);
  return treeIsClean(context, project, new Set());
}

function treeIsClean(context: RunnerGitContext, project: string, seen: Set<string>): boolean {
  let root: string;
  try {
    root = realpathSync(project);
  } catch {
    return false;
  }
  if (seen.has(root)) return true;
  seen.add(root);
  const untracked = runnerGit(context, project, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.code !== 0) throw new Error(`cannot inspect committed worktree: ${untracked.stderr}`);
  if (untracked.stdout.length > 0) return false;
  const cached = runnerGit(context, project, ["diff-index", "--cached", "--quiet", "HEAD", "--"]);
  if (cached.code > 1) throw new Error(`cannot inspect committed worktree: ${cached.stderr}`);
  if (cached.code !== 0) return false;
  const tracked = runnerGit(context, project, ["ls-files", "-s", "-z"]);
  if (tracked.code !== 0) throw new Error(`cannot inspect committed worktree: ${tracked.stderr}`);
  for (const row of new TextDecoder().decode(tracked.stdout).split("\0")) {
    if (row === "") continue;
    const tab = row.indexOf("\t");
    if (tab < 0) throw new Error("cannot inspect committed worktree: invalid index entry");
    const [mode, blob, stage] = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1);
    if (mode === undefined || blob === undefined || stage === undefined || path === "")
      throw new Error("cannot inspect committed worktree: invalid index entry");
    if (stage !== "0") return false;
    const at = resolve(project, path);
    const rel = relative(root, at);
    if (escapesWorktree(path, rel)) return false;
    try {
      const stat = lstatSync(at);
      if (mode === "160000") {
        if (!stat.isDirectory()) return false;
        const head = runnerGit(context, at, ["rev-parse", "--verify", "HEAD"]);
        if (head.code !== 0 || head.text !== blob) return false;
        if (!treeIsClean(context, at, seen)) return false;
        continue;
      }
      let bytes: Uint8Array;
      if (mode === "120000") {
        if (!stat.isSymbolicLink()) return false;
        bytes = Buffer.from(readlinkSync(at));
      } else if (mode === "100644" || mode === "100755") {
        // Any of owner/group/other, not the owner bit alone.
        const executable = (stat.mode & 0o111) !== 0;
        if (!stat.isFile() || executable !== (mode === "100755")) return false;
        bytes = readFileSync(at);
      } else return false;
      if (gitBlobId(bytes, blob) !== blob) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function resolvedRevision(context: RunnerGitContext, project: string, ref: string): string {
  const result = runnerGit(context, project, ["rev-parse", "--verify", ref]);
  if (result.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(result.text))
    throw new Error(`cannot resolve revision ${ref}: ${result.stderr || result.text}`);
  return result.text;
}

function rawFile(context: RunnerGitContext, project: string, path: string): string {
  try {
    const at = join(project, path);
    const stat = lstatSync(at);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(at)}`;
    if (stat.isFile())
      return `file:${stat.mode & 0o111}:${createHash("sha256").update(readFileSync(at)).digest("hex")}`;
    if (stat.isDirectory()) {
      if (!existsSync(join(at, ".git"))) return "dir";
      const tree = treeHash(context, at, []);
      if (!(tree instanceof Object))
        throw new Error(`runner snapshot cannot read embedded repository ${path}: ${tree}`);
      const head = runnerGit(context, at, ["rev-parse", "--verify", "-q", "HEAD"]);
      return `repo:${head.code === 0 ? head.text : "unborn"}:${tree.hash}`;
    }
    throw new Error(`runner snapshot refuses a non-file worktree entry: ${path}`);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "missing";
    throw cause;
  }
}

export function takeRunnerSnapshot(
  context: RunnerGitContext,
  project: string,
  ignoreUntrackedDirs: readonly string[] = [],
): Snapshot | string {
  const head = runnerGit(context, project, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head.text))
    return `${project} has no committed revision: ${head.stderr || head.text}`;
  const tree = treeHash(context, project, ignoreUntrackedDirs);
  if (!(tree instanceof Object)) return tree;
  const remote = runnerGit(context, project, ["config", "--get", "remote.origin.url"]);
  return {
    repo: remote.code === 0 && remote.text !== "" ? remote.text : project,
    revision: head.text,
    diff_hash: tree.hash,
  };
}

function treeHash(
  context: RunnerGitContext,
  project: string,
  ignoreUntrackedDirs: readonly string[],
): { hash: string } | string {
  const tracked = runnerGit(context, project, ["ls-files", "--stage", "-z"]);
  if (tracked.code !== 0) return `cannot list tracked files: ${tracked.stderr}`;
  const untracked = runnerGit(context, project, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.code !== 0) return `cannot list untracked files: ${untracked.stderr}`;

  const paths = new Map<string, string[]>();
  for (const row of new TextDecoder().decode(tracked.stdout).split("\0")) {
    if (row === "") continue;
    const tab = row.indexOf("\t");
    if (tab < 0) return "runner index contains an invalid tracked entry";
    const path = row.slice(tab + 1);
    const entries = paths.get(path) ?? [];
    entries.push(row.slice(0, tab));
    paths.set(path, entries);
  }
  for (const path of new TextDecoder().decode(untracked.stdout).split("\0")) {
    if (path === "" || ignoreUntrackedDirs.some((dir) => path === dir || path.startsWith(`${dir}/`))) continue;
    paths.set(path, ["untracked"]);
  }

  const digest = createHash("sha256");
  const root = realpathSync(project);
  for (const path of [...paths.keys()].toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const at = resolve(project, path);
    const rel = relative(root, at);
    if (escapesWorktree(path, rel)) return "runner index contains a path outside the worker root";
    digest.update(JSON.stringify([path, paths.get(path)?.toSorted(), rawFile(context, project, path)]));
    digest.update("\n");
  }
  return { hash: `sha256:${digest.digest("hex")}` };
}
