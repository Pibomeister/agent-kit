/** Isolated git `-c` flags: worker fsmonitor, hooks, filters and the commit graph cannot steer a snapshot. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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
 * directory is dirt; gitlink contents are never walked (ADV-006). Callers pass
 * `--ignore-submodules=none --submodule=short` on the snapshot diff so `diff.ignoreSubmodules=all`
 * cannot hide a gitlink bump, a -dirty submodule, or an untracked nested repo.
 */
export function unfilteredTrackedDirt(
  workTree: string,
  lsFilesStageZ: Uint8Array,
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
