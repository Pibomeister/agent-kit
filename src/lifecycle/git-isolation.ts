/** Isolated git `-c` flags: worker fsmonitor, hooks, filters and the commit graph cannot steer a snapshot. */
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { workerControlledPath } from "../runner/path.ts";

/** A git call used to walk a nested gitlink. Same shape as `GitResult` without importing the gate. */
export type NestedGit = (
  cwd: string,
  args: readonly string[],
) => { code: number; stdout: Uint8Array; text: string; stderr: string };

/** Fixed PATH used to spawn git. Never the caller's PATH. */
export const TRUSTED_GIT_PATH = `/usr/bin${delimiter}/bin`;

/**
 * Whitelist env for a trusted git spawn. No worker variables. A partial or
 * blobless clone may still promisor-fetch through repository config; no refusal.
 */
export function gitEnv(context: { path: string; home: string }) {
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

/**
 * Absolute git binary from `/usr/bin` then `/bin` whose real path is outside `workerRoot`.
 * Caller PATH is never searched.
 */
export function resolveTrustedGit(workerRoot: string) {
  const path = TRUSTED_GIT_PATH;
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory, "git");
    try {
      accessSync(candidate, constants.X_OK);
      const binary = realpathSync(candidate);
      if (!workerControlledPath(binary, workerRoot)) return { binary, path };
    } catch {
      // Try the next fixed location.
    }
  }
  throw new Error("runner cannot find a trusted git executable outside the worker root");
}

export function isolationArgs(project: string): string[] {
  const directory = existsSync(project) ? realpathSync(project) : resolve(project);
  return [
    "-c",
    `safe.directory=${directory}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.excludesFile=/dev/null",
    // Untracked listings use --exclude-per-directory=.gitignore, not --exclude-standard, so
    // .git/info/exclude cannot hide dirt. An untracked .gitignore is itself dirt.
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

/** Isolated git argv: worker-owned config is ignored, including the commit graph. Pathspecs are literal. */
export function isolatedGitArgv(project: string, args: readonly string[]): string[] {
  return ["--literal-pathspecs", ...isolationArgs(project), ...args];
}

/** In-process blob id. git 2.43 `hash-object --stdin-paths` has no `-z` and follows symlinks. */
export function gitBlobId(bytes: Uint8Array, blob: string): string {
  const algorithm = blob.length === 64 ? "sha256" : "sha1";
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * Hex digest of tracked worktree bytes that do not match the index blob, plus the first relative
 * path. Undefined when every regular file and symlink matches, including the executable bit
 * (`executable !== (mode === "100755")`, any of owner/group/other). A gitlink that is not a
 * directory is dirt. A gitlink directory is recursed with a clean env against nested HEAD bytes
 * so assume-unchanged and skip-worktree cannot hide nested dirt; ignored untracked files inside
 * a gitlink stay out of scope (ADV-006, matching git `-dirty` and the runner). Callers pass
 * `--ignore-submodules=none --submodule=short` on the snapshot diff so `diff.ignoreSubmodules=all`
 * cannot hide a gitlink bump, a -dirty submodule, or an untracked nested repo.
 */
export function unfilteredTrackedDirt(
  workTree: string,
  lsFilesStageZ: Uint8Array,
  nested?: { git: NestedGit; seen?: Set<string> },
): { digest: string; path: string } | undefined {
  const digest = createHash("sha256");
  let dirty = false;
  let first: string | undefined;
  const mark = (rel: string, extra?: Uint8Array) => {
    if (first === undefined && rel !== "" && !isAbsolute(rel) && !rel.split(/[/\\]/).includes("..")) first = rel;
    digest.update(rel);
    if (extra !== undefined) digest.update(extra);
    dirty = true;
  };
  for (const row of new TextDecoder().decode(lsFilesStageZ).split("\0")) {
    if (row === "") continue;
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const [mode, blob, stage] = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1);
    if (mode === undefined || blob === undefined || stage === undefined || path === "") continue;
    if (stage !== "0") continue;
    const at = join(workTree, path);
    try {
      const stat = lstatSync(at);
      if (mode === "160000") {
        if (!stat.isDirectory()) mark(path);
        else if (nested !== undefined) gitlinkDirt(at, path, blob, nested, mark);
        continue;
      }
      let bytes: Uint8Array;
      if (mode === "120000") {
        if (!stat.isSymbolicLink()) {
          mark(path);
          continue;
        }
        bytes = Buffer.from(readlinkSync(at));
      } else if (mode === "100644" || mode === "100755") {
        const executable = (stat.mode & 0o111) !== 0;
        if (!stat.isFile() || executable !== (mode === "100755")) {
          mark(path);
          continue;
        }
        bytes = readFileSync(at);
      } else continue;
      if (gitBlobId(bytes, blob) !== blob) mark(path, bytes);
    } catch {
      mark(path);
    }
  }
  return dirty ? { digest: digest.digest("hex"), path: first ?? "the working tree" } : undefined;
}

function gitlinkDirt(
  at: string,
  path: string,
  blob: string,
  nested: { git: NestedGit; seen?: Set<string> },
  mark: (rel: string, extra?: Uint8Array) => void,
): void {
  let root: string;
  try {
    root = realpathSync(at);
  } catch {
    mark(path);
    return;
  }
  const seen = nested.seen ?? new Set<string>();
  if (seen.has(root)) return;
  seen.add(root);
  const head = nested.git(at, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0 || head.text !== blob) {
    mark(path);
    return;
  }
  const untracked = nested.git(at, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.code !== 0) {
    mark(path);
    return;
  }
  for (const entry of new TextDecoder().decode(untracked.stdout).split("\0")) {
    if (entry === "") continue;
    mark(`${path}/${entry}`);
    return;
  }
  const tree = nested.git(at, ["ls-tree", "-r", "-z", "HEAD"]);
  if (tree.code !== 0) {
    mark(path);
    return;
  }
  const inner = unfilteredTrackedDirt(at, lsTreeToStageZ(tree.stdout), { git: nested.git, seen });
  if (inner !== undefined) mark(inner.path === "the working tree" ? path : `${path}/${inner.path}`);
}

/** `ls-tree -r -z` rows as `ls-files -s -z`, so `unfilteredTrackedDirt` can compare worktree bytes to HEAD. */
export function lsTreeToStageZ(lsTreeZ: Uint8Array): Uint8Array {
  const rows: string[] = [];
  for (const row of new TextDecoder().decode(lsTreeZ).split("\0")) {
    if (row === "") continue;
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const meta = row.slice(0, tab).split(" ");
    const mode = meta[0];
    const blob = meta[2];
    const path = row.slice(tab + 1);
    if (mode === undefined || blob === undefined || path === "") continue;
    rows.push(`${mode} ${blob} 0\t${path}`);
  }
  return new TextEncoder().encode(rows.map((row) => `${row}\0`).join(""));
}
