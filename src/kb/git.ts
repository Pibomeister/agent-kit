import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface GitRun {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Git as the knowledgebase adapter needs it: pathspecs taken literally, and no
 * `GIT_*` variable from the caller -- `GIT_DIR` or `GIT_WORK_TREE` set by a
 * hook would point a publish at the repository the run is working in, which is
 * the one place it must never land (adapters/knowledgebase/CONTRACT.md §3).
 */
export function git(root: string, args: readonly string[], input?: string): GitRun {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const run = spawnSync("git", ["--literal-pathspecs", "-C", root, ...args], {
    encoding: "utf8",
    env,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** The top of the work tree `dir` is in, by real path; null outside a repository. */
export function workTreeTop(dir: string): string | null {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  return top.status === 0 ? realpathSync(top.stdout.trim()) : null;
}

/** The directory every work tree of one repository shares, by real path; null outside a repository. */
export function commonDir(dir: string): string | null {
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common.status === 0 ? realpathSync(common.stdout.trim()) : null;
}
