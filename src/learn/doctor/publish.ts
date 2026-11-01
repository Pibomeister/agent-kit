/**
 * Turns one gated rewrite into a branch and a pull request, without touching a work tree.
 *
 * The commit is built with git plumbing from the base tree and one replaced blob, so no checkout,
 * stash or hook is involved, the skill file on disk stays as it was, and the commit can hold only
 * that one path. The only publish route is the repository's `no-mistakes` remote, whose pipeline
 * opens the pull request. The loop never merges.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV } from "../core/ledger.ts";
import { array, object, parseJson, text } from "./json.ts";
import { run, type RunResult } from "../core/proc.ts";

export const GATE_REMOTE = "no-mistakes";
const SOURCE_REMOTE = "origin";
const PUSH_TIMEOUT_MS = 600_000;

export interface PublishTarget {
  repo: string;
  /** Origin's default branch, which the commit is built on. */
  base: string;
  /** The commit of `base` this run read. */
  baseSha: string;
  /** Whether the branch is pushed through the gate. */
  publish: boolean;
}

function git(repo: string, env: NodeJS.ProcessEnv, args: readonly string[], input?: string): RunResult {
  return run(["git", "-C", repo, ...args], { env: { ...env, ...GIT_ENV }, input, timeoutMs: 120_000 });
}

/** The pull requests' target, read fresh from origin, or why there is none. */
export function resolveTarget(
  repo: string,
  env: NodeJS.ProcessEnv,
  publish: boolean,
): PublishTarget | { refused: string } {
  const remotes = git(repo, env, ["remote"]).stdout.split("\n");
  if (!remotes.includes(SOURCE_REMOTE)) return { refused: `${repo} has no ${SOURCE_REMOTE} remote` };
  if (publish && !remotes.includes(GATE_REMOTE))
    return { refused: `${repo} has no ${GATE_REMOTE} remote; run \`no-mistakes init\`` };
  const head = git(repo, env, ["symbolic-ref", "--short", `refs/remotes/${SOURCE_REMOTE}/HEAD`]).stdout.trim();
  const base = head.slice(`${SOURCE_REMOTE}/`.length);
  if (base === "")
    return {
      refused: `${SOURCE_REMOTE}'s default branch is unknown here; set it with \`git remote set-head ${SOURCE_REMOTE} --auto\``,
    };
  if (git(repo, env, ["fetch", "-q", SOURCE_REMOTE, base]).code !== 0)
    return { refused: `could not fetch ${base} from ${SOURCE_REMOTE}` };
  const baseSha = git(repo, env, ["rev-parse", "--verify", "-q", "FETCH_HEAD^{commit}"]).stdout.trim();
  return baseSha === ""
    ? { refused: `could not read ${base} from ${SOURCE_REMOTE}` }
    : { repo, base, baseSha, publish };
}

/** A regular tracked file at `sha`, with its mode; null when the path is absent or anything else. */
export function trackedFile(
  repo: string,
  env: NodeJS.ProcessEnv,
  sha: string,
  path: string,
): { mode: string; text: string } | null {
  const row = git(repo, env, ["ls-tree", sha, "--", path]).stdout.trim();
  const match = /^(100644|100755) blob /.exec(row);
  if (match === null || match[1] === undefined) return null;
  const shown = git(repo, env, ["cat-file", "blob", `${sha}:${path}`]);
  return shown.code === 0 ? { mode: match[1], text: shown.stdout.replaceAll("\r\n", "\n") } : null;
}

/** Whether `branch` is already on origin. Unreadable counts as present, so a failed read opens nothing. */
export function branchOnOrigin(repo: string, env: NodeJS.ProcessEnv, branch: string): boolean {
  const found = git(repo, env, ["ls-remote", "--heads", SOURCE_REMOTE, `refs/heads/${branch}`]);
  return found.code !== 0 || found.stdout.trim() !== "";
}

export interface RewriteCommit {
  path: string;
  mode: string;
  proposed: string;
  message: string;
}

/** A commit on `baseSha` that changes `change.path` alone; null when git refused a step. */
export function buildCommit(target: PublishTarget, env: NodeJS.ProcessEnv, change: RewriteCommit): string | null {
  const dir = mkdtempSync(join(tmpdir(), "ak-doctor-index-"));
  const indexed: NodeJS.ProcessEnv = { ...env, GIT_INDEX_FILE: join(dir, "index") };
  const step = (args: readonly string[], input?: string): string | null => {
    const result = git(target.repo, indexed, args, input);
    return result.code === 0 ? result.stdout.trim() : null;
  };
  try {
    if (step(["read-tree", target.baseSha]) === null) return null;
    const blob = step(["hash-object", "-w", "--stdin"], change.proposed);
    if (blob === null) return null;
    if (step(["update-index", "--add", "--cacheinfo", `${change.mode},${blob},${change.path}`]) === null) return null;
    const tree = step(["write-tree"]);
    if (tree === null) return null;
    const commit = step(["commit-tree", tree, "-p", target.baseSha, "-m", change.message]);
    if (commit === null) return null;
    const changed = step(["diff-tree", "--no-commit-id", "--name-only", "-r", target.baseSha, commit]);
    return changed === change.path ? commit : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `commit` pushed as `branch`, with no local branch made; the reason when the push is refused. */
export function pushBranch(
  target: PublishTarget,
  env: NodeJS.ProcessEnv,
  branch: string,
  commit: string,
): string | null {
  const pushed = run(["git", "-C", target.repo, "push", "-q", GATE_REMOTE, `${commit}:refs/heads/${branch}`], {
    env: { ...env, ...GIT_ENV },
    timeoutMs: PUSH_TIMEOUT_MS,
  });
  if (pushed.code === 0) return null;
  return pushed.timedOut ? "the push timed out" : `git push exited ${pushed.code}`;
}

export type PullRequestState = { url: string; state: "OPEN" | "MERGED" | "CLOSED" } | "none" | "unknown";

/** What the forge says of the branch's newest pull request. A failed read is `unknown`, never a decision. */
export function pullRequestState(repo: string, env: NodeJS.ProcessEnv, branch: string): PullRequestState {
  const listed = run(["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "url,state", "--limit", "1"], {
    cwd: repo,
    env,
  });
  if (listed.code !== 0) return "unknown";
  return parsePullRequestList(listed.stdout);
}

/** `gh pr list --json url,state` output read as a pull request state; anything unexpected is `unknown`. */
export function parsePullRequestList(stdout: string): PullRequestState {
  // JSON.parse, through the doctor's checked reader.
  const parsed = array(parseJson(stdout) ?? undefined);
  if (parsed === null) return "unknown";
  if (parsed.length === 0) return "none";
  const first = object(parsed[0]);
  const url = text(first?.url);
  const state = text(first?.state);
  if (url === null || url === "") return "unknown";
  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") return "unknown";
  return { url, state };
}
