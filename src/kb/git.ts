import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface GitRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** A git invocation. Runner.start passes its isolated git; other callers use `git`. */
export type GitFn = (root: string, args: readonly string[], input?: string) => GitRun;

function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    ...extra,
  };
}

function runGit(root: string, args: readonly string[], env: NodeJS.ProcessEnv, input?: string): GitRun {
  const run = spawnSync("git", ["--literal-pathspecs", "-C", root, ...args], {
    encoding: "utf8",
    env,
    input,
    maxBuffer: Infinity,
  });
  return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/**
 * Git as the knowledgebase adapter needs it: pathspecs taken literally, and no
 * `GIT_*` variable from the caller -- `GIT_DIR` or `GIT_WORK_TREE` set by a
 * hook would point a publish at the repository the run is working in, which is
 * the one place it must never land (adapters/knowledgebase/CONTRACT.md §3).
 */
export function git(root: string, args: readonly string[], input?: string): GitRun {
  return runGit(root, args, gitEnv(), input);
}

/** The caller's git; an explicit revision requires one. */
export function gitForRevision(revision: string | undefined, gitFn?: GitFn): GitFn {
  if (revision !== undefined && revision !== "") {
    if (gitFn === undefined) throw new Error("an explicit revision requires a git function");
    return gitFn;
  }
  return gitFn ?? git;
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
