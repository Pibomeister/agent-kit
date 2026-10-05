/**
 * Where learning state lives, and how a working directory maps to a project.
 *
 * Ledgers are written under `<configDir>/projects/<folder>/agent-kit/<loop>/`
 * and never inside a repository: no candidate directory, no `.git/info/exclude`
 * edit, nothing a `git status` in the project would show.
 */
import { statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type { LearnConfig } from "./config.ts";
import { run } from "./proc.ts";

export type Loop = "review" | "memory" | "skills";

/** Claude Code's convention: every non-alphanumeric except `-` becomes `-`. `/Users/bob/my_app` -> `-Users-bob-my-app`. */
export function projectFolderName(path: string): string {
  return resolve(path).replace(/[^A-Za-z0-9-]/g, "-");
}

/**
 * claude-reflect's own convention keeps underscores and dots: `/Users/bob/my_app` -> `-Users-bob-my_app`.
 * Both are needed because each tool reads its own directory under `projects/`.
 */
export function reflectFolderName(path: string): string {
  return `-${resolve(path).replace(/[\\/]/g, "-").replace(/^-+/, "")}`;
}

/**
 * The main worktree root, so every linked worktree shares one ledger. Spawns git,
 * so it is for foreground use only; a scheduled tick uses `rootOf` instead.
 */
export function mainRepoRoot(cwd: string): string | null {
  const result = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  const common = result.stdout.trim();
  if (common === "") return null;
  return common.endsWith("/.git") || common.endsWith("\\.git") ? dirname(common) : common;
}

/** The top of the worktree holding `cwd`, linked or main. Spawns git, so foreground only, like `mainRepoRoot`. */
export function worktreeRoot(cwd: string): string | null {
  const result = run(["git", "rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  const top = result.stdout.trim();
  return result.code !== 0 || top === "" ? null : resolve(top);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Main repo root found by walking up for a `.git` directory, with stat only.
 *
 * Never opens a file and never spawns git. Under a macOS scheduler, opening a
 * file inside a protected folder blocks uninterruptibly on the privacy prompt
 * and ignores every timeout, so the scheduled path may only stat. A linked
 * worktree (whose `.git` is a file) returns null; its main root registers from
 * its own foreground sessions instead.
 *
 * Stops where git stops: a directory listed in GIT_CEILING_DIRECTORIES is not
 * searched from below, so this walk and `mainRepoRoot` agree on what is outside.
 */
export function rootOf(cwd: string): string | null {
  const ceilings = new Set(
    (process.env.GIT_CEILING_DIRECTORIES ?? "")
      .split(delimiter)
      .filter((entry) => entry !== "")
      .map((entry) => resolve(entry)),
  );
  let dir = resolve(cwd);
  for (;;) {
    if (isDirectory(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir || ceilings.has(parent)) return null;
    dir = parent;
  }
}

/** `<configDir>/projects/<folder>/agent-kit`. */
export function projectLedgerRoot(config: LearnConfig, repoRoot: string): string {
  return join(config.configDir, "projects", projectFolderName(repoRoot), "agent-kit");
}

/** One git repository per loop, so each loop commits and reverts on its own history. */
export function loopDir(config: LearnConfig, repoRoot: string, loop: Loop): string {
  return join(projectLedgerRoot(config, repoRoot), loop);
}

/** The runtime-wide project registry: folder -> { root, mem_project, last_seen }. */
export function registryPath(config: LearnConfig): string {
  return join(config.runtimeDir, "projects.json");
}

/** Linked worktree path -> registered root, written by foreground sessions for the scheduled tick to read. */
export function worktreesPath(config: LearnConfig): string {
  return join(config.runtimeDir, "worktrees.json");
}

export function tickLogPath(config: LearnConfig): string {
  return join(config.runtimeDir, "tick.log");
}
