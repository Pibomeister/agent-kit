/** Raw runner snapshots avoid worker-configured Git hooks, filters and text conversion. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import type { GitResult, Snapshot } from "../lifecycle/gate.ts";
import { workerControlledPath, workerFreePath } from "./path.ts";

export interface RunnerGitContext {
  binary: string;
  path: string;
  workerRoot: string;
  home: string;
}

export function resolveRunnerGit(workerRoot: string): RunnerGitContext {
  const path = workerFreePath(process.env["PATH"], workerRoot);
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory, "git");
    try {
      accessSync(candidate, constants.X_OK);
      const binary = realpathSync(candidate);
      if (!workerControlledPath(binary, workerRoot)) return { binary, path, workerRoot, home: "/dev/null" };
    } catch {
      // Try the next supervisor-owned PATH entry.
    }
  }
  throw new Error("runner cannot find a trusted git executable outside the worker root");
}

function failedGit(stderr: string): GitResult {
  return { code: -1, stdout: new Uint8Array(), text: "", stderr };
}

function gitProcess(
  context: RunnerGitContext,
  project: string,
  args: readonly string[],
  timeoutMs = 10_000,
): GitResult {
  const env: NodeJS.ProcessEnv = {
    PATH: context.path,
    HOME: context.home,
    XDG_CONFIG_HOME: context.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
  };
  const proc = spawnSync(
    context.binary,
    [
      "-c",
      `safe.directory=${realpathSync(project)}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.excludesFile=/dev/null",
      ...args,
    ],
    { cwd: project, env, maxBuffer: 1 << 30, timeout: timeoutMs, killSignal: "SIGKILL" },
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
  const entryPath = join(project, ".git");
  let paths: string[];
  try {
    const entry = lstatSync(entryPath);
    if (entry.isDirectory()) paths = [join(entryPath, "index"), join(entryPath, "HEAD")];
    else if (entry.isFile() && entry.size <= 4096) {
      const pointer = /^gitdir: (.+)$/.exec(readFileSync(entryPath, "utf8").trim())?.[1];
      if (pointer === undefined) return failedGit("runner git directory pointer is invalid");
      const gitDir = isAbsolute(pointer) ? pointer : resolve(project, pointer);
      paths = [join(gitDir, "index"), join(gitDir, "HEAD")];
    } else return failedGit("runner git directory entry is not regular");
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

export function runnerGit(context: RunnerGitContext, project: string, args: readonly string[]): GitResult {
  const controls = checkGitControls(context, project);
  if (controls !== null) return controls;
  return gitProcess(context, project, args);
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
    if (path === "" || isAbsolute(path) || rel === "" || rel.startsWith("..") || isAbsolute(rel))
      return "runner index contains a path outside the worker root";
    digest.update(JSON.stringify([path, paths.get(path)?.toSorted(), rawFile(context, project, path)]));
    digest.update("\n");
  }
  return { hash: `sha256:${digest.digest("hex")}` };
}
