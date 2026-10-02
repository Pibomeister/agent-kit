/** Raw runner snapshots avoid worker-configured Git hooks, filters and text conversion. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { GitResult, Snapshot } from "../lifecycle/gate.ts";
import { workerFreePath } from "./path.ts";

export function runnerGit(project: string, args: readonly string[]): GitResult {
  const env: NodeJS.ProcessEnv = {
    PATH: workerFreePath(process.env["PATH"], project),
    HOME: dirname(realpathSync(project)),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
  };
  const proc = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${realpathSync(project)}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: project, env, maxBuffer: 1 << 30 },
  );
  if (proc.error !== undefined)
    return { code: -1, stdout: new Uint8Array(), text: "", stderr: `cannot run isolated git: ${proc.error.message}` };
  const stdout = proc.stdout ?? new Uint8Array();
  return {
    code: proc.status ?? -1,
    stdout,
    text: new TextDecoder().decode(stdout).trim(),
    stderr: (proc.stderr ?? "").toString().trim(),
  };
}

function rawFile(project: string, path: string): string {
  try {
    const at = join(project, path);
    const stat = lstatSync(at);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(at)}`;
    if (stat.isFile())
      return `file:${stat.mode & 0o111}:${createHash("sha256").update(readFileSync(at)).digest("hex")}`;
    throw new Error(`runner snapshot refuses a non-file worktree entry: ${path}`);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "missing";
    throw cause;
  }
}

export function takeRunnerSnapshot(project: string, ignoreUntrackedDirs: readonly string[] = []): Snapshot | string {
  const head = runnerGit(project, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head.text))
    return `${project} has no committed revision: ${head.stderr || head.text}`;
  const tracked = runnerGit(project, ["ls-files", "--stage", "-z"]);
  if (tracked.code !== 0) return `cannot list tracked files: ${tracked.stderr}`;
  const untracked = runnerGit(project, ["ls-files", "--others", "--exclude-standard", "-z"]);
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
    digest.update(JSON.stringify([path, paths.get(path)?.toSorted(), rawFile(project, path)]));
    digest.update("\n");
  }
  const remote = runnerGit(project, ["config", "--get", "remote.origin.url"]);
  return {
    repo: remote.code === 0 && remote.text !== "" ? remote.text : project,
    revision: head.text,
    diff_hash: `sha256:${digest.digest("hex")}`,
  };
}
